import type { Pool } from "pg";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { WhatsAppSendRejectedError } from "../src/modules/whatsapp/errors.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp session presence", () => {
  it("uses one best-effort provider call per message and throttles repeated warnings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("provider unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn().mockResolvedValue({ rows: [{ instance_name: "tenant-instance" }] });
    const warn = vi.fn();
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await manager.setPresence("session-1", "available");
    await manager.setPresence("session-1", "available");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("WhatsApp outbound connection recovery", () => {
  it("blocks every outbound payload for a quarantined legacy phone before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new WhatsAppSessionManager(
      { query: vi.fn() } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.sendText("session-1", "999000000001@s.whatsapp.net", "Olá"))
      .rejects.toThrow(/quarantined legacy phone/i);
    await expect(manager.sendMedia("session-1", "+999000000001", {
      mediaType: "image", dataBase64: "aGVsbG8=", mimeType: "image/png", fileName: "quarantine.png"
    })).rejects.toThrow(/quarantined legacy phone/i);
    await expect(manager.sendSticker("session-1", "999000000001", { dataBase64: "aGVsbG8=" }))
      .rejects.toThrow(/quarantined legacy phone/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restarts an instance and retries text once after Connection Closed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 400,
        error: "Bad Request",
        response: { message: ["Error: Connection Closed"] }
      }), { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(Response.json({ instance: { status: "open" } }))
      .mockResolvedValueOnce(Response.json({ key: { id: "recovered-message-id" } }));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn().mockResolvedValue({ rows: [{ instance_name: "tenant-instance" }] });
    const warn = vi.fn();
    const info = vi.fn();
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn, info, debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.sendText("session-1", "5511999999999", "Olá"))
      .resolves.toEqual({ externalId: "recovered-message-id" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/message/sendText/tenant-instance"),
      expect.stringContaining("/instance/restart/tenant-instance"),
      expect.stringContaining("/message/sendText/tenant-instance")
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", instanceName: "tenant-instance", operation: "text" }),
      expect.stringContaining("restarting instance")
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", instanceName: "tenant-instance", operation: "text" }),
      expect.stringContaining("instance restarted")
    );
  });

  it("keeps a provider-rejected send recoverable when restarting the connection fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 400,
        error: "Bad Request",
        response: { message: ["Error: Connection Closed"] }
      }), { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("restart unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn().mockResolvedValue({ rows: [{ instance_name: "tenant-instance" }] });
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.sendText("session-1", "5511999999999", "Olá"))
      .rejects.toBeInstanceOf(WhatsAppSendRejectedError);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/message/sendText/tenant-instance"),
      expect.stringContaining("/instance/restart/tenant-instance")
    ]);
  });

  it("does not restart an instance for unrelated provider errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 400,
      error: "Bad Request",
      response: { message: ["The destination is temporarily unavailable"] }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn().mockResolvedValue({ rows: [{ instance_name: "tenant-instance" }] });
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.sendText("session-1", "5511999999999", "Olá"))
      .rejects.toThrow("destination is temporarily unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("WhatsApp connection state reconciliation", () => {
  // Regressão de produção: um CONNECTION_UPDATE perdido/fora de ordem deixava a
  // sessão em qr_pending no banco enquanto a Evolution reportava "open". Nesse
  // estado channelCapabilities devolve can_send=false e o painel bloqueia o
  // atendente com "A conexão do WhatsApp está desconectada" num número ativo.
  it("promotes a stale session to connected when Evolution reports the instance open", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([
      { name: "instance-live", connectionStatus: "open" },
      { name: "instance-dead", connectionStatus: "close" }
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: "session-live", tenant_id: "tenant-a", status: "qr_pending", instance_name: "instance-live" },
        { id: "session-dead", tenant_id: "tenant-a", status: "disconnected", instance_name: "instance-dead" }
      ] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const warn = vi.fn();
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.reconcileConnectionStates()).resolves.toEqual({ checked: 2, repaired: 1 });

    const updates = query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE whatsapp_sessions SET status"));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(["session-live", "connected", null, null, null]);
  });

  it("never downgrades a session from the provider snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([{ name: "instance-a", connectionStatus: "close" }]));
    vi.stubGlobal("fetch", fetchMock);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-a", tenant_id: "tenant-a", status: "qr_pending", instance_name: "instance-a" }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );

    await expect(manager.reconcileConnectionStates()).resolves.toEqual({ checked: 1, repaired: 0 });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE whatsapp_sessions SET status"))).toHaveLength(0);
  });
});

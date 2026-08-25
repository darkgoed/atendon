import type { Pool } from "pg";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
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

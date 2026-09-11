import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SessionRepository } from "../src/modules/whatsapp/session-repository.js";

describe("SessionRepository.listRunnable", () => {
  it("only asks PostgreSQL for sessions that should reconnect automatically", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await repository.listRunnable();

    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("s.status IN ('connected', 'qr_pending')");
    expect(sql).toContain("s.channel = 'whatsapp'");
    expect(sql).toContain("s.archived_at IS NULL");
    expect(sql).not.toContain("s.status <> 'banned'");
  });
});

describe("SessionRepository.primaryId", () => {
  it("prefere a conexão primária ativa e usa a mais nova como fallback", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "session-primary" }] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await expect(repository.primaryId("tenant-a")).resolves.toBe("session-primary");

    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("tenant_id=$1");
    expect(sql).toContain("channel = 'whatsapp'");
    expect(sql).toContain("archived_at IS NULL");
    expect(sql).toContain("ORDER BY is_primary DESC, created_at DESC");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
  });

  it("retorna null quando o tenant não tem conexão ativa", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await expect(repository.primaryId("tenant-empty")).resolves.toBeNull();
  });
});

describe("SessionRepository.listByTenant", () => {
  it("lista somente conexões ativas com campos de gerenciamento", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "session-a",
      tenant_id: "tenant-a",
      status: "connected",
      instance_name: "atendon_session_a",
      label: "Comercial",
      phone_number: "5511999999999",
      is_primary: true,
      qr_code: null,
      last_connected_at: "2026-09-09T10:00:00.000Z",
      disconnected_reason: null,
      created_at: "2026-09-01T10:00:00.000Z"
    }] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await expect(repository.listByTenant("tenant-a")).resolves.toEqual([{
      id: "session-a",
      tenantId: "tenant-a",
      status: "connected",
      instanceName: "atendon_session_a",
      label: "Comercial",
      phoneNumber: "5511999999999",
      isPrimary: true,
      qrCode: null,
      lastConnectedAt: "2026-09-09T10:00:00.000Z",
      disconnectedReason: null,
      createdAt: "2026-09-01T10:00:00.000Z"
    }]);

    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("WHERE tenant_id=$1 AND archived_at IS NULL");
    expect(sql).toContain("ORDER BY is_primary DESC, created_at");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
  });
});

describe("SessionRepository.findByInstance", () => {
  it("informa quando a instância encontrada está arquivada", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "session-archived",
      tenant_id: "tenant-a",
      archived_at: "2026-09-09T12:00:00.000Z"
    }] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await expect(repository.findByInstance("atendon_archived")).resolves.toEqual({
      id: "session-archived",
      tenantId: "tenant-a",
      archivedAt: "2026-09-09T12:00:00.000Z"
    });

    expect(String(query.mock.calls[0][0])).toContain("archived_at");
  });
});

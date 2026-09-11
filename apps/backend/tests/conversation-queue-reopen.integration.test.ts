import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp(); const suffix = randomUUID();
const phoneDigits = suffix.replace(/\D/g, "").padEnd(8, "7").slice(0, 8);
let tenantId = ""; let sessionId = ""; let userId = ""; let conversationId = ""; let leadId = ""; let ownerCookie = "";
let noInitialTenantId = ""; let noInitialSessionId = "";
const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows;
const first = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows[0] as T;

beforeAll(async () => {
  await app.ready(); const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Reopen ${suffix}`])).rows[0].id;
    noInitialTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Reopen without initial ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    sessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
    noInitialSessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [noInitialTenantId])).rows[0].id;
    userId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`reopen-${suffix}@test.local`])).rows[0].id;
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
      SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [tenantId, userId]);
    leadId = (await client.query<{ id: string }>("INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Reopen lead','test') RETURNING id", [tenantId, `5511${phoneDigits}`])).rows[0].id;
    conversationId = (await client.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,status) VALUES($1,$2,$3,'Reopen contact',$4,'open') RETURNING id",
      [tenantId, sessionId, `5511${phoneDigits}`, leadId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  ownerCookie = `atendon_session=${await createSessionToken({ userId, tenantId, email: `reopen-${suffix}@test.local`, role: "OWNER" })}`;
});

afterAll(async () => {
  if (userId) await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
  if (tenantId || noInitialTenantId) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, noInitialTenantId].filter(Boolean)]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await app.close(); await pool.end();
});

describe("reopen semantics through repository and legacy endpoints", () => {
  it("new inbound message on a resolved queue returns to initial and opens", async () => {
    const queues = await q("SELECT id,is_initial,is_resolved FROM conversation_queues WHERE tenant_id=$1 AND archived_at IS NULL", [tenantId]);
    const initial = queues.find((row: { is_initial: boolean }) => row.is_initial)!;
    const resolved = queues.find((row: { is_resolved: boolean }) => row.is_resolved)!;
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerCookie }, payload: { queue_id: resolved.id } })).statusCode).toBe(200);
    expect(await first("SELECT queue_id,status,resolved_at FROM conversations WHERE id=$1", [conversationId]))
      .toMatchObject({ queue_id: resolved.id, status: "closed" });
    expect((await first<{ resolved_at: Date | null }>("SELECT resolved_at FROM conversations WHERE id=$1", [conversationId])).resolved_at).not.toBeNull();
    const enqueuer = vi.fn().mockResolvedValue(undefined);
    const repository = new MessageRepository(pool, config, { followUp: enqueuer });
    const message = { tenantId, sessionId, contactPhone: `5511${phoneDigits}`, contactName: "Reopen contact", text: "voltei", externalId: `inbound-${suffix}` };
    await repository.recordInboundAndLoadContext(message, { claim: false });
    const state = await first<{ queue_id: string; status: string; resolved_at: Date | null }>("SELECT queue_id,status,resolved_at FROM conversations WHERE id=$1", [conversationId]);
    expect(state).toMatchObject({ queue_id: initial.id, status: "open", resolved_at: null });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM messages WHERE conversation_id=$1", [conversationId])).toEqual({ count: "1" });
  });

  it("new inbound on an already open custom queue preserves the queue and duplicate provider key has no effects", async () => {
    const custom = (await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerCookie }, payload: { name: `Open custom ${suffix}` } })).json().queue;
    await pool.query("UPDATE conversations SET queue_id=$1,status='open',resolved_at=NULL WHERE id=$2", [custom.id, conversationId]);
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const message = { tenantId, sessionId, contactPhone: `5511${phoneDigits}`, text: "mais uma", externalId: `open-${suffix}` };
    await repository.recordInboundAndLoadContext(message, { claim: false });
    await repository.recordInboundAndLoadContext(message, { claim: false });
    expect(await first("SELECT queue_id,status FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ queue_id: custom.id, status: "open" });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM messages WHERE conversation_id=$1", [conversationId])).toEqual({ count: "2" });
  });

  it("a conversation born from inbound data receives the initial queue", async () => {
    const phone = `5513${phoneDigits}`;
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    await repository.recordInboundAndLoadContext({ tenantId, sessionId, contactPhone: phone, text: "novo", externalId: `born-${suffix}` }, { claim: false });
    const row = await first<{ queue_id: string; status: string }>("SELECT c.queue_id,c.status FROM conversations c WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, phone]);
    expect(row.status).toBe("open"); expect((await first<{ is_initial: boolean }>("SELECT is_initial FROM conversation_queues WHERE id=$1", [row.queue_id])).is_initial).toBe(true);
  });

  it("allows inbound to create a conversation with NULL queue_id when the tenant has no initial queue", async () => {
    await pool.query("DELETE FROM conversation_queues WHERE tenant_id=$1", [noInitialTenantId]);
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM conversation_queues WHERE tenant_id=$1 AND is_initial AND archived_at IS NULL", [noInitialTenantId])).toEqual({ count: "0" });

    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const phone = `5514${phoneDigits}`;
    await expect(repository.recordInboundAndLoadContext({ tenantId: noInitialTenantId, sessionId: noInitialSessionId, contactPhone: phone, text: "sem fila", externalId: `no-initial-${suffix}` }, { claim: false })).resolves.toBeTruthy();
    expect(await first<{ queue_id: string | null; status: string }>("SELECT queue_id,status FROM conversations WHERE tenant_id=$1 AND contact_phone=$2", [noInitialTenantId, phone]))
      .toEqual({ queue_id: null, status: "open" });
  });

  it("legacy resolve and reopen keep queue and status coherent in one action each", async () => {
    const resolved = await first<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_resolved", [tenantId]);
    const initial = await first<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial", [tenantId]);
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerCookie }, payload: { queue_id: resolved.id } })).statusCode).toBe(200);
    expect(await first("SELECT queue_id,status FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ queue_id: resolved.id, status: "closed" });
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/reopen`, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
    expect(await first("SELECT queue_id,status,resolved_at FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ queue_id: initial.id, status: "open", resolved_at: null });
  });
});

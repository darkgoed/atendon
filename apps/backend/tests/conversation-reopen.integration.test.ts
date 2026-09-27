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
const first = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows[0] as T;

beforeAll(async () => {
  await app.ready(); const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Reopen ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    sessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
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
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await app.close(); await pool.end();
});

describe("reopen semantics through repository and endpoints", () => {
  it("new inbound message on a resolved conversation reopens it and clears resolved_at", async () => {
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/resolve`, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
    expect(await first("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId]))
      .toMatchObject({ status: "closed" });
    expect((await first<{ resolved_at: Date | null }>("SELECT resolved_at FROM conversations WHERE id=$1", [conversationId])).resolved_at).not.toBeNull();
    const enqueuer = vi.fn().mockResolvedValue(undefined);
    const repository = new MessageRepository(pool, config, { followUp: enqueuer });
    const message = { tenantId, sessionId, contactPhone: `5511${phoneDigits}`, contactName: "Reopen contact", text: "voltei", externalId: `inbound-${suffix}` };
    await repository.recordInboundAndLoadContext(message, { claim: false });
    const state = await first<{ status: string; resolved_at: Date | null }>("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId]);
    expect(state).toMatchObject({ status: "open", resolved_at: null });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM messages WHERE conversation_id=$1", [conversationId])).toEqual({ count: "1" });
  });

  it("new inbound on an already open conversation keeps it open and duplicate provider key has no effects", async () => {
    await pool.query("UPDATE conversations SET status='open',resolved_at=NULL WHERE id=$1", [conversationId]);
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const message = { tenantId, sessionId, contactPhone: `5511${phoneDigits}`, text: "mais uma", externalId: `open-${suffix}` };
    await repository.recordInboundAndLoadContext(message, { claim: false });
    await repository.recordInboundAndLoadContext(message, { claim: false });
    expect(await first("SELECT status FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ status: "open" });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM messages WHERE conversation_id=$1 AND content='mais uma'", [conversationId])).toEqual({ count: "1" });
  });

  it("a conversation born from inbound data starts open with resolved_at null", async () => {
    const phone = `5513${phoneDigits}`;
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    await repository.recordInboundAndLoadContext({ tenantId, sessionId, contactPhone: phone, text: "novo", externalId: `born-${suffix}` }, { claim: false });
    const row = await first<{ status: string; resolved_at: Date | null }>("SELECT status,resolved_at FROM conversations WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, phone]);
    expect(row).toMatchObject({ status: "open", resolved_at: null });
  });

  it("resolve and reopen keep status coherent in one action each", async () => {
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/resolve`, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
    expect(await first("SELECT status FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ status: "closed" });
    expect((await first<{ resolved_at: Date | null }>("SELECT resolved_at FROM conversations WHERE id=$1", [conversationId])).resolved_at).not.toBeNull();
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/reopen`, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
    expect(await first("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ status: "open", resolved_at: null });
  });
});

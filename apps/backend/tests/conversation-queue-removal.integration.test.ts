import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const phoneDigits = suffix.replace(/\D/g, "").padEnd(8, "7").slice(0, 8);
let tenantId = "";
let sessionId = "";
let userId = "";
let ownerId = "";
let conversationId = "";
let leadId = "";
const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows;
const first = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows[0] as T;

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Queue removal ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId]
    )).rows[0].id;
    userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`queue-removal-${suffix}@test.local`]
    )).rows[0].id;
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
      SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [tenantId, userId]);
    leadId = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Queue removal lead','test') RETURNING id",
      [tenantId, `5511${phoneDigits}`]
    )).rows[0].id;
    conversationId = (await client.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,status) VALUES($1,$2,$3,'Queue removal contact',$4,'open') RETURNING id",
      [tenantId, sessionId, `5511${phoneDigits}`, leadId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  ownerId = `atendon_session=${await createSessionToken({ userId, tenantId, email: `queue-removal-${suffix}@test.local`, role: "OWNER" })}`;
});

afterAll(async () => {
  if (userId) await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await app.close(); await pool.end();
});

describe("conversation queues were removed from database and API", () => {
  it("leaves no queue schema objects behind", async () => {
    const state = await first<Record<string, number | null>>(
      `SELECT
        to_regclass('public.conversation_queues')::text queue_table,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname='tenants_seed_conversation_queues' AND NOT tgisinternal) seed_trigger,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname='conversations_sync_queue_status' AND NOT tgisinternal) sync_trigger,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('seed_conversation_queues_for_tenant','sync_conversation_queue_status')) functions,
        (SELECT count(*)::int FROM pg_constraint WHERE conname='conversations_queue_tenant_fkey') foreign_key,
        (SELECT count(*)::int FROM pg_indexes WHERE indexname='idx_conversations_queue') index_,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='conversations' AND column_name='queue_id') queue_column`
    );
    expect(state).toEqual({ queue_table: null, seed_trigger: 0, sync_trigger: 0, functions: 0, foreign_key: 0, index_: 0, queue_column: 0 });
  });

  it("leaves no queue permission grants behind", async () => {
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM permissions WHERE key='conversations.queues.manage'"))
      .toEqual({ count: "0" });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM workspace_role_permissions WHERE permission_key='conversations.queues.manage'"))
      .toEqual({ count: "0" });
  });

  it("returns 404 for the legacy queue endpoints", async () => {
    expect((await app.inject({ url: "/conversation-queues", headers: { cookie: ownerId } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerId }, payload: { name: `X ${suffix}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerId }, payload: { queue_id: randomUUID() } })).statusCode).toBe(404);
  });

  it("does not filter or expose queue fields on GET /conversations", async () => {
    const response = await app.inject({ url: `/conversations?q=Queue removal contact&queue_id=${randomUUID()}`, headers: { cookie: ownerId } });
    expect(response.statusCode).toBe(200);
    const conversations = response.json().conversations as Array<Record<string, unknown>>;
    expect(conversations.map((c) => c.id)).toEqual([conversationId]);
    expect(Object.keys(conversations[0]).filter((key) => key.includes("queue"))).toEqual([]);
  });

  it("keeps the open/closed lifecycle independent of queues", async () => {
    const repository = new MessageRepository(pool, config, { followUp: (async () => "enqueued") });
    const born = await repository.recordInboundAndLoadContext(
      { tenantId, sessionId, contactPhone: `5512${phoneDigits}`, contactName: "Removal born", text: "oi", externalId: `born-${suffix}` },
      { claim: false }
    );
    expect(born).toBeTruthy();
    const bornRow = await first<{ status: string; resolved_at: Date | null }>(
      "SELECT status,resolved_at FROM conversations WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, `5512${phoneDigits}`]
    );
    expect(bornRow).toMatchObject({ status: "open", resolved_at: null });

    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/resolve`, headers: { cookie: ownerId } })).statusCode).toBe(200);
    expect(await first("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId]))
      .toMatchObject({ status: "closed" });
    expect((await first<{ resolved_at: Date | null }>("SELECT resolved_at FROM conversations WHERE id=$1", [conversationId])).resolved_at).not.toBeNull();

    const duplicate = await repository.recordInboundAndLoadContext(
      { tenantId, sessionId, contactPhone: `5511${phoneDigits}`, text: "voltei", externalId: `voltei-${suffix}` },
      { claim: false }
    );
    expect(duplicate).toBeTruthy();
    expect(await first("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId]))
      .toMatchObject({ status: "open", resolved_at: null });
    expect(await first<{ count: string }>("SELECT count(*)::text count FROM messages WHERE conversation_id=$1", [conversationId]))
      .toEqual({ count: "1" });

    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/reopen`, headers: { cookie: ownerId } })).statusCode).toBe(200);
    expect(await first("SELECT status,resolved_at FROM conversations WHERE id=$1", [conversationId]))
      .toMatchObject({ status: "open", resolved_at: null });
  });
});

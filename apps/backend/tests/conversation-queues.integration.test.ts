import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const phoneDigits = suffix.replace(/\D/g, "").padEnd(8, "7").slice(0, 8);
let tenantId = ""; let foreignTenantId = ""; let sessionId = ""; let foreignSessionId = "";
let ownerId = ""; let operatorId = ""; let foreignOwnerId = ""; let conversationId = ""; let otherConversationId = "";
let ownerCookie = ""; let operatorCookie = ""; let foreignCookie = "";
const cookie = async (userId: string, tenantId: string, email: string, role: string) =>
  `atendon_session=${await createSessionToken({ userId, tenantId, email, role })}`;

async function one<T = Record<string, unknown>>(sql: string, values: unknown[] = []) { return (await pool.query(sql, values)).rows[0] as T; }
async function lead(tenant: string, phone: string) {
  return (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,$3,'test') RETURNING id",
    [tenant, phone, `Lead ${phone}`]
  )).rows[0].id;
}
async function conversation(tenant: string, session: string, phone: string, assigned?: string) {
  const id = await lead(tenant, phone);
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,assigned_user_id)
     VALUES($1,$2,$3,$3,$4,$5) RETURNING id`, [tenant, session, phone, id, assigned ?? null]
  )).rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Queue ${suffix}`])).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Foreign queue ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId); await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    sessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
    foreignSessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [foreignTenantId])).rows[0].id;
    ownerId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`queue-owner-${suffix}@test.local`])).rows[0].id;
    operatorId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`queue-operator-${suffix}@test.local`])).rows[0].id;
    foreignOwnerId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`queue-foreign-${suffix}@test.local`])).rows[0].id;
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
      SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [tenantId, ownerId]);
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
      SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`, [tenantId, operatorId]);
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
      SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [foreignTenantId, foreignOwnerId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  ownerCookie = await cookie(ownerId, tenantId, `queue-owner-${suffix}@test.local`, "OWNER");
  operatorCookie = await cookie(operatorId, tenantId, `queue-operator-${suffix}@test.local`, "OPERADOR");
  foreignCookie = await cookie(foreignOwnerId, foreignTenantId, `queue-foreign-${suffix}@test.local`, "OWNER");
  conversationId = await conversation(tenantId, sessionId, `5511${phoneDigits}`);
  otherConversationId = await conversation(tenantId, sessionId, `5512${phoneDigits}`, operatorId);
});

afterAll(async () => {
  const users = [ownerId, operatorId, foreignOwnerId].filter(Boolean);
  const tenants = [tenantId, foreignTenantId].filter(Boolean);
  if (users.length) await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [users]);
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (users.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await app.close(); await pool.end();
});

describe("conversation queues over real PostgreSQL and app", () => {
  it("seeds exactly initial, scheduled and resolved queues per tenant", async () => {
    const response = await app.inject({ url: "/conversation-queues", headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().queues).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Novo contato", is_initial: true, is_resolved: false }),
      expect.objectContaining({ name: "Agendado", is_initial: false, is_resolved: false }),
      expect.objectContaining({ name: "Resolvido", is_initial: false, is_resolved: true })
    ]));
    expect((await app.inject({ url: "/conversation-queues", headers: { cookie: foreignCookie } })).json().queues)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining(suffix) })]));
  });

  it("does CRUD with color validation, tenant-scoped duplicate names and manager permission", async () => {
    const created = await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerCookie }, payload: { name: `Custom ${suffix}`, color: "#123456" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().queue.id;
    expect(created.json().queue).toMatchObject({ name: `Custom ${suffix}`, color: "#123456", is_initial: false, is_resolved: false });
    expect((await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerCookie }, payload: { name: ` custom ${suffix} ` } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: operatorCookie }, payload: { name: "Operador não pode" } })).statusCode).toBe(403);
    const updated = await app.inject({ method: "PATCH", url: `/conversation-queues/${id}`, headers: { cookie: ownerCookie }, payload: { name: `Renomeada ${suffix}`, color: "#ABCDEF" } });
    expect(updated.statusCode).toBe(200); expect(updated.json().queue).toMatchObject({ id, name: `Renomeada ${suffix}`, color: "#ABCDEF" });
    expect((await app.inject({ method: "PATCH", url: `/conversation-queues/${id}`, headers: { cookie: foreignCookie }, payload: { name: "Invasão" } })).statusCode).toBe(404);
  });

  it("requires the exact active set for reorder and leaves deterministic positions under concurrent admins", async () => {
    const before = (await app.inject({ url: "/conversation-queues", headers: { cookie: ownerCookie } })).json().queues as Array<{ id: string }>;
    const incomplete = await app.inject({ method: "POST", url: "/conversation-queues/reorder", headers: { cookie: ownerCookie }, payload: { ids: before.slice(0, -1).map((q) => q.id) } });
    expect(incomplete.statusCode).toBe(400);
    const ids = before.map((q) => q.id).reverse();
    const responses = await Promise.all([ids, [...ids].reverse()].map((ordered) => app.inject({ method: "POST", url: "/conversation-queues/reorder", headers: { cookie: ownerCookie }, payload: { ids: ordered } })));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200]);
    const rows = await pool.query<{ id: string; position: number }>("SELECT id,position FROM conversation_queues WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY position,id", [tenantId]);
    expect(rows.rows.map((r) => r.id).sort()).toEqual(before.map((q) => q.id).sort());
    expect(new Set(rows.rows.map((r) => r.position)).size).toBe(rows.rows.length);
  });

  it("cannot archive initial/resolved, and moving to resolved atomically closes while another queue reopens", async () => {
    const queues = (await app.inject({ url: "/conversation-queues", headers: { cookie: ownerCookie } })).json().queues as Array<{ id: string; is_initial: boolean; is_resolved: boolean }>;
    const initial = queues.find((q) => q.is_initial)!; const resolved = queues.find((q) => q.is_resolved)!; const normal = queues.find((q) => !q.is_initial && !q.is_resolved)!;
    expect((await app.inject({ method: "DELETE", url: `/conversation-queues/${initial.id}`, headers: { cookie: ownerCookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/conversation-queues/${resolved.id}`, headers: { cookie: ownerCookie } })).statusCode).toBe(409);
    const closed = await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerCookie }, payload: { queue_id: resolved.id } });
    expect(closed.statusCode).toBe(200); expect(closed.json()).toMatchObject({ ok: true, queue_id: resolved.id, status: "closed" });
    expect(await one("SELECT queue_id,status,resolved_at FROM conversations WHERE id=$1", [conversationId])).toMatchObject({ queue_id: resolved.id, status: "closed" });
    const open = await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerCookie }, payload: { queue_id: normal.id } });
    expect(open.statusCode).toBe(200); expect(open.json()).toMatchObject({ queue_id: normal.id, status: "open" });
  });

  it("archives a normal queue and atomically realocates conversations to initial", async () => {
    const made = await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerCookie }, payload: { name: `Archive ${suffix}` } });
    const id = made.json().queue.id as string;
    await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: ownerCookie }, payload: { queue_id: id } });
    expect((await app.inject({ method: "DELETE", url: `/conversation-queues/${id}`, headers: { cookie: ownerCookie } })).statusCode).toBe(204);
    expect(await one("SELECT q.is_initial, c.queue_id FROM conversations c JOIN conversation_queues q ON q.id=c.queue_id WHERE c.id=$1", [conversationId])).toMatchObject({ is_initial: true });
  });

  it("enforces own versus another conversation and foreign tenant without side effects", async () => {
    const before = await one<{ queue_id: string | null; status: string }>("SELECT queue_id,status FROM conversations WHERE id=$1", [conversationId]);
    const payload = { queue_id: (await one<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial", [tenantId]))!.id };
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: operatorCookie }, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/conversations/${conversationId}/queue`, headers: { cookie: foreignCookie }, payload })).statusCode).toBe(404);
    expect(await one("SELECT queue_id,status FROM conversations WHERE id=$1", [conversationId])).toEqual(before);
    expect((await app.inject({ method: "PATCH", url: `/conversations/${otherConversationId}/queue`, headers: { cookie: operatorCookie }, payload })).statusCode).toBe(200);
    expect(await one<{ count: string }>("SELECT count(*)::text count FROM conversations WHERE tenant_id=$1 AND session_id=$2", [tenantId, foreignSessionId])).toEqual({ count: "0" });
  });

  it("limits mine listing and unread counts to the attendant scope", async () => {
    await pool.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','own unread'),($2,'contact','other unread')", [otherConversationId, conversationId]);
    const list = await app.inject({ url: "/conversations?filter=mine", headers: { cookie: operatorCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations.map((row: { id: string }) => row.id)).toEqual([otherConversationId]);
    const counts = await app.inject({ url: "/conversations/unread-counts", headers: { cookie: operatorCookie } });
    expect(counts.statusCode).toBe(200);
    expect(counts.json()).toMatchObject({ mine: 1 });
    expect(counts.json()).not.toHaveProperty("human");
    const queues = await app.inject({ url: "/conversation-queues", headers: { cookie: operatorCookie } });
    expect(queues.statusCode).toBe(200);
    const initial = (queues.json().queues as Array<{ is_initial: boolean; conversation_count: number }>)
      .find((queue) => queue.is_initial);
    expect(initial?.conversation_count).toBe(1);
  });

  it("includes archived queues only when requested and counts open conversations in scope", async () => {
    const archived = await app.inject({ method: "POST", url: "/conversation-queues", headers: { cookie: ownerCookie }, payload: { name: `Archived count ${suffix}` } });
    expect(archived.statusCode).toBe(201);
    const archivedId = archived.json().queue.id as string;
    await pool.query("UPDATE conversations SET queue_id=$1 WHERE id=$2", [archivedId, conversationId]);
    expect((await app.inject({ method: "DELETE", url: `/conversation-queues/${archivedId}`, headers: { cookie: ownerCookie } })).statusCode).toBe(204);

    const active = await app.inject({ url: "/conversation-queues", headers: { cookie: operatorCookie } });
    expect(active.statusCode).toBe(200);
    expect(active.json().queues).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: archivedId })]));

    const withArchived = await app.inject({ url: "/conversation-queues?include_archived=true", headers: { cookie: operatorCookie } });
    expect(withArchived.statusCode).toBe(200);
    const archivedQueue = withArchived.json().queues.find((queue: { id: string }) => queue.id === archivedId);
    expect(archivedQueue).toMatchObject({ id: archivedId, archived_at: expect.anything(), conversation_count: 0 });
  });
});

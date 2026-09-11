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
let tenantId = "";
let foreignTenantId = "";
let ownerId = "";
let operatorId = "";
let foreignOwnerId = "";
let sessionOne = "";
let sessionTwo = "";
let foreignSession = "";
let initialQueue = "";
let scheduledQueue = "";
let ownerCookie = "";
let operatorCookie = "";
let foreignCookie = "";
const conversationIds: string[] = [];

async function first<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, values: unknown[] = []) {
  return (await pool.query<T>(sql, values)).rows[0];
}
async function cookie(userId: string, activeTenant: string, email: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId, tenantId: activeTenant, email, role })}`;
}
async function createLeadAndConversation(options: {
  name: string;
  assignedUserId: string | null;
  sessionId: string;
  queueId: string;
  nextActionAt: string | null;
  unread: boolean;
}) {
  const phone = `5511${String(conversationIds.length + 1).padStart(10, "0")}`;
  const lead = await first<{ id: string }>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,interest_category_id,unit_id,source,pipeline_stage_id,next_action,next_action_at
     )
     SELECT $1,$2,$3,'test-category','test-unit','integration',id,$4,$5
     FROM pipeline_stages
     WHERE tenant_id=$1 AND technical_status='novo' AND is_default
     RETURNING id`,
    [tenantId, phone, options.name, options.nextActionAt ? "Call" : null, options.nextActionAt]
  );
  if (!lead) throw new Error("integration fixture lead was not created");
  const conversation = await first<{ id: string }>(
    `INSERT INTO conversations(
       tenant_id,session_id,contact_phone,contact_name,lead_id,assigned_user_id,queue_id,status,ai_active,last_read_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,'open',false,$8)
     RETURNING id`,
    [
      tenantId,
      options.sessionId,
      phone,
      options.name,
      lead.id,
      options.assignedUserId,
      options.queueId,
      options.unread ? null : new Date().toISOString()
    ]
  );
  if (!conversation) throw new Error("integration fixture conversation was not created");
  conversationIds.push(conversation.id);
  if (options.unread) {
    await pool.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2)", [conversation.id, `Unread ${options.name}`]);
  }
  return conversation.id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Conversation filters ${suffix}`]
    )).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Foreign filters ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'test-category','Test category')", [tenantId]);
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'test-unit','Test unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])",
      [tenantId]
    );
    sessionOne = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'One','connected') RETURNING id", [tenantId]
    )).rows[0].id;
    sessionTwo = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Two','connected') RETURNING id", [tenantId]
    )).rows[0].id;
    foreignSession = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Foreign','connected') RETURNING id", [foreignTenantId]
    )).rows[0].id;
    ownerId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`filters-owner-${suffix}@test.local`]
    )).rows[0].id;
    operatorId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`filters-operator-${suffix}@test.local`]
    )).rows[0].id;
    foreignOwnerId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`filters-foreign-${suffix}@test.local`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, ownerId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [tenantId, operatorId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [foreignTenantId, foreignOwnerId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  initialQueue = (await first<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial", [tenantId]))!.id;
  scheduledQueue = (await first<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND name='Agendado'", [tenantId]))!.id;
  ownerCookie = await cookie(ownerId, tenantId, `filters-owner-${suffix}@test.local`, "OWNER");
  operatorCookie = await cookie(operatorId, tenantId, `filters-operator-${suffix}@test.local`, "OPERADOR");
  foreignCookie = await cookie(foreignOwnerId, foreignTenantId, `filters-foreign-${suffix}@test.local`, "OWNER");
  await createLeadAndConversation({ name: `Alpha ${suffix}`, assignedUserId: operatorId, sessionId: sessionOne, queueId: initialQueue, nextActionAt: new Date(Date.now() - 60_000).toISOString(), unread: true });
  await createLeadAndConversation({ name: `Beta ${suffix}`, assignedUserId: operatorId, sessionId: sessionTwo, queueId: scheduledQueue, nextActionAt: new Date(Date.now() + 60 * 60_000).toISOString(), unread: false });
  await createLeadAndConversation({ name: `Gamma ${suffix}`, assignedUserId: ownerId, sessionId: sessionOne, queueId: scheduledQueue, nextActionAt: null, unread: true });
  await createLeadAndConversation({ name: `Delta ${suffix}`, assignedUserId: null, sessionId: sessionTwo, queueId: initialQueue, nextActionAt: null, unread: false });
  await pool.query(
    `INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'test-category','Test category') ON CONFLICT DO NOTHING`,
    [foreignTenantId]
  );
  await pool.query(
    `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
     VALUES($1,'test-unit','Test unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`, [foreignTenantId]
  );
  await pool.query(
    `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status,is_default)
     SELECT $1,'Integration default','#123456',5,'novo',true
     WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='novo' AND is_default)`, [tenantId]
  );
  await pool.query(
    `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status,is_default)
     SELECT $1,'Integration default','#123456',5,'novo',true
     WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='novo' AND is_default)`, [foreignTenantId]
  );
  const foreignLead = await first<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,interest_category_id,unit_id,source,pipeline_stage_id)
     SELECT $1,'559900000001','Foreign ${suffix}','test-category','test-unit','integration',id
     FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='novo' AND is_default RETURNING id`, [foreignTenantId]
  );
  await pool.query(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,queue_id)
     SELECT $1,$2,'559900000001','Foreign ${suffix}',$3,id FROM conversation_queues WHERE tenant_id=$1 AND is_initial`,
    [foreignTenantId, foreignSession, foreignLead!.id]
  );
  for (let index = 0; index < 56; index += 1) {
    await createLeadAndConversation({ name: `Bulk ${index} ${suffix}`, assignedUserId: ownerId, sessionId: sessionOne, queueId: initialQueue, nextActionAt: null, unread: false });
  }
});

afterAll(async () => {
  if (tenantId || foreignTenantId) {
    await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId].filter(Boolean)]);
  }
  if (ownerId || operatorId || foreignOwnerId) {
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerId, operatorId, foreignOwnerId].filter(Boolean)]);
  }
  await app.close();
  await pool.end();
});

describe("GET /conversations filters against PostgreSQL", () => {
  const ids = async (url: string, headers = { cookie: ownerCookie }) => {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    return response.json().conversations.map((conversation: { id: string }) => conversation.id) as string[];
  };

  it("applies queue, session, unread and pending-action true/false together with mine and q", async () => {
    const alpha = conversationIds[0];
    expect(await ids(`/conversations?filter=mine&queue_id=${initialQueue}&session_id=${sessionOne}&unread=true&pending_action=true&q=Alpha`, { cookie: operatorCookie })).toEqual([alpha]);
    expect(await ids(`/conversations?filter=mine&queue_id=${scheduledQueue}&session_id=${sessionTwo}&unread=false&pending_action=false&q=Beta`, { cookie: operatorCookie })).toEqual([conversationIds[1]]);
    expect(await ids(`/conversations?queue_id=${scheduledQueue}&unread=true&pending_action=false&q=Gamma`)).toEqual([conversationIds[2]]);
    expect(await ids(`/conversations?queue_id=${initialQueue}&session_id=${sessionTwo}&unread=false&pending_action=false&q=Delta`)).toEqual([conversationIds[3]]);
    expect(await ids(`/conversations?filter=mine&q=Gamma`, { cookie: operatorCookie })).toEqual([]);
  });

  it.each(["unread=1", "pending_action=yes"])("rejects invalid boolean query value %s", async (query) => {
    const response = await app.inject({ url: `/conversations?${query}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(400);
  });

  it("enforces tenant isolation, authorization and the maximum page size", async () => {
    expect((await app.inject({ url: "/conversations" })).statusCode).toBe(401);
    const foreign = await app.inject({ url: "/conversations", headers: { cookie: foreignCookie } });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().conversations).toEqual([expect.objectContaining({ contact_name: expect.stringContaining("Foreign") })]);
    expect(foreign.json().conversations.map((conversation: { id: string }) => conversation.id)).not.toContain(conversationIds[0]);
    const response = await app.inject({ url: "/conversations", headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().conversations).toHaveLength(50);
  });
});

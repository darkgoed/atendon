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
let sessionId = "";
let foreignSessionId = "";

let ownerCookie = "";
let operatorCookie = "";
let foreignCookie = "";
const createdConversationIds: string[] = [];

async function first<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, values: unknown[] = []) {
  return (await pool.query<T>(sql, values)).rows[0];
}
async function token(userId: string, activeTenant: string, email: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId, tenantId: activeTenant, email, role })}`;
}
async function createPending(tenant: string, session: string, name: string, nextActionAt: string, assignedUserId: string | null) {
  const lead = await first<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,interest_category_id,unit_id,source,pipeline_stage_id,next_action,next_action_at)
     SELECT $1,$2,$3,'pending-category','pending-unit','integration',id,'Follow up',$4
     FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='novo' AND is_default RETURNING id`,
    [tenant, `5533${String(createdConversationIds.length + 1).padStart(10, "0")}`, name, nextActionAt]
  );
  const conversation = await first<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,assigned_user_id,queue_id,status)
     SELECT $1,$2,$3,$4,$5,$6,id,'open' FROM conversation_queues WHERE tenant_id=$1 AND is_initial RETURNING id`,
    [tenant, session, `5533${String(createdConversationIds.length + 1).padStart(10, "0")}`, name, lead!.id, assignedUserId]
  );
  if (!conversation) throw new Error("pending action fixture conversation was not created");
  createdConversationIds.push(conversation.id);
  return conversation.id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Pending ${suffix}`]
    )).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Foreign pending ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    for (const tenant of [tenantId, foreignTenantId]) {
      await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'pending-category','Pending category')", [tenant]);
      await client.query(
        "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'pending-unit','Pending unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])",
        [tenant]
      );
      await client.query(
        `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status,is_default)
         SELECT $1,'Integration pending default','#123456',5,'novo',true
         WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='novo' AND is_default)`, [tenant]
      );
    }
    sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Pending','connected') RETURNING id", [tenantId]
    )).rows[0].id;
    foreignSessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Foreign pending','connected') RETURNING id", [foreignTenantId]
    )).rows[0].id;
    ownerId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`pending-owner-${suffix}@test.local`]
    )).rows[0].id;
    operatorId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`pending-operator-${suffix}@test.local`]
    )).rows[0].id;
    foreignOwnerId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`pending-foreign-${suffix}@test.local`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [tenantId, ownerId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`, [tenantId, operatorId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [foreignTenantId, foreignOwnerId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  ownerCookie = await token(ownerId, tenantId, `pending-owner-${suffix}@test.local`, "OWNER");
  operatorCookie = await token(operatorId, tenantId, `pending-operator-${suffix}@test.local`, "OPERADOR");
  foreignCookie = await token(foreignOwnerId, foreignTenantId, `pending-foreign-${suffix}@test.local`, "OWNER");
  const overdue = new Date(Date.now() - 60 * 60_000).toISOString();
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const distant = new Date(Date.now() + 60 * 60_000).toISOString();
  await createPending(tenantId, sessionId, `Overdue 1 ${suffix}`, overdue, operatorId);
  await createPending(tenantId, sessionId, `Overdue 2 ${suffix}`, overdue, ownerId);
  for (let index = 0; index < 50; index += 1) {
    await createPending(tenantId, sessionId, `Soon ${index} ${suffix}`, soon, operatorId);
  }
  await createPending(tenantId, sessionId, `Distant ${suffix}`, distant, operatorId);
  await createPending(foreignTenantId, foreignSessionId, `Foreign ${suffix}`, overdue, null);
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

describe("GET /conversations/pending-actions against PostgreSQL", () => {
  it("uses the database window, SQL overdue flag, deterministic ordering and pre-limit totals", async () => {
    const response = await app.inject({ url: "/conversations/pending-actions", headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ conversation_id: string; next_action_at: string; overdue: boolean }>;
      total: number;
      overdue_total: number;
    };
    expect(body.total).toBe(52);
    expect(body.overdue_total).toBe(2);
    expect(body.items).toHaveLength(50);
    expect(body.items.every((item) => item.next_action_at <= new Date(Date.now() + 15 * 60_000).toISOString())).toBe(true);
    expect(body.items.filter((item) => item.overdue)).toHaveLength(2);
    for (let index = 1; index < body.items.length; index += 1) {
      const previous = body.items[index - 1];
      const current = body.items[index];
      expect(previous.next_action_at < current.next_action_at || (previous.next_action_at === current.next_action_at && previous.conversation_id < current.conversation_id)).toBe(true);
    }
    expect(body.items.map((item) => item.conversation_id)).not.toContain(createdConversationIds.at(-1));
  });

  it("applies attendant scope, tenant isolation and authorization", async () => {
    const mine = await app.inject({ url: "/conversations/pending-actions", headers: { cookie: operatorCookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.every((item: { assigned_user_email: string }) => item.assigned_user_email === `pending-operator-${suffix}@test.local`)).toBe(true);
    expect(mine.json().total).toBe(51);
    const foreign = await app.inject({ url: "/conversations/pending-actions", headers: { cookie: foreignCookie } });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ total: 1, overdue_total: 1 });
    expect(foreign.json().items).toEqual([expect.objectContaining({ contact_name: expect.stringContaining("Foreign") })]);
    expect(foreign.json().items.map((item: { conversation_id: string }) => item.conversation_id)).not.toContain(createdConversationIds[0]);
    expect((await app.inject({ url: "/conversations/pending-actions" })).statusCode).toBe(401);
  });
});

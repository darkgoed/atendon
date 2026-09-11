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
const categoryId = `briefing-${suffix}`;
const unitId = `briefing-${suffix}`;
const source = `source-${suffix}`;
const campaign = `campaign-${suffix}`;
const nextAction = `Enviar proposta ${suffix}`;
const nextActionAt = "2035-02-03T14:15:16.000Z";

let tenantId = "";
let foreignTenantId = "";
let ownerId = "";
let operatorId = "";
let foreignOwnerId = "";
let ownerCookie = "";
let operatorCookie = "";
let foreignCookie = "";
let conversationId = "";
let instagramConversationId = "";
let foreignConversationId = "";
let scopedConversationId = "";
let nullableInterestCategory = false;
let orphanInterestCategoryAllowed = false;
let phoneSequence = 0;

async function first<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, values: unknown[] = []) {
  return (await pool.query<T>(sql, values)).rows[0];
}

async function cookie(userId: string, tenant: string, email: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId, tenantId: tenant, email, role })}`;
}

async function createLeadAndThread(tenant: string, sessionId: string, leadName: string, interestCategoryId: string | null, assignedUserId: string | null) {
  const lead = await first<{ id: string }>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,interest_category_id,unit_id,status,source,campaign,next_action,next_action_at,pipeline_stage_id
     )
     SELECT $1,$2,$3,$4,$5,'em_atendimento',$6,$7,$8,$9,id
     FROM pipeline_stages
     WHERE tenant_id=$1 AND technical_status='em_atendimento' AND is_default
     RETURNING id`,
    [tenant, `551199${String(phoneSequence++).padStart(7, "0")}`, leadName, interestCategoryId, unitId, source, campaign, nextAction, nextActionAt]
  );
  if (!lead) throw new Error("briefing integration lead was not created");
  const conversation = await first<{ id: string }>(
    `INSERT INTO conversations(
       tenant_id,session_id,contact_phone,contact_name,lead_id,assigned_user_id,queue_id,status
     )
     SELECT $1,$2,lead.phone,lead.name,lead.id,$4,q.id,'open'
     FROM scheduling_leads lead
     JOIN conversation_queues q ON q.tenant_id=lead.tenant_id AND q.is_initial
     WHERE lead.id=$3
     RETURNING id`,
    [tenant, sessionId, lead.id, assignedUserId]
  );
  if (!conversation) throw new Error("briefing integration conversation was not created");
  return { leadId: lead.id, conversationId: conversation.id };
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Thread briefing ${suffix}`])).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Foreign thread briefing ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    for (const tenant of [tenantId, foreignTenantId]) {
      await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,$2,$3)", [tenant, categoryId, "Categoria briefing"]);
      await client.query(
        "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,$2,$3,'08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])",
        [tenant, unitId, "Unidade briefing"]
      );
      await client.query(
        `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status,is_default)
         SELECT $1,'Briefing default','#123456',5,'em_atendimento',true
         WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='em_atendimento' AND is_default)`,
        [tenant]
      );
    }
    ownerId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`briefing-owner-${suffix}@test.local`])).rows[0].id;
    operatorId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`briefing-operator-${suffix}@test.local`])).rows[0].id;
    foreignOwnerId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`briefing-foreign-${suffix}@test.local`])).rows[0].id;
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
    await client.query("INSERT INTO whatsapp_sessions(tenant_id,label,status,channel) VALUES($1,'Briefing WhatsApp','connected','whatsapp'),($1,'Briefing Instagram','connected','instagram'),($2,'Foreign briefing','connected','whatsapp')", [tenantId, foreignTenantId]);
    const nullability = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='scheduling_leads' AND column_name='interest_category_id'`
    );
    nullableInterestCategory = nullability.rows[0]?.is_nullable === "YES";
    const fk = await client.query<{ count: string }>(
      `SELECT count(*)::text count
       FROM pg_constraint c
       JOIN pg_class table_ref ON table_ref.oid=c.conrelid
       WHERE table_ref.relname='scheduling_leads' AND c.contype='f'
         AND pg_get_constraintdef(c.oid) LIKE '%interest_category_id%'`
    );
    orphanInterestCategoryAllowed = nullableInterestCategory && Number(fk.rows[0]?.count ?? 0) === 0;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  ownerCookie = await cookie(ownerId, tenantId, `briefing-owner-${suffix}@test.local`, "OWNER");
  operatorCookie = await cookie(operatorId, tenantId, `briefing-operator-${suffix}@test.local`, "OPERADOR");
  foreignCookie = await cookie(foreignOwnerId, foreignTenantId, `briefing-foreign-${suffix}@test.local`, "OWNER");
  const tenantSession = (await first<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' LIMIT 1", [tenantId]))?.id;
  const instagramSession = (await first<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='instagram' LIMIT 1", [tenantId]))?.id;
  const foreignSession = (await first<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 LIMIT 1", [foreignTenantId]))?.id;
  if (!tenantSession || !instagramSession || !foreignSession) throw new Error("briefing integration channel sessions were not seeded");
  conversationId = (await createLeadAndThread(tenantId, tenantSession, `Lead briefing ${suffix}`, categoryId, ownerId)).conversationId;
  instagramConversationId = (await createLeadAndThread(tenantId, instagramSession, `Lead Instagram ${suffix}`, categoryId, ownerId)).conversationId;
  scopedConversationId = (await createLeadAndThread(tenantId, tenantSession, `Lead scoped ${suffix}`, categoryId, ownerId)).conversationId;
  foreignConversationId = (await createLeadAndThread(foreignTenantId, foreignSession, `Lead foreign ${suffix}`, categoryId, foreignOwnerId)).conversationId;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId].filter(Boolean)]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerId, operatorId, foreignOwnerId].filter(Boolean)]);
  await app.close();
  await pool.end();
});

describe("conversation thread briefing contract", () => {
  it("returns exact lead briefing and follow-up fields through legacy and v2 threads", async () => {
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'conversations_delta_v2',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId]
    );
    try {
      const expected = {
        lead_source: source,
        lead_campaign: campaign,
        next_action: nextAction,
        next_action_at: nextActionAt,
        interest: "Categoria briefing"
      };
      for (const fixture of [
        { conversationId, channel: "whatsapp" },
        { conversationId: instagramConversationId, channel: "instagram" }
      ]) {
        for (const url of [`/conversations/${fixture.conversationId}/messages`, `/conversations/${fixture.conversationId}/messages/v2`]) {
          const response = await app.inject({ url, headers: { cookie: ownerCookie } });
          expect(response.statusCode).toBe(200);
          expect(response.json().conversation).toMatchObject({ ...expected, channel: fixture.channel });
        }
      }
    } finally {
      await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key='conversations_delta_v2'", [tenantId]);
    }
  });

  it("uses interest_category_id only when the schema permits an absent category without violating its constraints", async () => {
    if (!orphanInterestCategoryAllowed) return;
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'conversations_delta_v2',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId]
    );
    try {
      const sessionId = (await first<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 LIMIT 1", [tenantId]))!.id;
      const fixture = await createLeadAndThread(tenantId, sessionId, `Lead fallback ${suffix}`, `missing-${suffix}`, ownerId);
      for (const url of [`/conversations/${fixture.conversationId}/messages`, `/conversations/${fixture.conversationId}/messages/v2`]) {
        const response = await app.inject({ url, headers: { cookie: ownerCookie } });
        expect(response.statusCode).toBe(200);
        expect(response.json().conversation.interest).toBe(`missing-${suffix}`);
      }
    } finally {
      await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key='conversations_delta_v2'", [tenantId]);
    }
  });

  it("returns 404 for a foreign tenant and for a conversation outside the operator case scope", async () => {
    expect((await app.inject({ url: `/conversations/${foreignConversationId}/messages`, headers: { cookie: ownerCookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/conversations/${foreignConversationId}/messages/v2`, headers: { cookie: ownerCookie } })).statusCode).toBe(404);
    for (const url of [`/conversations/${scopedConversationId}/messages`, `/conversations/${scopedConversationId}/messages/v2`]) {
      expect((await app.inject({ url, headers: { cookie: operatorCookie } })).statusCode).toBe(404);
    }
    expect((await app.inject({ url: `/conversations/${conversationId}/messages`, headers: { cookie: foreignCookie } })).statusCode).toBe(404);
  });
});

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
const ownerEmail = `pipeline-settings-owner-${suffix}@test.local`;
const operatorEmail = `pipeline-settings-operator-${suffix}@test.local`;
let tenantId = "";
let governedTenantId = "";
let ownerUserId = "";
let operatorUserId = "";
let operatorMemberId = "";
let closedLeadId = "";
let governedLeadId = "";
let isolationLeadId = "";
let ownerCookie = "";
let operatorCookie = "";
let governedOwnerCookie = "";

async function cookieFor(userId: string, email: string, activeTenantId: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId,tenantId: activeTenantId,email,role })}`;
}

async function defaultStageId(activeTenantId: string, technicalStatus: string) {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND technical_status=$2 AND is_default AND archived_at IS NULL",
    [activeTenantId,technicalStatus]
  );
  expect(result.rows[0]).toBeTruthy();
  return result.rows[0].id;
}

async function insertLead(connection: Pick<pg.Pool, "query">, activeTenantId: string, phone: string, assignedMemberId: string) {
  return (await connection.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id)
     VALUES($1,$2,$3,'test',$4) RETURNING id`,
    [activeTenantId,phone,`Lead settings ${phone.slice(-4)}`,assignedMemberId]
  )).rows[0].id;
}

async function commercialPayload(responsibleMemberId: string) {
  return {
    sale_value: 1500.5,
    sale_product: "Plano Premium",
    sale_source: "campanha-settings",
    sale_channel: "whatsapp",
    responsavel_member_id: responsibleMemberId
  };
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Pipeline settings ${suffix}`])).rows[0].id;
    governedTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Pipeline settings vizinho ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client,tenantId);
    await ensureWorkspaceDefaultRoles(client,governedTenantId);
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES ($1,'case_organization_v1',true),($1,'leads_v1',true),($1,'pipeline_v1',true),
              ($2,'case_organization_v1',true),($2,'leads_v1',true),($2,'pipeline_v1',true)
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
      [tenantId,governedTenantId]
    );
    const users = await client.query<{ id: string; email: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active'),($2,'active') RETURNING id,email",
      [ownerEmail,operatorEmail]
    );
    const byEmail = new Map(users.rows.map((row) => [row.email,row.id]));
    ownerUserId = byEmail.get(ownerEmail)!;
    operatorUserId = byEmail.get(operatorEmail)!;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId,ownerUserId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [governedTenantId,ownerUserId]
    );
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id`,
      [tenantId,operatorUserId]
    )).rows[0].id;
    // Sem aresta configurada: o grafo do tenant começa vazio.
    await client.query("DELETE FROM pipeline_transitions WHERE tenant_id=$1",[tenantId]);
    closedLeadId = await insertLead(client,tenantId,"5511986000011",operatorMemberId);
    governedLeadId = await insertLead(client,tenantId,"5511986000022",operatorMemberId);
    isolationLeadId = await insertLead(client,tenantId,"5511986000033",operatorMemberId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = await cookieFor(ownerUserId,ownerEmail,tenantId,"OWNER");
  operatorCookie = await cookieFor(operatorUserId,operatorEmail,tenantId,"OPERADOR");
  governedOwnerCookie = await cookieFor(ownerUserId,ownerEmail,governedTenantId,"OWNER");
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])",[[ownerUserId,operatorUserId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[[tenantId,governedTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[ownerUserId,operatorUserId]]);
  await pool.end();
  await app.close();
});

describe("pipeline free movement settings",() => {
  it("moves a lead directly to fechado without a configured edge in free mode",async () => {
    const novoStageId = await defaultStageId(tenantId,"novo");
    const fechadoStageId = await defaultStageId(tenantId,"fechado");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM pipeline_transitions WHERE tenant_id=$1 AND from_stage_id=$2 AND to_stage_id=$3",
      [tenantId,novoStageId,fechadoStageId]
    )).rows[0].count).toBe(0);
    const pipeline = await app.inject({ url: "/organization/pipeline",headers: { cookie: ownerCookie } });
    expect(pipeline.statusCode).toBe(200);
    expect(pipeline.json().enforce_transitions).toBe(false);

    const moved = await app.inject({
      method: "PATCH",url: `/organization/leads/${closedLeadId}/stage`,headers: { cookie: ownerCookie },
      payload: { stage_id: fechadoStageId,commercial: await commercialPayload(operatorMemberId) }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().lead).toMatchObject({ id: closedLeadId,status: "fechado",pipeline_stage_id: fechadoStageId });
    const persisted = (await pool.query(
      "SELECT status,commercial_outcome,sale_value FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId,closedLeadId]
    )).rows[0];
    expect(persisted).toMatchObject({ status: "fechado",commercial_outcome: "fechado" });
    expect(Number(persisted.sale_value)).toBeGreaterThan(0);
    const history = (await pool.query<{ previous_status: string; new_status: string }>(
      `SELECT previous_status,new_status
       FROM scheduling_lead_events
       WHERE tenant_id=$1 AND lead_id=$2 AND event_type='pipeline_stage_updated'`,
      [tenantId,closedLeadId]
    )).rows;
    expect(history).toEqual([expect.objectContaining({ previous_status: "novo",new_status: "fechado" })]);
  });

  it("governs the same movement again after the toggle enforces transitions",async () => {
    const fechadoStageId = await defaultStageId(tenantId,"fechado");
    const toggled = await app.inject({
      method: "PATCH",url: "/organization/pipeline/settings",headers: { cookie: ownerCookie },
      payload: { enforce_transitions: true }
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json()).toEqual({ enforce_transitions: true });
    const audit = (await pool.query<{ action: string; metadata: Record<string,unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE workspace_id=$1 AND action='pipeline.settings.updated'",
      [tenantId]
    )).rows;
    expect(audit[0]).toBeTruthy();
    expect(audit[0].metadata).toMatchObject({ enforce_transitions: true,previous_enforce_transitions: false });

    const pipeline = await app.inject({ url: "/organization/pipeline",headers: { cookie: ownerCookie } });
    expect(pipeline.json().enforce_transitions).toBe(true);

    const blocked = await app.inject({
      method: "PATCH",url: `/organization/leads/${governedLeadId}/stage`,headers: { cookie: ownerCookie },
      payload: { stage_id: fechadoStageId,commercial: await commercialPayload(operatorMemberId) }
    });
    expect(blocked.statusCode).toBe(409);
    expect((await pool.query<{ status: string; pipeline_stage_id: string }>(
      "SELECT status,pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId,governedLeadId]
    )).rows[0]).toMatchObject({ status: "novo" });

    const restored = await app.inject({
      method: "PATCH",url: "/organization/pipeline/settings",headers: { cookie: ownerCookie },
      payload: { enforce_transitions: false }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ enforce_transitions: false });
  });

  it("rejects the settings toggle without pipeline.manage",async () => {
    const denied = await app.inject({
      method: "PATCH",url: "/organization/pipeline/settings",headers: { cookie: operatorCookie },
      payload: { enforce_transitions: true }
    });
    expect(denied.statusCode).toBe(403);
    const operatorHasManage = (await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM workspace_role_permissions permission
       JOIN workspace_roles role ON role.id=permission.role_id
       WHERE role.workspace_id=$1 AND role.name='OPERADOR' AND permission.permission_key='pipeline.manage'`,
      [tenantId]
    )).rows[0].count;
    expect(operatorHasManage).toBe(0);
  });

  it("keeps tenants isolated from each other's movement mode",async () => {
    const neighborToggle = await app.inject({
      method: "PATCH",url: "/organization/pipeline/settings",headers: { cookie: governedOwnerCookie },
      payload: { enforce_transitions: true }
    });
    expect(neighborToggle.statusCode).toBe(200);
    expect(neighborToggle.json()).toEqual({ enforce_transitions: true });

    const ownPipeline = await app.inject({ url: "/organization/pipeline",headers: { cookie: ownerCookie } });
    expect(ownPipeline.json().enforce_transitions).toBe(false);

    const neighborPipeline = await app.inject({ url: "/organization/pipeline",headers: { cookie: governedOwnerCookie } });
    expect(neighborPipeline.json().enforce_transitions).toBe(true);

    const fechadoStageId = await defaultStageId(tenantId,"fechado");
    const stillFree = await app.inject({
      method: "PATCH",url: `/organization/leads/${isolationLeadId}/stage`,headers: { cookie: ownerCookie },
      payload: { stage_id: fechadoStageId,commercial: await commercialPayload(operatorMemberId) }
    });
    expect(stillFree.statusCode).toBe(200);
    expect(stillFree.json().lead).toMatchObject({ id: isolationLeadId,status: "fechado",pipeline_stage_id: fechadoStageId });
  });
});

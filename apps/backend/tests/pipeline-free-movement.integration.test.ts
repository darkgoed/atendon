import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { leadMapper } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const ownerEmail = `pipeline-owner-${suffix}@test.local`;
const operatorEmail = `pipeline-operator-${suffix}@test.local`;
const foreignEmail = `pipeline-foreign-${suffix}@test.local`;
let tenantId = "";
let legacyTenantId = "";
let foreignTenantId = "";
let ownerUserId = "";
let operatorUserId = "";
let foreignUserId = "";
let ownerMemberId = "";
let operatorMemberId = "";
let freeLeadId = "";
let bulkLeadId = "";
let strictLeadId = "";
let saleLeadId = "";
let lossLeadId = "";
let mineLeadId = "";
let foreignLeadId = "";
let ownerCookie = "";
let operatorCookie = "";

async function cookieFor(userId: string, email: string, activeTenantId: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId, tenantId: activeTenantId, email, role })}`;
}

async function stageId(activeTenantId: string, status: string) {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND technical_status=$2 AND is_default AND archived_at IS NULL",
    [activeTenantId, status]
  );
  expect(result.rows[0]).toBeTruthy();
  return result.rows[0].id;
}

async function insertLead(connection: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, activeTenantId: string, name: string, assignedMemberId: string) {
  const result = await connection.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id)
     VALUES($1,$2,$3,'integration-test',$4) RETURNING id`,
    [activeTenantId, `55${Math.floor(1000000000 + Math.random() * 8999999999)}`, name, assignedMemberId]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Pipeline livre ${suffix}`])).rows[0].id;
    legacyTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status,pipeline_enforce_transitions) VALUES($1,'active',true) RETURNING id", [`Pipeline legado ${suffix}`])).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Pipeline estrangeiro ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, legacyTenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    const users = await client.query<{ id: string; email: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active'),($2,'active'),($3,'active') RETURNING id,email",
      [ownerEmail, operatorEmail, foreignEmail]
    );
    const byEmail = new Map(users.rows.map((row) => [row.email, row.id]));
    ownerUserId = byEmail.get(ownerEmail)!;
    operatorUserId = byEmail.get(operatorEmail)!;
    foreignUserId = byEmail.get(foreignEmail)!;
    ownerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER' RETURNING id`,
      [tenantId, ownerUserId]
    )).rows[0].id;
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id`,
      [tenantId, operatorUserId]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [legacyTenantId, ownerUserId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [foreignTenantId, foreignUserId]
    );
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'case_organization_v1',true),($1,'post_sales_v1',false),($1,'leads_v1',true),($1,'pipeline_v1',true),
             ($2,'case_organization_v1',true),($2,'post_sales_v1',false),($2,'leads_v1',true),($2,'pipeline_v1',true),
             ($3,'case_organization_v1',true),($3,'post_sales_v1',false),($3,'leads_v1',true),($3,'pipeline_v1',true)
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [tenantId, legacyTenantId, foreignTenantId]
    );
    await client.query(
      `INSERT INTO lead_loss_reasons(tenant_id,key,label,position,requires_note,is_system)
       VALUES($1,'custom_note','Motivo com nota',901,false,false)
       ON CONFLICT (tenant_id,key) DO UPDATE SET requires_note=true`,
      [tenantId]
    );
    await client.query("UPDATE lead_loss_reasons SET requires_note=true WHERE tenant_id=$1 AND key='custom_note'", [tenantId]);
    freeLeadId = await insertLead(client, tenantId, "Livre individual", operatorMemberId);
    bulkLeadId = await insertLead(client, tenantId, "Livre bulk", operatorMemberId);
    saleLeadId = await insertLead(client, tenantId, "Venda metadata", operatorMemberId);
    lossLeadId = await insertLead(client, tenantId, "Perda com nota", operatorMemberId);
    mineLeadId = await insertLead(client, tenantId, "Lead de outro responsável", ownerMemberId);
    strictLeadId = await insertLead(client, legacyTenantId, "Legado estrito", (await client.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [legacyTenantId, ownerUserId]
    )).rows[0]?.id ?? ownerMemberId);
    foreignLeadId = await insertLead(client, foreignTenantId, "Lead estrangeiro", (await client.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [foreignTenantId, foreignUserId]
    )).rows[0].id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = await cookieFor(ownerUserId, ownerEmail, tenantId, "OWNER");
  operatorCookie = await cookieFor(operatorUserId, operatorEmail, tenantId, "OPERADOR");
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[ownerUserId, operatorUserId, foreignUserId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, legacyTenantId, foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerUserId, operatorUserId, foreignUserId]]);
  await pool.end();
  await app.close();
});

describe("pipeline free movement integration", () => {
  it("reports real tenant defaults, legacy configuration, situation and stage flags", async () => {
    const free = await app.inject({ method: "GET", url: "/organization/pipeline", headers: { cookie: ownerCookie } });
    expect(free.statusCode).toBe(200);
    expect(free.json().enforce_transitions).toBe(false);
    expect(free.json().stages.find((stage: { technical_status: string }) => stage.technical_status === "novo")).toMatchObject({ is_default_board: true });

    const legacyCookie = await cookieFor(ownerUserId, ownerEmail, legacyTenantId, "OWNER");
    const legacy = await app.inject({ method: "GET", url: "/organization/pipeline", headers: { cookie: legacyCookie } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().enforce_transitions).toBe(true);

    const mapped = leadMapper({ id: freeLeadId, tenant_id: tenantId, phone: "5511999999999", name: "Mapper", status: "agendado", pipeline_stage_id: await stageId(tenantId, "agendado"), has_upcoming_appointment: false, awaiting_reply: false, outcome_metadata: { source: "real" } });
    expect(mapped).toMatchObject({ id: freeLeadId, status: "agendado", situacao: "agendado", pipeline_stage_id: expect.any(String), outcome_metadata: { source: "real" }, recovery_required: false });
  });

  it("allows individual and bulk movement without a configured edge only in free mode", async () => {
    const moved = await app.inject({ method: "PATCH", url: `/organization/leads/${freeLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "agendado") } });
    expect(moved.statusCode).toBe(200);
    const freePreview = await app.inject({ method: "POST", url: "/organization/bulk/preview", headers: { cookie: ownerCookie }, payload: { action: "move_stage", items: [{ id: bulkLeadId }], stage_id: await stageId(tenantId, "agendado") } });
    expect(freePreview.statusCode).toBe(200);
    expect(freePreview.json()).toMatchObject({ valid: true, enforceTransitions: false, count: 1, errors: [] });
    const applied = await app.inject({ method: "POST", url: "/organization/bulk/apply", headers: { cookie: ownerCookie }, payload: { action: "move_stage", items: [{ id: bulkLeadId }], stage_id: await stageId(tenantId, "agendado"), idempotency_key: `free-${suffix}` } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().result).toMatchObject({ action: "move_stage", count: 1 });
    expect((await pool.query("SELECT status FROM scheduling_leads WHERE id=$1", [bulkLeadId])).rows[0].status).toBe("agendado");

    const legacyCookie = await cookieFor(ownerUserId, ownerEmail, legacyTenantId, "OWNER");
    const preview = await app.inject({ method: "POST", url: "/organization/bulk/preview", headers: { cookie: legacyCookie }, payload: { action: "move_stage", items: [{ id: strictLeadId }], stage_id: await stageId(legacyTenantId, "agendado") } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ valid: false, enforceTransitions: true });
    expect(preview.json().errors).toEqual(expect.arrayContaining([expect.objectContaining({ id: strictLeadId, code: "domain_transition" })]));
    const appliedStrict = await app.inject({ method: "POST", url: "/organization/bulk/apply", headers: { cookie: legacyCookie }, payload: { action: "move_stage", items: [{ id: strictLeadId }], stage_id: await stageId(legacyTenantId, "agendado"), idempotency_key: `strict-${suffix}` } });
    expect(appliedStrict.statusCode).toBe(409);
    expect((await pool.query("SELECT status FROM scheduling_leads WHERE id=$1", [strictLeadId])).rows[0].status).toBe("novo");
  });

  it("serializes concurrent individual moves and rejects the stale expected timestamp", async () => {
    const leadId = await insertLead(pool, tenantId, "Concorrência individual", operatorMemberId);
    const expectedUpdatedAt = (await pool.query<{ updated_at: string }>(
      "SELECT updated_at FROM scheduling_leads WHERE id=$1", [leadId]
    )).rows[0].updated_at;
    const targets = await Promise.all([stageId(tenantId, "agendado"), stageId(tenantId, "qualificado")]);
    const responses = await Promise.all(targets.map((target) => app.inject({
      method: "PATCH",
      url: `/organization/leads/${leadId}/stage`,
      headers: { cookie: ownerCookie },
      payload: { stage_id: target, expected_updated_at: expectedUpdatedAt }
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!.json().lead;
    const persisted = (await pool.query<{ pipeline_stage_id: string; status: string }>(
      "SELECT pipeline_stage_id,status FROM scheduling_leads WHERE id=$1", [leadId]
    )).rows[0];
    expect(persisted).toMatchObject({ pipeline_stage_id: winner.pipeline_stage_id, status: winner.status });
    expect(targets).toContain(persisted.pipeline_stage_id);
  });

  it("serializes concurrent bulk moves with expected_updated_at without lost updates", async () => {
    const leadId = await insertLead(pool, tenantId, "Concorrência bulk", operatorMemberId);
    const expectedUpdatedAt = (await pool.query<{ updated_at: string }>(
      "SELECT updated_at FROM scheduling_leads WHERE id=$1", [leadId]
    )).rows[0].updated_at;
    const targets = await Promise.all([stageId(tenantId, "agendado"), stageId(tenantId, "qualificado")]);
    const responses = await Promise.all(targets.map((target, index) => app.inject({
      method: "POST",
      url: "/organization/bulk/apply",
      headers: { cookie: ownerCookie },
      payload: {
        action: "move_stage",
        items: [{ id: leadId, expected_updated_at: expectedUpdatedAt }],
        stage_id: target,
        idempotency_key: `concurrent-bulk-${suffix}-${index}`
      }
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const persisted = (await pool.query<{ pipeline_stage_id: string; status: string }>(
      "SELECT pipeline_stage_id,status FROM scheduling_leads WHERE id=$1", [leadId]
    )).rows[0];
    expect(targets).toContain(persisted.pipeline_stage_id);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
  });

  it("rejects incomplete commercial transitions and persists sale metadata atomically", async () => {
    const closedWithoutValue = await app.inject({ method: "PATCH", url: `/organization/leads/${saleLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "fechado"), commercial: {} } });
    expect(closedWithoutValue.statusCode).toBe(400);
    const lostWithoutReason = await app.inject({ method: "PATCH", url: `/organization/leads/${lossLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "perdido"), commercial: {} } });
    expect(lostWithoutReason.statusCode).toBe(400);
    const sale = await app.inject({ method: "PATCH", url: `/organization/leads/${saleLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "fechado"), commercial: { sale_value: 1250.5, sale_product: "Plano Premium", sale_channel: "whatsapp", sale_source: "campanha-x", outcome_metadata: { external_id: "sale-42", score: 9 } } } });
    expect(sale.statusCode).toBe(200);
    const persisted = (await pool.query("SELECT status,commercial_outcome,sale_value,loss_reason,outcome_metadata FROM scheduling_leads WHERE id=$1", [saleLeadId])).rows[0];
    expect(persisted).toMatchObject({ status: "fechado", commercial_outcome: "fechado", loss_reason: null, outcome_metadata: { external_id: "sale-42", score: 9, sale_product: "Plano Premium", sale_channel: "whatsapp", sale_source: "campanha-x" } });
    expect(Number(persisted.sale_value)).toBe(1250.5);
    const invalidAtomic = await app.inject({ method: "PATCH", url: `/organization/leads/${lossLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "perdido"), commercial: { loss_reason: "custom_note", sale_value: 2 } } });
    expect(invalidAtomic.statusCode).toBe(400);
    expect((await pool.query("SELECT status,commercial_outcome,sale_value,loss_reason FROM scheduling_leads WHERE id=$1", [lossLeadId])).rows[0]).toMatchObject({ status: "novo", commercial_outcome: null, sale_value: null, loss_reason: null });
    const missingNote = await app.inject({ method: "PATCH", url: `/organization/leads/${lossLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "perdido"), commercial: { loss_reason: "custom_note" } } });
    expect(missingNote.statusCode).toBe(400);
    const lost = await app.inject({ method: "PATCH", url: `/organization/leads/${lossLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "perdido"), commercial: { loss_reason: "custom_note", loss_reason_note: "Cliente adiou para o próximo trimestre" } } });
    expect(lost.statusCode).toBe(200);
    expect((await pool.query("SELECT status,commercial_outcome,loss_reason,loss_reason_note FROM scheduling_leads WHERE id=$1", [lossLeadId])).rows[0]).toMatchObject({ status: "perdido", commercial_outcome: "nao_avancou", loss_reason: "custom_note", loss_reason_note: "Cliente adiou para o próximo trimestre" });
  });

  it("returns 404 for mine and foreign records without side effects", async () => {
    const beforeMine = (await pool.query("SELECT status,pipeline_stage_id,updated_at FROM scheduling_leads WHERE id=$1", [mineLeadId])).rows[0];
    const mine = await app.inject({ method: "PATCH", url: `/organization/leads/${mineLeadId}/stage`, headers: { cookie: operatorCookie }, payload: { stage_id: await stageId(tenantId, "agendado") } });
    expect(mine.statusCode).toBe(404);
    expect((await pool.query("SELECT status,pipeline_stage_id,updated_at FROM scheduling_leads WHERE id=$1", [mineLeadId])).rows[0]).toEqual(beforeMine);
    const beforeForeign = (await pool.query("SELECT status,pipeline_stage_id,updated_at FROM scheduling_leads WHERE id=$1", [foreignLeadId])).rows[0];
    const foreign = await app.inject({ method: "PATCH", url: `/organization/leads/${foreignLeadId}/stage`, headers: { cookie: ownerCookie }, payload: { stage_id: await stageId(tenantId, "agendado") } });
    expect(foreign.statusCode).toBe(404);
    expect((await pool.query("SELECT status,pipeline_stage_id,updated_at FROM scheduling_leads WHERE id=$1", [foreignLeadId])).rows[0]).toEqual(beforeForeign);
  });
});

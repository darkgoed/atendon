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
const ownerEmail = `organization-owner-${suffix}@test.local`;
const operatorEmail = `organization-operator-${suffix}@test.local`;
const foreignOwnerEmail = `organization-foreign-${suffix}@test.local`;
let tenantId = "";
let foreignTenantId = "";
let ownerUserId = "";
let operatorUserId = "";
let foreignOwnerUserId = "";
let operatorMemberId = "";
let leadId = "";
let ownerCookie = "";
let operatorCookie = "";
let foreignOwnerCookie = "";
let operatorForeignCookie = "";

async function cookieFor(userId: string, email: string, activeTenantId: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId,tenantId: activeTenantId,email,role })}`;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Organization ${suffix}`])).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Organization foreign ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client,tenantId);
    await ensureWorkspaceDefaultRoles(client,foreignTenantId);
    ownerUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[ownerEmail])).rows[0].id;
    operatorUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[operatorEmail])).rows[0].id;
    foreignOwnerUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[foreignOwnerEmail])).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId,ownerUserId]
    );
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id`,
      [tenantId,operatorUserId]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [foreignTenantId,foreignOwnerUserId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [foreignTenantId,operatorUserId]
    );
    leadId = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id)
       VALUES($1,'5511977000011','Lead organização','test',$2) RETURNING id`,
      [tenantId,operatorMemberId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = await cookieFor(ownerUserId,ownerEmail,tenantId,"OWNER");
  operatorCookie = await cookieFor(operatorUserId,operatorEmail,tenantId,"OPERADOR");
  foreignOwnerCookie = await cookieFor(foreignOwnerUserId,foreignOwnerEmail,foreignTenantId,"OWNER");
  operatorForeignCookie = await cookieFor(operatorUserId,operatorEmail,foreignTenantId,"OPERADOR");
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])",[[ownerUserId,operatorUserId,foreignOwnerUserId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[[tenantId,foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[ownerUserId,operatorUserId,foreignOwnerUserId]]);
  await pool.end();
  await app.close();
});

describe("case organization REST API",() => {
  let tagId = "";

  it("lets managers maintain tenant tags while operators only apply them",async () => {
    const created = await app.inject({
      method: "POST",url: "/organization/tags",headers: { cookie: ownerCookie },
      payload: { name: "Prioridade",color: "#EF4444" }
    });
    expect(created.statusCode).toBe(201);
    tagId = created.json().tag.id;

    expect((await app.inject({
      method: "POST",url: "/organization/tags",headers: { cookie: operatorCookie },
      payload: { name: "Proibida",color: "#000000" }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PUT",url: `/organization/leads/${leadId}/tags/${tagId}`,headers: { cookie: operatorCookie }
    })).statusCode).toBe(200);

    const renamed = await app.inject({
      method: "PATCH",url: `/organization/tags/${tagId}`,headers: { cookie: ownerCookie },
      payload: { name: "Prioridade crítica",color: "#DC2626" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().tag).toMatchObject({ id: tagId,name: "Prioridade crítica",color: "#DC2626",archived_at: null });

    const archiveCandidate = await app.inject({
      method: "POST",url: "/organization/tags",headers: { cookie: ownerCookie },
      payload: { name: "Temporária",color: "#64748B" }
    });
    const archivedTagId = archiveCandidate.json().tag.id;
    const archived = await app.inject({
      method: "PATCH",url: `/organization/tags/${archivedTagId}`,headers: { cookie: ownerCookie },
      payload: { archived: true }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().tag.archived_at).toBeTruthy();
    expect((await app.inject({
      method: "PUT",url: `/organization/leads/${leadId}/tags/${archivedTagId}`,headers: { cookie: operatorCookie }
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: "PATCH",url: `/organization/tags/${tagId}`,headers: { cookie: foreignOwnerCookie },
      payload: { name: "Outro tenant" }
    })).statusCode).toBe(404);

    const raceTagResponses = await Promise.all(["A","B"].map(async (label) => {
      const createdRaceTag = await app.inject({
        method: "POST",url: "/organization/tags",headers: { cookie: ownerCookie },
        payload: { name: `Concorrente ${label} ${suffix}`,color: "#0F766E" }
      });
      return createdRaceTag.json().tag.id as string;
    }));
    const raceName = `Nome único ${suffix}`;
    const concurrentRenames = await Promise.all(raceTagResponses.map((raceTagId) => app.inject({
      method: "PATCH",url: `/organization/tags/${raceTagId}`,headers: { cookie: ownerCookie },payload: { name: raceName }
    })));
    expect(concurrentRenames.map((response) => response.statusCode).sort()).toEqual([200,409]);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM lead_tags WHERE tenant_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL",
      [tenantId,raceName]
    )).rows[0].count).toBe(1);
  });

  it("validates personal/shared saved views with fixed schemas",async () => {
    const personal = await app.inject({
      method: "POST",url: "/organization/saved-views",headers: { cookie: operatorCookie },
      payload: { resource: "leads",name: "Meus aprovados",filters: { status: "qualificado" },shared: false }
    });
    expect(personal.statusCode).toBe(201);
    const personalViewId = personal.json().saved_view.id as string;
    expect((await app.inject({
      method: "POST",url: "/organization/saved-views",headers: { cookie: operatorCookie },
      payload: { resource: "leads",name: "Compartilhada",filters: {},shared: true }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PATCH",url: `/organization/saved-views/${personalViewId}`,headers: { cookie: ownerCookie },
      payload: { name: "Privada de outra pessoa" }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE",url: `/organization/saved-views/${personalViewId}`,headers: { cookie: ownerCookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",url: "/organization/saved-views",headers: { cookie: ownerCookie },
      payload: { resource: "leads",name: "SQL desconhecido",filters: { arbitrary_sql: "select 1" },shared: true }
    })).statusCode).toBe(400);

    const afterWorkspaceSwitch = await app.inject({
      method: "GET",url: "/organization/saved-views",headers: { cookie: operatorForeignCookie }
    });
    expect(afterWorkspaceSwitch.statusCode).toBe(200);
    expect(afterWorkspaceSwitch.json().saved_views).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personalViewId })
    ]));
    expect((await app.inject({
      method: "PATCH",url: `/organization/saved-views/${personalViewId}`,headers: { cookie: operatorForeignCookie },
      payload: { name: "Tentativa cruzada" }
    })).statusCode).toBe(404);

    const rolePermission = (await pool.query<{ role_id: string; permission_key: string }>(
      `SELECT role.id role_id,permission.key permission_key
       FROM workspace_roles role
       JOIN workspace_role_permissions role_permission ON role_permission.role_id=role.id
       JOIN permissions permission ON permission.key=role_permission.permission_key
       WHERE role.workspace_id=$1 AND role.name='OPERADOR' AND permission.key='leads.read'`,
      [tenantId]
    )).rows[0];
    expect(rolePermission).toBeTruthy();
    await pool.query(
      "DELETE FROM workspace_role_permissions WHERE role_id=$1 AND permission_key=$2",
      [rolePermission.role_id,rolePermission.permission_key]
    );
    try {
      expect((await app.inject({
        method: "GET",url: "/organization/saved-views?resource=leads",headers: { cookie: operatorCookie }
      })).statusCode).toBe(403);
      const afterPermissionLoss = await app.inject({
        method: "GET",url: "/organization/saved-views",headers: { cookie: operatorCookie }
      });
      expect(afterPermissionLoss.statusCode).toBe(200);
      expect(afterPermissionLoss.json().saved_views).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: personalViewId })
      ]));
    } finally {
      await pool.query(
        `INSERT INTO workspace_role_permissions(role_id,permission_key)
         VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [rolePermission.role_id,rolePermission.permission_key]
      );
    }
  });

  it("configures a same-status stage and moves a lead through an allowed visual transition",async () => {
    await pool.query(
      `UPDATE tenant_ai_settings
       SET ai_follow_up_enabled=true,
           ai_follow_up_delays_minutes=ARRAY[60,120,240,480,960,1920,3840],
           ai_follow_up_max_count=7,
           ai_follow_up_interval_minutes=60
       WHERE tenant_id=$1`,
      [tenantId]
    );
    const pipeline = await app.inject({ url: "/organization/pipeline",headers: { cookie: ownerCookie } });
    expect(pipeline.statusCode).toBe(200);
    expect(pipeline.json().follow_up_config).toEqual({ enabled: true,max_count: 7 });
    const defaultStage = pipeline.json().stages.find((stage: { technical_status: string; is_default: boolean }) => stage.technical_status === "novo" && stage.is_default);
    const unusedDefaultStage = pipeline.json().stages.find((stage: { technical_status: string; is_default: boolean }) => stage.technical_status === "aguardando_resposta" && stage.is_default);
    expect((await app.inject({
      method: "PATCH",url: `/organization/pipeline/stages/${unusedDefaultStage.id}`,headers: { cookie: ownerCookie },
      payload: { technical_status: "perdido" }
    })).statusCode).toBe(409);
    const created = await app.inject({
      method: "POST",url: "/organization/pipeline/stages",headers: { cookie: ownerCookie },
      payload: { name: "Triagem avançada",color: "#2563EB",position: 15,capacity_target: 25,technical_status: "novo",is_default: false }
    });
    expect(created.statusCode).toBe(201);
    const targetStageId = created.json().stage.id;
    expect((await app.inject({
      method: "PUT",url: `/organization/pipeline/stages/${defaultStage.id}/transitions`,headers: { cookie: ownerCookie },
      payload: { to_stage_ids: [targetStageId] }
    })).statusCode).toBe(200);
    const conversationId = (await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,contact_phone,contact_name) VALUES($1,'5511977000011','Lead organização') RETURNING id",
      [tenantId]
    )).rows[0].id;
    const agentMessageId = (await pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'agent','Acompanhamento') RETURNING id",
      [conversationId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO ai_follow_up_schedules(
         conversation_id,tenant_id,last_agent_message_id,follow_up_count,status,next_run_at
       ) VALUES($1,$2,$3,1,'scheduled',now()+interval '1 hour')`,
      [conversationId,tenantId,agentMessageId]
    );
    const moved = await app.inject({
      method: "PATCH",url: `/organization/leads/${leadId}/stage`,headers: { cookie: operatorCookie },
      payload: { stage_id: targetStageId }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().lead).toMatchObject({ id: leadId,status: "novo",pipeline_stage_id: targetStageId });
    expect((await pool.query<{ status: string; cancellation_reason: string | null }>(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE tenant_id=$1 AND conversation_id=$2",
      [tenantId,conversationId]
    )).rows[0]).toEqual({ status: "cancelled",cancellation_reason: "pipeline_stage_changed" });

    const configured = await app.inject({
      method: "PATCH",url: `/organization/pipeline/stages/${targetStageId}`,headers: { cookie: ownerCookie },
      payload: { capacity_target: 40,is_default: true }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().stage).toMatchObject({ id: targetStageId,capacity_target: 40,is_default: true });
    const afterDefaultChange = await app.inject({ url: "/organization/pipeline",headers: { cookie: ownerCookie } });
    expect(afterDefaultChange.json().stages.find((stage: { id: string }) => stage.id === defaultStage.id).is_default).toBe(false);
    expect(afterDefaultChange.json().stages.find((stage: { id: string }) => stage.id === targetStageId).is_default).toBe(true);

    expect((await app.inject({
      method: "POST",url: `/organization/pipeline/stages/${targetStageId}/archive`,headers: { cookie: ownerCookie },payload: {}
    })).statusCode).toBe(409);
    const archived = await app.inject({
      method: "POST",url: `/organization/pipeline/stages/${targetStageId}/archive`,headers: { cookie: ownerCookie },
      payload: { replacement_stage_id: defaultStage.id }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().stage).toMatchObject({ id: targetStageId,archived: true,replacement_stage_id: defaultStage.id,moved_leads: 1 });
    expect((await pool.query<{ pipeline_stage_id: string }>(
      "SELECT pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId,leadId]
    )).rows[0].pipeline_stage_id).toBe(defaultStage.id);
    const afterArchive = await app.inject({ url: "/organization/pipeline?include_archived=true",headers: { cookie: ownerCookie } });
    expect(afterArchive.json().stages.find((stage: { id: string }) => stage.id === defaultStage.id).is_default).toBe(true);
    expect(afterArchive.json().stages.find((stage: { id: string }) => stage.id === targetStageId).archived_at).toBeTruthy();
  });

  it("previews, applies idempotently and undoes an atomic tag bulk operation",async () => {
    await app.inject({ method: "DELETE",url: `/organization/leads/${leadId}/tags/${tagId}`,headers: { cookie: operatorCookie } });
    const payload = { action: "tags_add",items: [{ id: leadId }],tag_ids: [tagId] };
    const preview = await app.inject({ method: "POST",url: "/organization/bulk/preview",headers: { cookie: operatorCookie },payload });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ valid: true,count: 1,errors: [],undoable: true });
    const applyPayload = { ...payload,idempotency_key: `tag-bulk-${suffix}` };
    const applied = await app.inject({ method: "POST",url: "/organization/bulk/apply",headers: { cookie: operatorCookie },payload: applyPayload });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ result: { action: "tags_add",count: 1,undoable: true },idempotent_replay: false });
    const replay = await app.inject({ method: "POST",url: "/organization/bulk/apply",headers: { cookie: operatorCookie },payload: applyPayload });
    expect(replay.json().idempotent_replay).toBe(true);
    const tagsApplyPermission = (await pool.query<{ role_id: string }>(
      `SELECT role.id role_id FROM workspace_roles role
       JOIN workspace_role_permissions permission ON permission.role_id=role.id
       WHERE role.workspace_id=$1 AND role.name='OPERADOR' AND permission.permission_key='tags.apply'`,
      [tenantId]
    )).rows[0];
    await pool.query(
      "DELETE FROM workspace_role_permissions WHERE role_id=$1 AND permission_key='tags.apply'",
      [tagsApplyPermission.role_id]
    );
    try {
      expect((await app.inject({
        method: "POST",url: `/organization/bulk/${applied.json().operation.id}/undo`,headers: { cookie: operatorCookie }
      })).statusCode).toBe(403);
    } finally {
      await pool.query(
        "INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'tags.apply') ON CONFLICT DO NOTHING",
        [tagsApplyPermission.role_id]
      );
    }
    const undone = await app.inject({
      method: "POST",url: `/organization/bulk/${applied.json().operation.id}/undo`,headers: { cookie: operatorCookie }
    });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().result).toMatchObject({ action: "tags_add",undone: true });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3",
      [tenantId,leadId,tagId]
    )).rows[0].count).toBe(0);
  });

  it("rejects mixed invalid and stale bulk selections atomically and enforces undo expiry",async () => {
    const secondLeadId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id)
       VALUES($1,$2,'Segundo lead organização','test',$3) RETURNING id`,
      [tenantId,"5511977000022",operatorMemberId]
    )).rows[0].id;
    await pool.query(
      "DELETE FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[]) AND tag_id=$3",
      [tenantId,[leadId,secondLeadId],tagId]
    );

    const unknownLeadId = randomUUID();
    const mixedPayload = { action: "tags_add" as const,items: [{ id: leadId },{ id: unknownLeadId }],tag_ids: [tagId] };
    const mixedPreview = await app.inject({
      method: "POST",url: "/organization/bulk/preview",headers: { cookie: operatorCookie },payload: mixedPayload
    });
    expect(mixedPreview.statusCode).toBe(200);
    expect(mixedPreview.json()).toMatchObject({ valid: false,count: 2 });
    expect(mixedPreview.json().errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unknownLeadId,code: "not_found_or_forbidden" })
    ]));
    const mixedApply = await app.inject({
      method: "POST",url: "/organization/bulk/apply",headers: { cookie: operatorCookie },
      payload: { ...mixedPayload,idempotency_key: `mixed-${suffix}` }
    });
    expect(mixedApply.statusCode).toBe(409);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3",
      [tenantId,leadId,tagId]
    )).rows[0].count).toBe(0);

    const selected = await pool.query<{ id: string; updated_at: string }>(
      "SELECT id,updated_at FROM scheduling_leads WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
      [tenantId,[leadId,secondLeadId]]
    );
    await pool.query(
      "UPDATE scheduling_leads SET updated_at=updated_at+interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [tenantId,secondLeadId]
    );
    const staleApply = await app.inject({
      method: "POST",url: "/organization/bulk/apply",headers: { cookie: operatorCookie },
      payload: {
        action: "assign",assigned_member_id: null,idempotency_key: `stale-${suffix}`,
        items: selected.rows.map((lead) => ({ id: lead.id,expected_updated_at: new Date(lead.updated_at).toISOString() }))
      }
    });
    expect(staleApply.statusCode).toBe(409);
    expect((await pool.query<{ id: string; assigned_member_id: string | null }>(
      "SELECT id,assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
      [tenantId,[leadId,secondLeadId]]
    )).rows.every((lead) => lead.assigned_member_id === operatorMemberId)).toBe(true);

    const expiringApply = await app.inject({
      method: "POST",url: "/organization/bulk/apply",headers: { cookie: operatorCookie },
      payload: { action: "tags_add",items: [{ id: secondLeadId }],tag_ids: [tagId],idempotency_key: `expired-${suffix}` }
    });
    expect(expiringApply.statusCode).toBe(200);
    const expiringOperationId = expiringApply.json().operation.id as string;
    await pool.query(
      "UPDATE bulk_operations SET undo_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [tenantId,expiringOperationId]
    );
    expect((await app.inject({
      method: "POST",url: `/organization/bulk/${expiringOperationId}/undo`,headers: { cookie: operatorCookie }
    })).statusCode).toBe(410);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3",
      [tenantId,secondLeadId,tagId]
    )).rows[0].count).toBe(1);
  });
});

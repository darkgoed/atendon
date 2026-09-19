import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { mergeLeads, normalizePhone, preflightLeadMerge } from "../src/modules/organization/lead-merge.js";

// B5 Merge de contatos: integração dos módulos de merge contra o banco de
// teste. Pool direto, tenant por arquivo, NUNCA registrar plugin — as rotas
// em app.ts são do orquestrador. Regras da spec: mesmo telefone normalizado
// = fluxo normal; telefone diferente SÓ com confirmação explícita; JAMAIS
// merge por nome; transação única preserva o histórico e soft-deleta o source.

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

let tenantId = "";
let foreignTenantId = "";
let sessionId = "";
let actorUserId = "";
let conflictStageId = "";
let phoneSequence = 0;

const actor = { userId: "", actorScope: "workspace" as const };
const nextPhone = () => `551196${String(++phoneSequence).padStart(6, "0")}`;

async function createLead(
  tenant: string,
  phone: string,
  options: { name?: string; stageId?: string } = {}
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,interest_category_id,unit_id,status,source,pipeline_stage_id
     ) VALUES($1,$2,$3,'merge-category','merge-unit','em_atendimento','merge-test',$4::uuid)
     RETURNING id`,
    [tenant, phone, options.name ?? `Lead ${phone}`, options.stageId ?? null]
  )).rows[0].id;
}

async function createConversation(
  tenant: string,
  session: string,
  leadId: string,
  phone: string
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,status,lead_id)
     VALUES($1,$2,$3,$4,'open',$5) RETURNING id`,
    [tenant, session, phone, `Contato ${phone}`, leadId]
  )).rows[0].id;
}

async function createAppointment(leadId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
     VALUES($1,$2,'merge-unit','2036-05-10T10:00:00Z','2036-05-10T10:30:00Z','confirmado')
     RETURNING id`,
    [leadId, tenantId]
  )).rows[0].id;
}

async function addTag(leadId: string, name: string): Promise<string> {
  const tagId = (await pool.query<{ id: string }>(
    "INSERT INTO lead_tags(tenant_id,name,color) VALUES($1,$2,'#123456') RETURNING id",
    [tenantId, `${name} ${randomUUID().slice(0, 8)}`]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id) VALUES($1,$2,$3)",
    [tenantId, leadId, tagId]
  );
  return tagId;
}

async function tagAssignments(leadId: string): Promise<Array<{ tag_id: string }>> {
  return (await pool.query<{ tag_id: string }>(
    "SELECT tag_id FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 ORDER BY tag_id",
    [tenantId, leadId]
  )).rows;
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Lead merge ${randomUUID()}`]
  )).rows[0].id;
  foreignTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Lead merge foreign ${randomUUID()}`]
  )).rows[0].id;
  sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
    [tenantId]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
    [foreignTenantId]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    actorUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,name) VALUES($1,'active','Gestor Merge') RETURNING id",
      [`gestor-merge-${randomUUID()}@test.local`]
    )).rows[0].id;
    actor.userId = actorUserId;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'
       RETURNING id`,
      [tenantId, actorUserId]
    );
    for (const tenant of [tenantId, foreignTenantId]) {
      await client.query(
        `INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'merge-category','Merge category')
         ON CONFLICT DO NOTHING`,
        [tenant]
      );
      await client.query(
        `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
         VALUES($1,'merge-unit','Merge unit','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[])`,
        [tenant]
      );
    }
    // Segundo stage com o MESMO technical_status que o default do seed,
    // para exercitar o conflito de posição de pipeline.
    conflictStageId = (await client.query<{ id: string }>(
      `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status,is_default)
       VALUES($1,'Merge conflito','#654321',9,'em_atendimento',false)
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

beforeEach(async () => {
  const tenants = [tenantId, foreignTenantId];
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations WHERE tenant_id=ANY($1::uuid[])
     )`,
    [tenants]
  );
  await pool.query("DELETE FROM conversations WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM tasks WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM internal_notes WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM scheduling_lead_notes WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM lead_tag_assignments WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM lead_tags WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query(
    `DELETE FROM lead_custom_values cv USING custom_field_defs fd
     WHERE cv.field_id=fd.id AND fd.tenant_id=ANY($1::uuid[])`,
    [tenants]
  );
  await pool.query("DELETE FROM custom_field_defs WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=ANY($1::uuid[])", [tenants]);
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=ANY($1::uuid[]) OR actor_user_id=$2", [
    [tenantId, foreignTenantId],
    actorUserId
  ]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE id=$1", [actorUserId]);
  await pool.end();
});

describe("merge preflight", () => {
  it("counts conflicts from the source lead and compares normalized phones", async () => {
    // Cenário real: dois contatos com telefones DIFERENTES (mesma pessoa),
    // consolidação proposta pelo operador — nunca automática por nome.
    const sourcePhone = nextPhone();
    const target = await createLead(tenantId, nextPhone());
    const source = await createLead(tenantId, sourcePhone);
    expect(normalizePhone(sourcePhone)).toBe(sourcePhone);

    const conversationA = await createConversation(tenantId, sessionId, source, sourcePhone);
    await createConversation(tenantId, sessionId, source, nextPhone());
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','Histórico preservado')",
      [conversationA]
    );
    await pool.query(
      "INSERT INTO tasks(tenant_id,title,created_by,lead_id) VALUES($1,'Ligar de volta',$2,$3)",
      [tenantId, actorUserId, source]
    );
    await addTag(source, "Quente");
    await pool.query(
      "INSERT INTO scheduling_lead_notes(tenant_id,lead_id,author_user_id,content) VALUES($1,$2,$3,'Nota do lead')",
      [tenantId, source, actorUserId]
    );
    await pool.query(
      `INSERT INTO internal_notes(tenant_id,context_type,context_id,author_id,body)
       VALUES($1,'lead',$2,$3,'Nota interna')`,
      [tenantId, source, actorUserId]
    );
    const fieldId = (await pool.query<{ id: string }>(
      `INSERT INTO custom_field_defs(tenant_id,entity,key,label,type)
       VALUES($1,'lead','empresa','Empresa','text') RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO lead_custom_values(field_id,lead_id,value) VALUES($1,$2,$3::jsonb)",
      [fieldId, source, JSON.stringify("ACME")]
    );
    await createAppointment(source);

    const preflight = await preflightLeadMerge(tenantId, source, target);
    expect(preflight).toEqual({
      source_id: source,
      target_id: target,
      same_normalized_phone: false,
      conflicts: {
        conversations: 2,
        tasks: 1,
        tags: 1,
        pipeline_positions: 0,
        notes: 2,
        custom_fields: 1,
        appointments: 1
      }
    });

    // Alvo com telefone diferente: pré-voo marca a divergência.
    const otherTarget = await createLead(tenantId, nextPhone(), { stageId: conflictStageId });
    const mismatched = await preflightLeadMerge(tenantId, source, otherTarget);
    expect(mismatched.same_normalized_phone).toBe(false);
    // Conflito de posição de pipeline (stages distintos) é contado.
    expect(mismatched.conflicts.pipeline_positions).toBe(1);
  });

  it("returns 404 when a contact is outside the tenant", async () => {
    const foreignLead = await createLead(foreignTenantId, nextPhone());
    const localLead = await createLead(tenantId, nextPhone());
    await expect(preflightLeadMerge(tenantId, foreignLead, localLead))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(preflightLeadMerge(tenantId, localLead, foreignLead))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("merge execution", () => {
  it("merges with explicit confirmation, moves every FK and preserves conversation history", async () => {
    const sourcePhone = nextPhone();
    const target = await createLead(tenantId, nextPhone(), { name: "Principal" });
    const source = await createLead(tenantId, sourcePhone, { name: "Duplicado" });

    const conversationId = await createConversation(tenantId, sessionId, source, sourcePhone);
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','Mensagem 1'),($2,'agent','Mensagem 2')",
      [conversationId, conversationId]
    );
    await pool.query(
      "INSERT INTO tasks(tenant_id,title,created_by,lead_id) VALUES($1,'Follow up',$2,$3)",
      [tenantId, actorUserId, source]
    );
    await addTag(source, "Novo");
    await createAppointment(source);

    const result = await mergeLeads(tenantId, { sourceId: source, targetId: target, confirmations: { different_phone: true } }, actor);
    expect(result.source).toMatchObject({ id: source, merged_into_id: target });
    expect(result.source.deleted_at).not.toBeNull();
    expect(result.target).toMatchObject({ id: target });
    expect(result.same_normalized_phone).toBe(false);
    expect(result.moved).toMatchObject({
      conversations: 1,
      tasks: 1,
      appointments: 1,
      lead_events: expect.any(Number),
      post_sales: 0
    });

    const moved = (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND lead_id=$2) conversations_on_target,
         (SELECT count(*)::int FROM tasks WHERE tenant_id=$1 AND lead_id=$2) tasks_on_target,
         (SELECT count(*)::int FROM messages WHERE conversation_id=$4) messages_kept,
         (SELECT count(*)::int FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2) appointments_on_target,
         (SELECT deleted_at IS NOT NULL AND merged_into_id=$2 FROM scheduling_leads WHERE id=$3) source_soft_deleted,
         (SELECT deleted_at IS NULL AND merged_into_id IS NULL FROM scheduling_leads WHERE id=$2) target_alive`,
      [tenantId, target, source, conversationId]
    )).rows[0];
    expect(moved).toEqual({
      conversations_on_target: 1,
      tasks_on_target: 1,
      messages_kept: 2,
      appointments_on_target: 1,
      source_soft_deleted: true,
      target_alive: true
    });

    const audit = (await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
       WHERE workspace_id=$1 AND action='leads.merged' AND resource_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, target]
    )).rows[0];
    expect(audit.metadata).toMatchObject({
      source_id: source,
      target_id: target,
      same_normalized_phone: false
    });
  });

  it("refuses different phones without explicit confirmation", async () => {
    const source = await createLead(tenantId, nextPhone());
    const target = await createLead(tenantId, nextPhone());

    await expect(mergeLeads(tenantId, { sourceId: source, targetId: target }, actor))
      .rejects.toMatchObject({ statusCode: 400, code: "PHONE_MISMATCH" });
    // Nada mudou no source (nome igual NÃO autoriza merge — JAMAIS por nome).
    const state = (await pool.query<{ merged_into_id: string | null; deleted_at: string | null }>(
      "SELECT merged_into_id,deleted_at FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, source]
    )).rows[0];
    expect(state).toEqual({ merged_into_id: null, deleted_at: null });

    // Confirmação explícita destrava o fluxo entre contatos distintos.
    const confirmed = await mergeLeads(tenantId, {
      sourceId: source,
      targetId: target,
      confirmations: { different_phone: true }
    }, actor);
    expect(confirmed.source.merged_into_id).toBe(target);
    expect(confirmed.same_normalized_phone).toBe(false);
  });

  it("resolves destination conflicts with target-wins and keeps the target stage", async () => {
    const target = await createLead(tenantId, nextPhone(), { stageId: conflictStageId });
    const source = await createLead(tenantId, nextPhone());
    const sharedTag = await addTag(target, "Comum"); // target já tem a etiqueta
    await pool.query(
      "INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id) VALUES($1,$2,$3)",
      [tenantId, source, sharedTag]
    );
    const exclusiveTag = await addTag(source, "Exclusiva");

    const preflight = await preflightLeadMerge(tenantId, source, target);
    expect(preflight.conflicts.pipeline_positions).toBe(1);

    await mergeLeads(tenantId, { sourceId: source, targetId: target, confirmations: { different_phone: true } }, actor);
    const finalTags = (await tagAssignments(target)).map((row) => row.tag_id).sort();
    expect(finalTags).toEqual([exclusiveTag, sharedTag].sort()); // sem duplicar "Comum"
    expect(await tagAssignments(source)).toEqual([]);
    expect((await pool.query<{ pipeline_stage_id: string }>(
      "SELECT pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, target]
    )).rows[0].pipeline_stage_id).toBe(conflictStageId);
  });

  it("rejects merging an already merged source", async () => {
    const target = await createLead(tenantId, nextPhone());
    const source = await createLead(tenantId, nextPhone());
    await mergeLeads(tenantId, { sourceId: source, targetId: target, confirmations: { different_phone: true } }, actor);
    const secondTarget = await createLead(tenantId, nextPhone());
    await expect(mergeLeads(tenantId, { sourceId: source, targetId: secondTarget }, actor))
      .rejects.toMatchObject({ statusCode: 409, code: "LEAD_ALREADY_MERGED" });
    await expect(mergeLeads(tenantId, { sourceId: secondTarget, targetId: secondTarget }, actor))
      .rejects.toMatchObject({ statusCode: 400, message: "Selecione dois contatos diferentes" });
  });

  it("never merges across tenants", async () => {
    const foreignLead = await createLead(foreignTenantId, nextPhone());
    const localTarget = await createLead(tenantId, nextPhone());
    await expect(mergeLeads(tenantId, { sourceId: foreignLead, targetId: localTarget }, actor))
      .rejects.toMatchObject({ statusCode: 404 });
    const untouched = (await pool.query<{ merged_into_id: string | null; deleted_at: string | null }>(
      "SELECT merged_into_id,deleted_at FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [foreignTenantId, foreignLead]
    )).rows[0];
    expect(untouched).toEqual({ merged_into_id: null, deleted_at: null });
  });
});

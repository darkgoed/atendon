// Múltiplos pipelines por empresa (0184 + organization): estado inicial limpo,
// isolamento entre pipelines e entre empresas, reordenação de etapas,
// duplicação, canal → pipeline de entrada, mudança de pipeline e automação.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID().slice(0, 8);
const emailA = `multi-pipe-a-${suffix}@test.local`;
const emailB = `multi-pipe-b-${suffix}@test.local`;
let tenantA = "";
let tenantB = "";
let userA = "";
let userB = "";
let cookieA = "";
let cookieB = "";

type Stage = { id: string; name: string; position: number; pipeline_id: string; technical_status: string };

async function setupTenant(client: pg.PoolClient, slug: string, email: string) {
  const tenantId = (await client.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug]
  )).rows[0].id;
  await ensureWorkspaceDefaultRoles(client, tenantId);
  const userId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [email])).rows[0].id;
  await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
    [tenantId, userId]
  );
  await client.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
     VALUES($1,'case_organization_v1',true),($1,'leads_v1',true),($1,'pipeline_v1',true)
     ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`,
    [tenantId]
  );
  return { tenantId, userId };
}

async function inject(cookie: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function stagesOf(cookie: string, pipelineId: string): Promise<Stage[]> {
  const response = await inject(cookie, "GET", `/organization/pipeline?pipeline_id=${pipelineId}`);
  expect(response.statusCode).toBe(200);
  return response.json().stages;
}

beforeAll(async () => {
  // app.ready() registra todas as rotas; em máquina carregada passa de 10s.
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    ({ tenantId: tenantA, userId: userA } = await setupTenant(client, `clean-multi-a-${suffix}`, emailA));
    ({ tenantId: tenantB, userId: userB } = await setupTenant(client, `clean-multi-b-${suffix}`, emailB));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  cookieA = `atendon_session=${await createSessionToken({ userId: userA, tenantId: tenantA, email: emailA, role: "OWNER" })}`;
  cookieB = `atendon_session=${await createSessionToken({ userId: userB, tenantId: tenantB, email: emailB, role: "OWNER" })}`;
}, 60_000);

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[userA, userB]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[userA, userB]]);
  await pool.end();
  await app.close();
});

// Integração com banco compartilhado: cada passo faz várias requisições.
describe("múltiplos pipelines por empresa", { timeout: 30_000 }, () => {
  let boleto = "";
  let avista = "";

  it("empresa nova começa crua: 1 Pipeline padrão com só Primeiro contato", async () => {
    const list = await inject(cookieA, "GET", "/organization/pipelines");
    expect(list.statusCode).toBe(200);
    const pipelines = list.json().pipelines;
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({ name: "Pipeline padrão", is_default: true, stage_count: 1 });
    const stages = await stagesOf(cookieA, pipelines[0].id);
    expect(stages.map((stage) => stage.name)).toEqual(["Primeiro contato"]);
    expect((await pool.query("SELECT count(*)::int n FROM pipeline_transitions WHERE tenant_id=$1", [tenantA])).rows[0].n).toBe(0);
  });

  it("cria pipelines independentes com etapas de mesmo nome e reordena por lista de ids", async () => {
    const created = await inject(cookieA, "POST", "/organization/pipelines", { name: "Boleto", color: "#3B82F6" });
    expect(created.statusCode).toBe(201);
    boleto = created.json().pipeline.id;
    avista = (await inject(cookieA, "POST", "/organization/pipelines", { name: "À Vista" })).json().pipeline.id;
    expect((await inject(cookieA, "POST", "/organization/pipelines", { name: "boleto" })).statusCode).toBe(409);

    for (const name of ["Qualificação", "Análise", "Emissão do boleto"]) {
      expect((await inject(cookieA, "POST", "/organization/pipeline/stages", { pipeline_id: boleto, name, color: "#14B8A6" })).statusCode).toBe(201);
    }
    expect((await inject(cookieA, "POST", "/organization/pipeline/stages", { pipeline_id: avista, name: "Qualificação", color: "#14B8A6" })).statusCode).toBe(201);

    const before = await stagesOf(cookieA, boleto);
    expect(before.map((stage) => stage.name)).toEqual(["Primeiro contato", "Qualificação", "Análise", "Emissão do boleto"]);
    const reversed = [before[0].id, before[3].id, before[2].id, before[1].id];
    const reorder = await inject(cookieA, "PUT", `/organization/pipelines/${boleto}/stages/order`, { stage_ids: reversed });
    expect(reorder.statusCode).toBe(200);
    expect((await stagesOf(cookieA, boleto)).map((stage) => stage.id)).toEqual(reversed);
    // Conjunto incompleto ou com etapa de outro pipeline → 400.
    expect((await inject(cookieA, "PUT", `/organization/pipelines/${boleto}/stages/order`, { stage_ids: reversed.slice(1) })).statusCode).toBe(400);
    const avistaStages = await stagesOf(cookieA, avista);
    expect((await inject(cookieA, "PUT", `/organization/pipelines/${boleto}/stages/order`, { stage_ids: [...reversed.slice(1), avistaStages[0].id] })).statusCode).toBe(400);
    // O outro pipeline não foi tocado.
    expect(avistaStages.map((stage) => stage.name)).toEqual(["Primeiro contato", "Qualificação"]);
  });

  it("arquivar etapa de um pipeline não afeta o outro; última etapa não pode sair", async () => {
    const boletoStages = await stagesOf(cookieA, boleto);
    const analise = boletoStages.find((stage) => stage.name === "Análise")!;
    expect((await inject(cookieA, "POST", `/organization/pipeline/stages/${analise.id}/archive`, {})).statusCode).toBe(200);
    expect((await stagesOf(cookieA, boleto)).some((stage) => stage.name === "Análise")).toBe(false);
    expect((await stagesOf(cookieA, avista)).map((stage) => stage.name)).toEqual(["Primeiro contato", "Qualificação"]);

    const lonely = (await inject(cookieA, "POST", "/organization/pipelines", { name: "Solo" })).json().pipeline.id;
    const [only] = await stagesOf(cookieA, lonely);
    expect((await inject(cookieA, "POST", `/organization/pipeline/stages/${only.id}/archive`, {})).statusCode).toBe(409);
  });

  it("duplica pipeline com etapas de ids novos, sem canais e sem contatos", async () => {
    const duplicated = await inject(cookieA, "POST", `/organization/pipelines/${boleto}/duplicate`, {});
    expect(duplicated.statusCode).toBe(201);
    const copy = duplicated.json().pipeline;
    expect(copy).toMatchObject({ name: "Boleto (cópia)", is_default: false });
    const original = await stagesOf(cookieA, boleto);
    const copied = await stagesOf(cookieA, copy.id);
    expect(copied.map((stage) => stage.name)).toEqual(original.map((stage) => stage.name));
    expect(copied.some((stage) => original.some((source) => source.id === stage.id))).toBe(false);
    // Renomear etapa da cópia não altera o original.
    expect((await inject(cookieA, "PATCH", `/organization/pipeline/stages/${copied[1].id}`, { name: "Renomeada" })).statusCode).toBe(200);
    expect((await stagesOf(cookieA, boleto)).map((stage) => stage.name)).toEqual(original.map((stage) => stage.name));
  });

  it("canal vinculado: nova conversa entra na 1ª etapa do pipeline do canal", async () => {
    const session = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'WhatsApp Boleto','connected') RETURNING id", [tenantA]
    )).rows[0].id;
    const linked = await inject(cookieA, "PUT", `/organization/pipelines/${boleto}/channels`, { session_ids: [session] });
    expect(linked.statusCode).toBe(200);
    const listed = (await inject(cookieA, "GET", "/organization/pipelines")).json();
    expect(listed.pipelines.find((pipeline: { id: string }) => pipeline.id === boleto).channel_ids).toEqual([session]);
    expect(listed.channels.find((channel: { id: string }) => channel.id === session)).toMatchObject({ pipeline_id: boleto });

    const phone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, session, phone]);
    const lead = (await pool.query<{ pipeline_stage_id: string }>(
      "SELECT pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2", [tenantA, phone]
    )).rows[0];
    expect(lead.pipeline_stage_id).toBe((await stagesOf(cookieA, boleto))[0].id);
    // Canal de outra empresa → 400.
    const foreignSession = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Outro','connected') RETURNING id", [tenantB]
    )).rows[0].id;
    expect((await inject(cookieA, "PUT", `/organization/pipelines/${boleto}/channels`, { session_ids: [foreignSession] })).statusCode).toBe(400);
  });

  it("move contato para outro pipeline (evento pipeline_changed) e aplica automação da etapa", async () => {
    const tag = (await pool.query<{ id: string }>(
      "INSERT INTO lead_tags(tenant_id,name,color) VALUES($1,'Vista','#22C55E') RETURNING id", [tenantA]
    )).rows[0].id;
    const target = (await stagesOf(cookieA, avista)).find((stage) => stage.name === "Qualificação")!;
    expect((await inject(cookieA, "PATCH", `/organization/pipeline/stages/${target.id}`, { automation: { add_tag_ids: [tag] } })).statusCode).toBe(200);

    const leadId = (await pool.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Lead mover','test') RETURNING id",
      [tenantA, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
    )).rows[0].id;
    const moved = await inject(cookieA, "PATCH", `/organization/leads/${leadId}/stage`, { stage_id: target.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().lead.pipeline_stage_id).toBe(target.id);
    expect((await pool.query(
      "SELECT 1 FROM scheduling_lead_events WHERE lead_id=$1 AND event_type='pipeline_changed' AND details->>'new_pipeline_id'=$2", [leadId, avista]
    )).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM lead_tag_assignments WHERE lead_id=$1 AND tag_id=$2", [leadId, tag])).rowCount).toBe(1);
  });

  it("isolamento entre empresas: B recebe 404 em pipeline e etapa de A", async () => {
    const stageOfA = (await stagesOf(cookieA, boleto))[0];
    expect((await inject(cookieB, "GET", `/organization/pipeline?pipeline_id=${boleto}`)).statusCode).toBe(404);
    expect((await inject(cookieB, "PATCH", `/organization/pipelines/${boleto}`, { name: "Invadido" })).statusCode).toBe(404);
    expect((await inject(cookieB, "POST", `/organization/pipelines/${boleto}/duplicate`, {})).statusCode).toBe(404);
    expect((await inject(cookieB, "PATCH", `/organization/pipeline/stages/${stageOfA.id}`, { name: "Invadido" })).statusCode).toBe(404);
    expect((await inject(cookieB, "POST", "/organization/pipeline/stages", { pipeline_id: boleto, name: "X", color: "#111111" })).statusCode).toBe(404);
    const listB = (await inject(cookieB, "GET", "/organization/pipelines")).json().pipelines;
    expect(listB.map((pipeline: { name: string }) => pipeline.name)).toEqual(["Pipeline padrão"]);
  });

  it("excluir pipeline exige substituto quando há contatos; o último pipeline não pode sair", async () => {
    const needsReplacement = await inject(cookieA, "POST", `/organization/pipelines/${avista}/archive`, {});
    expect(needsReplacement.statusCode).toBe(409);
    const archived = await inject(cookieA, "POST", `/organization/pipelines/${avista}/archive`, { replacement_pipeline_id: boleto });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().moved_leads).toBeGreaterThan(0);

    const [onlyB] = (await inject(cookieB, "GET", "/organization/pipelines")).json().pipelines;
    expect((await inject(cookieB, "POST", `/organization/pipelines/${onlyB.id}/archive`, {})).statusCode).toBe(409);
  });
});

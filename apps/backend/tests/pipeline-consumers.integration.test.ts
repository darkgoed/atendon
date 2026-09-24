// B2 — Consumidores do pipeline fora de organization: filtro pipeline_id na
// listagem de leads (JSON de etapa carrega pipeline_id), lead automático
// gravando origin_session_id (entra no pipeline do canal) e stage_move do
// fluxo de robô sem amarra technical_status = lead.status.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantId = "";
let foreignTenantId = "";
let sessionId = "";
let foreignSessionId = "";
let otherPipelineId = "";
let defaultPipelineId = "";
let entryStageOfOther = "";
let entryStageOfDefault = "";
let cookie = "";
let testEmails: string[] = [];

const service = new QualificationService();
const messages = new MessageRepository(pool, config);

// Fluxo mínimo com uma action stage_move para uma etapa de comportamento
// DIFERENTE do status atual do lead — proíbe a amarra antiga s.technical_status=l.status.
function robotFlow(stageId: string) {
  return {
    start: "M1",
    origem: "facebook",
    triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
    steps: {
      M1: { kind: "message", message: "Oi!", next: "A_MOVE" },
      A_MOVE: { kind: "action", action_type: "stage_move", stage_id: stageId, next: "F1" },
      F1: { kind: "final", message: "Pronto." }
    }
  };
}

async function loginCookie(email: string, password: string) {
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  return (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Pipeline consumers ${suffix}`]
  )).rows[0].id;
  foreignTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Pipeline consumers foreign ${suffix}`]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId, foreignTenantId]);

  defaultPipelineId = (await pool.query<{ id: string }>(
    "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL", [tenantId]
  )).rows[0].id;
  // Segundo pipeline do tenant com a própria etapa de entrada ("Entrada").
  otherPipelineId = (await pool.query<{ id: string }>(
    `INSERT INTO pipelines(tenant_id,name,position) VALUES($1,'Pipeline Vendas',1) RETURNING id`,
    [tenantId]
  )).rows[0].id;
  entryStageOfOther = (await pool.query<{ id: string }>(
    `INSERT INTO pipeline_stages(tenant_id,pipeline_id,name,color,position,technical_status,is_default)
     VALUES($1,$2,'Entrada','#64748B',0,'novo',true) RETURNING id`,
    [tenantId, otherPipelineId]
  )).rows[0].id;
  entryStageOfDefault = (await pool.query<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL ORDER BY position,id LIMIT 1",
    [tenantId, defaultPipelineId]
  )).rows[0].id;

  sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_sessions(tenant_id,status,pipeline_id) VALUES($1,'connected',$2) RETURNING id`,
    [tenantId, otherPipelineId]
  )).rows[0].id;
  foreignSessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
    [foreignTenantId]
  )).rows[0].id;

  const email = `pipeline-consumers-${suffix}@test.local`;
  const password = "pipeline-consumers-password";
  testEmails = [email];
  const { hash } = await import("bcryptjs");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const passwordHash = await hash(password, 4);
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [email, passwordHash]
    )).rows[0];
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId, user.id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  cookie = await loginCookie(email, password);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("consumidores do pipeline múltiplo", () => {
  it("GET /scheduling/leads?pipeline_id= retorna só leads do pipeline e o JSON da etapa carrega pipeline_id", async () => {
    const phone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const leadInOther = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,pipeline_stage_id,origin_session_id)
       VALUES($1,$2,'Lead Vendas','whatsapp',$3,$4) RETURNING id`,
      [tenantId, phone, entryStageOfOther, sessionId]
    )).rows[0].id;
    const leadInDefault = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,pipeline_stage_id)
       VALUES($1,$2,'Lead Padrão','whatsapp',$3) RETURNING id`,
      [tenantId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, entryStageOfDefault]
    )).rows[0].id;
    // Lead do pipeline Vendas na empresa de fora — nunca pode vazar.
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,pipeline_stage_id)
       VALUES($1,$2,'Lead Outro','whatsapp',$3)`,
      [foreignTenantId, `5521${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, entryStageOfOther]
    ).catch(() => undefined);

    const response = await app.inject({ method: "GET", url: `/scheduling/leads?pipeline_id=${otherPipelineId}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ leads: Array<{ id: string; pipeline_stage: { id: string; pipeline_id: string } }> }>();
    expect(body.leads.map((lead) => lead.id)).toEqual([leadInOther]);
    expect(body.leads[0].pipeline_stage.pipeline_id).toBe(otherPipelineId);

    const total = response.json<{ total: number }>().total;
    expect(total).toBe(1);
    expect(leadInDefault).toBeTruthy();
  });

  it("pipeline_id de outra empresa → lista vazia", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/scheduling/leads?pipeline_id=${(await pool.query<{ id: string }>(
        "SELECT id FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL", [foreignTenantId]
      )).rows[0].id}`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ leads: unknown[] }>().leads).toEqual([]);
  });

  it("lead automático numa sessão vinculada a pipeline não-padrão entra na 1ª etapa desse pipeline", async () => {
    const phone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const context = await messages.recordInboundAndLoadContext({
      externalId: `inbound-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone: phone,
      text: "Olá, quero saber mais"
    });
    expect(context).not.toBeNull();
    const lead = (await pool.query<{ id: string; pipeline_stage_id: string; origin_session_id: string }>(
      `SELECT id,pipeline_stage_id,origin_session_id FROM scheduling_leads
       WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')`,
      [tenantId, phone]
    )).rows[0];
    expect(lead).toBeTruthy();
    expect(lead.origin_session_id).toBe(sessionId);
    expect(lead.pipeline_stage_id).toBe(entryStageOfOther);
  });

  it("stage_move do fluxo move para etapa de comportamento diferente do status do lead", async () => {
    // Etapa de comportamento 'agendado' no pipeline Vendas: status do lead ('novo') ≠ comportamento.
    const scheduledStage = (await pool.query<{ id: string }>(
      `INSERT INTO pipeline_stages(tenant_id,pipeline_id,name,color,position,technical_status)
       VALUES($1,$2,'Reunião agendada','#8B5CF6',5,'agendado') RETURNING id`,
      [tenantId, otherPipelineId]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,'robot-pipe','Robô Pipeline',true,$2)",
      [tenantId, robotFlow(scheduledStage)]
    );
    const phone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    // Conversa pré-criada (mesma pré-condição dos testes de fluxo existentes).
    await pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)",
      [tenantId, sessionId, phone]
    );
    // O trigger link_conversation_to_lead cria o lead (origem = canal → pipeline Vendas).
    expect((await pool.query<{ pipeline_stage_id: string }>(
      "SELECT pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2", [tenantId, phone]
    )).rows[0]?.pipeline_stage_id).toBe(entryStageOfOther);
    const started = await service.handleInbound({
      tenantId,
      sessionId,
      contactPhone: phone,
      text: "robo",
      externalId: `ext-${randomUUID()}`
    });
    expect(started?.reply).toBe("Oi!");
    const lead = (await pool.query<{ pipeline_stage_id: string; status: string }>(
      `SELECT pipeline_stage_id,status FROM scheduling_leads
       WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')`,
      [tenantId, phone]
    )).rows[0];
    expect(lead.pipeline_stage_id).toBe(scheduledStage);
    expect(lead.status).toBe("novo");
  });
});

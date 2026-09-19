// ONDA 2-B (SPEC v7) — B1 Reports: agregações (volume com pending via última
// mensagem do contato, produtividade, status-flow, quality), janela padrão de
// 30 dias, escopo do operador, tenancy (2 tenants), export CSV dos 4 tipos e
// 403 para role sem dashboard.read (OPERADOR TEM dashboard.read).
// app.ts é do orquestrador (fora de escopo): o app de teste registra o plugin
// de rotas + @fastify/cookie, o mesmo conjunto que app.ts usa.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { registerReportsRoutes } from "../src/modules/reports/routes.js";
import { shiftDateKey } from "../src/modules/reporting.js";
import { localDateKey } from "../src/timezone.js";
import { config } from "../src/config.js";

const password = "reports-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const app = Fastify({ logger: false });
// Handler ANTES do register: plugins encapsulados não herdam um setErrorHandler
// registrado depois (Fastify resolve o errorHandler no encapsulamento).
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({ error: error.issues[0]?.message ?? "Payload inválido" });
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.register(cookie);
await app.register(registerReportsRoutes);
await app.ready();

type Row = { id: string };
let tenantA = "";
let tenantB = "";
let ownerA = "";
let operatorA = "";
let noReportsA = "";
let ownerB = "";
let sessionA = "";
let sessionB = "";
let stageS1 = "";
let stageS2 = "";
let convAwaiting = "";
let phoneAwaiting = "";
let phoneAwaitingB = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

// Datas ancoradas no setup (UTC): D1 = hoje, D0 = ontem, D2 = amanhã. Janelas
// explícitas cobrem todos os fixtures — mudança de dia no meio do teste não
// altera os valores (o teste de janela padrão usa o "agora" da requisição).
let D0 = "";
let D1 = "";
let D2 = "";

async function loginAs(userId: string, tenantId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = emails.get(userId)!;
  const token = await createSessionToken({
    userId,
    tenantId,
    email,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
}

async function get(userId: string, tenantId: string, url: string, query?: Record<string, string>) {
  return app.inject({
    method: "GET",
    url,
    query,
    headers: { cookie: await loginAs(userId, tenantId) }
  });
}

async function leadFixture(
  client: pg.PoolClient,
  tenantId: string,
  values: { status: string; stageId?: string | null; createdAt: string }
): Promise<string> {
  const sequence = (await client.query<{ n: string }>("SELECT count(*)+1 n FROM scheduling_leads WHERE tenant_id=$1", [tenantId])).rows[0].n;
  const phone = `55119000${sequence.padStart(4, "0")}`; // CHECK exige dígitos (sem hex de UUID)
  return (await client.query<Row>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,pipeline_stage_id,created_at)
     VALUES($1,$2,$3,'whatsapp',$4,$5,$6) RETURNING id`,
    [tenantId, phone, `Lead ${sequence}`, values.status, values.stageId ?? null, values.createdAt]
  )).rows[0].id;
}

async function conversationFixture(
  client: pg.PoolClient,
  tenantId: string,
  sessionId: string,
  leadId: string,
  phone: string,
  assigned: string | null,
  createdAt: string,
  status: "open" | "closed",
  resolvedAt: string | null = null
): Promise<string> {
  return (await client.query<Row>(
    `INSERT INTO conversations(tenant_id,session_id,lead_id,contact_phone,contact_name,assigned_user_id,created_at,last_message_at,status,resolved_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id`,
    [tenantId, sessionId, leadId, phone, "Contato", assigned, createdAt, status, resolvedAt]
  )).rows[0].id;
}

async function messageFixture(
  client: pg.PoolClient,
  conversationId: string,
  sender: "contact" | "agent",
  sentBy: string | null,
  createdAt: string
): Promise<void> {
  await client.query(
    "INSERT INTO messages(conversation_id,sender,content,sent_by_user_id,created_at) VALUES($1,$2,$3,$4,$5)",
    [conversationId, sender, `msg ${createdAt}`, sentBy, createdAt]
  );
}

beforeAll(async () => {
  const today = localDateKey(new Date(), "UTC");
  D0 = shiftDateKey(today, -1);
  D1 = today;
  D2 = shiftDateKey(today, 1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Reports A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Reports B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);

    const createUser = async (tenantId: string, role: string, name: string) => {
      const email = `reports-${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}@test.local`;
      const user = (await client.query<Row>(
        "INSERT INTO users(email,name,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id",
        [email, name, await hash(password, 4)]
      )).rows[0].id;
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
        [tenantId, user, role]
      );
      emails.set(user, email);
      return user;
    };

    ownerA = await createUser(tenantA, "OWNER", "Owner A");
    operatorA = await createUser(tenantA, "OPERADOR", "Operadora Ana");
    ownerB = await createUser(tenantB, "OWNER", "Owner B");

    // Role custom SEM dashboard.read (403 no requirePermission).
    await client.query(
      `INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
       VALUES($1,'SEM_RELATORIOS','sem dashboard.read',false,false)`,
      [tenantA]
    );
    noReportsA = await createUser(tenantA, "SEM_RELATORIOS", "Sem Relatorio");

    sessionA = (await client.query<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA])).rows[0].id;
    sessionB = (await client.query<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantB])).rows[0].id;

    stageS1 = (await client.query<Row>(
      `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status)
       VALUES($1,'Negociação','#2563eb',0,'em_negociacao') RETURNING id`,
      [tenantA]
    )).rows[0].id;
    // 'Agendado' já nasce com o tenant (trigger de seed 0098); reutilizá-la,
    // um INSERT repetido viola uq_pipeline_stages_active_name.
    stageS2 = (await client.query<Row>(
      `SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='agendado' AND archived_at IS NULL LIMIT 1`,
      [tenantA]
    )).rows[0].id;

    // ---- tenant A ----
    const lead1 = await leadFixture(client, tenantA, { status: "em_negociacao", stageId: stageS1, createdAt: `${D1}T09:00:00.000Z` });
    convAwaiting = await conversationFixture(client, tenantA, sessionA, lead1, `5511800000001`, operatorA, `${D1}T10:00:00.000Z`, "open");
    phoneAwaiting = "5511800000001";
    // contato → agente responde (primeira resposta 120s) → contato fala por último (pending).
    await messageFixture(client, convAwaiting, "contact", null, `${D1}T10:00:00.000Z`);
    await messageFixture(client, convAwaiting, "agent", operatorA, `${D1}T10:02:00.000Z`);
    await messageFixture(client, convAwaiting, "contact", null, `${D1}T10:30:00.000Z`);

    const lead2 = await leadFixture(client, tenantA, { status: "agendado", createdAt: `${D1}T09:30:00.000Z` });
    const convClosed = await conversationFixture(client, tenantA, sessionA, lead2, "5511800000002", ownerA, `${D1}T10:00:00.000Z`, "closed", `${D1}T11:00:00.000Z`);

    const lead3 = await leadFixture(client, tenantA, { status: "qualificado", createdAt: `${D0}T08:00:00.000Z` });
    const convYesterday = await conversationFixture(client, tenantA, sessionA, lead3, "5511800000003", operatorA, `${D0}T09:00:00.000Z`, "open");
    await messageFixture(client, convYesterday, "agent", operatorA, `${D0}T09:30:00.000Z`);

    // Gargalo: lead entra em S1 (10:00) e sai para S2 (11:00) → 60 min em S1; S2 em curso.
    const leadBottleneck = await leadFixture(client, tenantA, { status: "agendado", stageId: stageS2, createdAt: `${D1}T09:00:00.000Z` });
    await client.query(
      `INSERT INTO scheduling_lead_events(tenant_id,lead_id,event_type,details,created_at)
       VALUES($1,$2,'agendamento_criado',jsonb_build_object('pipeline_stage_id',$3::text),$4)`,
      [tenantA, leadBottleneck, stageS1, `${D1}T10:00:00.000Z`]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(tenant_id,lead_id,event_type,details,created_at)
       VALUES($1,$2,'pipeline_stage_updated',jsonb_build_object('new_stage_id',$3::text),$4)`,
      [tenantA, leadBottleneck, stageS2, `${D1}T11:00:00.000Z`]
    );

    // Encerramento atribuído via auditoria existente ('conversation.resolved').
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,created_at)
       VALUES($1,$2,'workspace','conversation.resolved','conversation',$3,$4)`,
      [operatorA, tenantA, convClosed, `${D1}T11:00:00.000Z`]
    );

    // ---- tenant B (isolamento) ----
    const leadB = await leadFixture(client, tenantB, { status: "qualificado", createdAt: `${D1}T09:00:00.000Z` });
    const convB = await conversationFixture(client, tenantB, sessionB, leadB, "5511800000004", ownerB, `${D1}T10:00:00.000Z`, "open");
    phoneAwaitingB = "5511800000004";
    await messageFixture(client, convB, "contact", null, `${D1}T10:00:00.000Z`);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}, 120_000);

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

// LAZY: D0/D2 só existem após o beforeAll — capturar no load do módulo
// deixava from/to como strings vazias (400 em toda rota com query).
const windowQuery = { get from() { return D0; }, get to() { return D2; } };

describe("B1 — volume de conversas", () => {
  it("agrupa por dia com open/closed/pending (última mensagem do contato)", async () => {
    const response = await get(ownerA, tenantA, "/reports/conversation-volume", windowQuery);
    expect(response.statusCode).toBe(200);
    const points = response.json().points as Array<{ date: string; total: number; open: number; closed: number; pending: number }>;
    expect(points.map((point) => point.date)).toEqual([D0, D1, D2]);
    expect(points[0]).toEqual({ date: D0, total: 1, open: 1, closed: 0, pending: 0 });
    expect(points[1]).toEqual({ date: D1, total: 2, open: 1, closed: 1, pending: 1 });
    expect(points[2]).toEqual({ date: D2, total: 0, open: 0, closed: 0, pending: 0 });
  });

  it("janela padrão tem 30 dias contínuos (hoje → hoje-29)", async () => {
    const response = await get(ownerA, tenantA, "/reports/conversation-volume");
    expect(response.statusCode).toBe(200);
    const points = response.json().points as Array<{ date: string; total: number }>;
    expect(points).toHaveLength(30);
    const nowKey = localDateKey(new Date(), "UTC");
    expect(points[0].date).toBe(shiftDateKey(nowKey, -29));
    expect(points[29].date).toBe(nowKey);
    expect(points.reduce((total, point) => total + point.total, 0)).toBe(3);
  });
});

describe("B1 — produtividade de agentes", () => {
  it("answered/closed/messages_sent por membro ativo; closed via auditoria", async () => {
    const response = await get(ownerA, tenantA, "/reports/agent-productivity", windowQuery);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ user_id: string; name: string; answered: number; closed: number; messages_sent: number }>;
    const operator = items.find((item) => item.user_id === operatorA)!;
    expect(operator).toMatchObject({ answered: 2, closed: 1, messages_sent: 2 });
    const owner = items.find((item) => item.user_id === ownerA)!;
    expect(owner).toMatchObject({ answered: 0, closed: 0, messages_sent: 0 });
    // Ordenado por mensagens enviadas DESC: a operadora vem primeiro.
    expect(items[0].user_id).toBe(operatorA);
  });
});

describe("B1 — fluxo de status", () => {
  it("todos os status do catálogo com total e média de fechamento", async () => {
    const response = await get(ownerA, tenantA, "/reports/status-flow", windowQuery);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ status: string; total: number; avg_close_minutes: number | null }>;
    expect(items.map((item) => item.status)).toEqual([
      "novo", "em_atendimento", "aguardando_resposta", "qualificado", "agendado", "em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"
    ]);
    expect(items.find((item) => item.status === "em_negociacao")).toMatchObject({ total: 1, avg_close_minutes: null });
    expect(items.find((item) => item.status === "agendado")).toMatchObject({ total: 1, avg_close_minutes: 60 });
    expect(items.find((item) => item.status === "qualificado")).toMatchObject({ total: 1, avg_close_minutes: null });
    expect(items.find((item) => item.status === "perdido")).toMatchObject({ total: 0, avg_close_minutes: null });
  });
});

describe("B1 — qualidade", () => {
  it("ociosos, fila aguardando, primeira resposta por operador e gargalos de pipeline", async () => {
    const response = await get(ownerA, tenantA, "/reports/quality", windowQuery);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.from).toBe(D0);
    expect(body.to).toBe(D2);

    const idle = body.idle_agents as Array<{ user_id: string }>;
    expect(idle.map((item) => item.user_id)).toContain(ownerA);
    expect(idle.map((item) => item.user_id)).not.toContain(operatorA);

    expect(body.queue.count).toBe(1);
    expect(body.queue.items).toHaveLength(1);
    expect(body.queue.items[0].conversation_id).toBe(convAwaiting);
    expect(body.queue.items[0].contact.phone).toBe(phoneAwaiting);
    expect(body.queue.items[0].waiting_since_seconds).toBeGreaterThanOrEqual(0);

    expect(body.avg_first_response).toEqual([
      { user_id: operatorA, name: "Operadora Ana", seconds: 120 }
    ]);

    expect(body.bottlenecks).toHaveLength(2);
    expect(body.bottlenecks[0]).toEqual({
      pipeline_id: null, stage_id: stageS1, stage_name: "Negociação", contacts: 1, avg_minutes: 60
    });
    // contacts 2: lead2 (status 'agendado' sem etapa) cai no DEFAULT da
    // técnica — a mesma etapa seeded reutilizada pelo leadBottleneck.
    expect(body.bottlenecks[1]).toEqual({
      pipeline_id: null, stage_id: stageS2, stage_name: "Agendado", contacts: 2, avg_minutes: null
    });
  });
});

describe("B1 — escopo e tenancy", () => {
  it("operador (dashboard.read) vê apenas o próprio escopo", async () => {
    const volume = await get(operatorA, tenantA, "/reports/conversation-volume", windowQuery);
    expect(volume.statusCode).toBe(200);
    const points = volume.json().points as Array<{ date: string; total: number; pending: number }>;
    expect(points[1]).toEqual({ date: D1, total: 1, open: 1, closed: 0, pending: 1 });
    expect(points[0].total).toBe(1); // ontem: conversa atribuída à operadora

    const productivity = await get(operatorA, tenantA, "/reports/agent-productivity", windowQuery);
    const items = productivity.json().items as Array<{ user_id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].user_id).toBe(operatorA);

    const quality = await get(operatorA, tenantA, "/reports/quality", windowQuery);
    expect(quality.json().queue.items[0].conversation_id).toBe(convAwaiting);
  });

  it("tenant B não vê dados de A (volume, produtividade, fila, status)", async () => {
    const volume = await get(ownerB, tenantB, "/reports/conversation-volume", windowQuery);
    const points = volume.json().points as Array<{ date: string; total: number; pending: number }>;
    expect(points[1]).toEqual({ date: D1, total: 1, open: 1, closed: 0, pending: 1 });
    expect(points[0].total).toBe(0);

    const productivity = await get(ownerB, tenantB, "/reports/agent-productivity", windowQuery);
    const items = productivity.json().items as Array<{ user_id: string; answered: number }>;
    expect(items.map((item) => item.user_id)).toEqual([ownerB]);
    expect(items[0].answered).toBe(0);

    const quality = await get(ownerB, tenantB, "/reports/quality", windowQuery);
    expect(quality.json().queue.count).toBe(1);
    expect(quality.json().queue.items[0].contact.phone).toBe(phoneAwaitingB);
    // A fila de B não contém a conversa de A (e vice-versa).
    const qualityA = await get(ownerA, tenantA, "/reports/quality", windowQuery);
    expect(qualityA.json().queue.items.map((item: { contact: { phone: string } }) => item.contact.phone)).not.toContain(phoneAwaitingB);
    expect(quality.json().queue.items.map((item: { contact: { phone: string } }) => item.contact.phone)).not.toContain(phoneAwaiting);

    const status = await get(ownerB, tenantB, "/reports/status-flow", windowQuery);
    expect(status.json().items.find((item: { status: string }) => item.status === "qualificado")).toMatchObject({ total: 1 });
    expect(status.json().items.find((item: { status: string }) => item.status === "agendado")).toMatchObject({ total: 0 });
  });

  it("role sem dashboard.read recebe 403", async () => {
    const response = await get(noReportsA, tenantA, "/reports/conversation-volume", windowQuery);
    expect(response.statusCode).toBe(403);
    const quality = await get(noReportsA, tenantA, "/reports/quality", windowQuery);
    expect(quality.statusCode).toBe(403);
  });
});

describe("B1 — validação de payload", () => {
  it("400 para datas inválidas, janela invertida e query desconhecida", async () => {
    expect((await get(ownerA, tenantA, "/reports/conversation-volume", { from: "2026-13-99" })).statusCode).toBe(400);
    expect((await get(ownerA, tenantA, "/reports/conversation-volume", { from: D2, to: D0 })).statusCode).toBe(400);
    expect((await get(ownerA, tenantA, "/reports/conversation-volume", { from: D0, foo: "bar" })).statusCode).toBe(400);
    expect((await get(ownerA, tenantA, "/reports/export/csv", { type: "bogus" })).statusCode).toBe(400);
  });
});

describe("B1 — export CSV (4 tipos)", () => {
  it("volume: streaming text/csv com content-disposition e série completa", async () => {
    const response = await get(ownerA, tenantA, "/reports/export/csv", { type: "volume", ...windowQuery });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="volume-conversas-${D0}_a_${D2}.csv"`);
    expect(response.body).toBe(
      `data,total,abertas,fechadas,aguardando_resposta\n${D0},1,1,0,0\n${D1},2,1,1,1\n${D2},0,0,0,0\n`
    );
  });

  it("agents: operadores com valores da janela", async () => {
    const response = await get(ownerA, tenantA, "/reports/export/csv", { type: "agents", ...windowQuery });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("produtividade-agentes-");
    expect(response.body).toContain("operador,email,atendidas,encerradas,mensagens_enviadas");
    expect(response.body).toContain("Operadora Ana,reports-operadora-ana");
    expect(response.body).toContain(",2,1,2");
    expect(response.body).toContain("Owner A,reports-owner-a");
  });

  it("status: total e média por status", async () => {
    const response = await get(ownerA, tenantA, "/reports/export/csv", { type: "status", ...windowQuery });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("fluxo-status-");
    expect(response.body).toContain("status,total,media_fechamento_minutos");
    expect(response.body).toContain("qualificado,1,\n");
    expect(response.body).toContain("em_negociacao,1,\n");
    expect(response.body).toContain("agendado,1,60\n");
  });

  it("quality: seções fila, primeira resposta, gargalos e ociosos", async () => {
    const response = await get(ownerA, tenantA, "/reports/export/csv", { type: "quality", ...windowQuery });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("qualidade-");
    expect(response.body).toContain("fila_aguardando_resposta\n");
    expect(response.body).toContain("conversa,contato,telefone,aguardando_ha_segundos,ultima_mensagem_contato");
    expect(response.body).toContain("\nprimeira_resposta_por_operador\n");
    expect(response.body).toContain("Operadora Ana,120");
    expect(response.body).toContain("\ngargalos_pipeline\n");
    expect(response.body).toContain("Negociação,1,60");
    expect(response.body).toContain("\noperadores_ociosos\n");
    expect(response.body).toContain(`Owner A,reports-owner-a`);
  });
});

// ONDA 2-B (SPEC v7) — B9 Dashboard: os 3 keys novos no payload do dashboard
// comercial (queue_waiting, pipeline_bottlenecks, first_response_avg) e o
// contrato EXISTENTE dos widgets intocado.
// A rota /dashboard é do app.ts (orquestrador — não registrável em teste): os
// keys novos são exercitados chamando loadCommercialDashboard diretamente com
// a mesma WorkspaceSession que a rota monta; o contrato dos widgets usa
// registerDashboardWidgetRoutes + cookie (precisa da flag dashboard_widgets_v1).
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import type { WorkspaceSession } from "../src/auth/session.js";
import { registerDashboardWidgetRoutes } from "../src/modules/dashboard-widgets/routes.js";
import { loadCommercialDashboard } from "../src/modules/dashboard/service.js";
import { shiftDateKey } from "../src/modules/reporting.js";
import { localDateKey } from "../src/timezone.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(registerDashboardWidgetRoutes);
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({ error: error.issues[0]?.message ?? "Payload inválido" });
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.ready();

type Row = { id: string };
let tenantA = "";
let tenantB = "";
let ownerA = "";
let operatorA = "";
let ownerB = "";
let ownerRoleA = "";
let ownerRoleB = "";
let sessionA = "";
let stageS1 = "";
let stageS2 = "";
let convAwaiting = "";
let phoneAwaiting = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

let D0 = "";
let D1 = "";
let D2 = "";

function sessionFor(userId: string, tenantId: string, roleId: string): WorkspaceSession {
  return {
    userId,
    tenantId,
    email: emails.get(userId)!,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false,
    role: "OWNER",
    roleId,
    permissions: ["dashboard.read"],
    actorScope: "workspace"
  };
}

async function cookieFor(userId: string, tenantId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const token = await createSessionToken({
    userId,
    tenantId,
    email: emails.get(userId)!,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
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

beforeAll(async () => {
  const today = localDateKey(new Date(), "UTC");
  D0 = shiftDateKey(today, -1);
  D1 = today;
  D2 = shiftDateKey(today, 1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`DashKeys A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`DashKeys B ${randomUUID()}`])).rows[0].id;
    // Capabilities por tenant (dashboard_v1/leads_v1/appointments_v1).
    // dashboard_widgets_v1 NÃO entra aqui: é flag GLOBAL-ONLY
    // (GLOBAL_ONLY_FEATURE_FLAG_KEYS) — override por tenant é ignorado; o
    // teste de desligamento usa o kill switch global, não override.
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
         ($1,'dashboard_v1',true),($1,'leads_v1',true),($1,'appointments_v1',true)
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
      [tenantA]
    );
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerRoleA = (await client.query<Row>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantA])).rows[0].id;
    ownerRoleB = (await client.query<Row>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantB])).rows[0].id;

    const createUser = async (tenantId: string, role: string, name: string) => {
      const email = `dashkeys-${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}@test.local`;
      const user = (await client.query<Row>(
        "INSERT INTO users(email,name,status) VALUES($1,$2,'active') RETURNING id",
        [email, name]
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

    sessionA = (await client.query<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA])).rows[0].id;
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

    // Fila aguardando resposta: contato fala por último em conversa aberta.
    const lead1 = await leadFixture(client, tenantA, { status: "em_negociacao", stageId: stageS1, createdAt: `${D1}T09:00:00.000Z` });
    convAwaiting = (await client.query<Row>(
      `INSERT INTO conversations(tenant_id,session_id,lead_id,contact_phone,contact_name,assigned_user_id,created_at,last_message_at,status)
       VALUES($1,$2,$3,'5511800000001','Contato',$4,$5,$5,'open') RETURNING id`,
      [tenantA, sessionA, lead1, operatorA, `${D1}T10:00:00.000Z`]
    )).rows[0].id;
    phoneAwaiting = "5511800000001";
    await client.query(
      "INSERT INTO messages(conversation_id,sender,content,sent_by_user_id,created_at) VALUES($1,'contact','oi',null,$2)",
      [convAwaiting, `${D1}T10:00:00.000Z`]
    );
    await client.query(
      "INSERT INTO messages(conversation_id,sender,content,sent_by_user_id,created_at) VALUES($1,'agent','olá!',$2,$3)",
      [convAwaiting, operatorA, `${D1}T10:02:00.000Z`]
    );
    await client.query(
      "INSERT INTO messages(conversation_id,sender,content,sent_by_user_id,created_at) VALUES($1,'contact','alguém aí?',null,$2)",
      [convAwaiting, `${D1}T10:30:00.000Z`]
    );

    // Gargalo: 60 min na etapa S1; lead hoje está em S2.
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

    // tenant B: SEM dados — isolamento dos keys novos.
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

// LAZY: D0/D2 só existem após o beforeAll (mesma pegadinha do reports).
const customPeriod = { period: "custom" as const, get start() { return D0; }, get end() { return D2; } };

describe("B9 — keys novos no dashboard comercial", () => {
  it("queue_waiting usa o predicado awaiting-reply (fila + itens)", async () => {
    const dashboard = await loadCommercialDashboard(sessionFor(ownerA, tenantA, ownerRoleA), customPeriod);
    expect(dashboard.queue_waiting.count).toBe(1);
    // now() − última mensagem do contato: sinal depende do horário do run.
    expect(dashboard.queue_waiting.avg_wait_seconds).not.toBeNull();
    expect(dashboard.queue_waiting.items).toHaveLength(1);
    expect(dashboard.queue_waiting.items[0].conversation_id).toBe(convAwaiting);
    expect(dashboard.queue_waiting.items[0].contact.phone).toBe(phoneAwaiting);
    expect(dashboard.queue_waiting.items[0].waiting_since_seconds).toBeGreaterThanOrEqual(0);
  });

  it("pipeline_bottlenecks aponta a etapa com maior tempo médio", async () => {
    const dashboard = await loadCommercialDashboard(sessionFor(ownerA, tenantA, ownerRoleA), customPeriod);
    expect(dashboard.pipeline_bottlenecks).toEqual({
      pipeline_id: null, stage_id: stageS1, stage_name: "Negociação", contacts: 1, avg_minutes: 60
    });
  });

  it("first_response_avg mede a primeira resposta humana por operador", async () => {
    const dashboard = await loadCommercialDashboard(sessionFor(ownerA, tenantA, ownerRoleA), customPeriod);
    expect(dashboard.first_response_avg).toEqual([
      { user_id: operatorA, name: "Operadora Ana", seconds: 120, conversations: 1 }
    ]);
  });
});

describe("B9 — isolamento por tenant", () => {
  it("tenant B (sem dados) não enxerga nada de A nos keys novos", async () => {
    const dashboard = await loadCommercialDashboard(sessionFor(ownerB, tenantB, ownerRoleB), customPeriod);
    expect(dashboard.queue_waiting).toEqual({ count: 0, avg_wait_seconds: null, items: [] });
    expect(dashboard.pipeline_bottlenecks).toBeNull();
    expect(dashboard.first_response_avg).toEqual([]);
  });
});

describe("B9 — contrato existente dos widgets intocado", () => {
  it("com a flag ativa: layout, catálogo e widget atual seguem o contrato", async () => {
    const ownerCookie = await cookieFor(ownerA, tenantA);

    const catalog = await app.inject({ url: "/dashboard/widgets/catalog", headers: { cookie: ownerCookie } });
    expect(catalog.statusCode).toBe(200);
    const widgets = catalog.json().widgets as Array<{ key: string; label: string }>;
    expect(widgets.length).toBeGreaterThan(0);
    expect(widgets.find((widget) => widget.key === "open_conversations")).toBeTruthy();

    const layout = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie } });
    expect(layout.statusCode).toBe(200);
    expect(layout.json().layout.source).toBe("default");
    expect(Array.isArray(layout.json().layout.items)).toBe(true);

    const widget = await app.inject({ url: "/dashboard/widgets/open_conversations", headers: { cookie: ownerCookie } });
    expect(widget.statusCode).toBe(200);
    expect(widget.json()).toMatchObject({ key: "open_conversations", data: { open: 1, ai_open: 1, resolved_today: 0 } });
  });

  it("com o kill switch global do dashboard_widgets_v1: 409 FEATURE_FLAG_DISABLED", async () => {
    // Flag global-only: a única forma de desligá-la é o kill switch global.
    await pool.query("UPDATE feature_flag_definitions SET kill_switch_enabled=true WHERE flag_key='dashboard_widgets_v1'");
    try {
      const ownerBCookie = await cookieFor(ownerB, tenantB);
      const response = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerBCookie } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "FEATURE_FLAG_DISABLED", feature: "dashboard_widgets_v1" });
    } finally {
      await pool.query("UPDATE feature_flag_definitions SET kill_switch_enabled=false WHERE flag_key='dashboard_widgets_v1'");
    }
  });
});

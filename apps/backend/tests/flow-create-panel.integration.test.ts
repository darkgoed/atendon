// R1 — auditoria-transversal-20260924: reprodução do falha relatada de
// criação de fluxo de robô. Usa o modelo REAL do painel
// (apps/panel/components/flow-editor/flow-model.ts — starterDefinition +
// newFlowId, sem mock do definition) com buildApp().inject em banco
// descartável. Controles: positivo autorizado (OWNER), duplo clique (CAS),
// sem permissão (agent.read) e tenancy cruzada (tenant B).
// app.ts é do orquestrador: NUNCA re-registrar o plugin aqui.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { flowDefinitionSchema } from "../src/modules/qualification/flow.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
// Payload EXATO da UI (app/panel/app/fluxos/page.tsx:61-70) — modelo real do painel.
import { newFlowId, starterDefinition } from "../../panel/components/flow-editor/flow-model.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenantIds: string[] = [];
const testEmails: string[] = [];

const PANEL_BODY = () => ({ nome: "Novo fluxo", ativo: false, definition: starterDefinition(), revisao_base: 0 });

async function provisionTenant(label: string, withWhatsAppSession = false): Promise<{ tenantId: string; userId: string; sessionId?: string }> {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Flow create ${label} ${randomUUID()}`]
  )).rows[0].id;
  tenantIds.push(tenantId);
  await seedTenantCapabilities(pool, [tenantId]);
  const email = `create-${label}-${randomUUID()}@test.local`;
  testEmails.push(email);
  const passwordHash = await hash("create-password", 4);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash]
    )).rows[0];
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId, user.id]
    );
    const sessionId = withWhatsAppSession
      ? (await client.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id", [tenantId]
        )).rows[0].id
      : undefined;
    await client.query("COMMIT");
    return { tenantId, userId: user.id, sessionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cookieFor(tenantId: string, userId: string): Promise<string> {
  const email = (await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId])).rows[0].email;
  const token = await createSessionToken({ userId, tenantId, email, isRoot: false, rootWorkspaceAccess: false, mustChangePassword: false });
  return `atendon_session=${token}`;
}

/** Membro com SOMENTE agent.read (sem agent.manage) — controle negativo. */
async function provisionReadOnlyMember(tenantId: string): Promise<string> {
  const email = `create-read-${randomUUID()}@test.local`;
  testEmails.push(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id", [email]
    )).rows[0];
    const roleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Somente leitura') RETURNING id",
      [tenantId, `READ ${randomUUID()}`]
    )).rows[0].id;
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'agent.read')", [roleId]);
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, user.id, roleId]
    );
    await client.query("COMMIT");
    return await cookieFor(tenantId, user.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const putFlow = (cookie: string | undefined, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/qualification/flows/${id}`, headers: cookie ? { cookie } : {}, payload });

const getFlow = (cookie: string, id: string) =>
  app.inject({ method: "GET", url: `/qualification/flows/${id}`, headers: { cookie } });

async function flowRow(tenantId: string, id: string) {
  return (await pool.query<{ revision: number; name: string; active: boolean; definition: unknown }>(
    "SELECT revision,name,active,definition FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [tenantId, id]
  )).rows[0];
}

async function snapshotCount(tenantId: string, id: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2", [tenantId, id]
  )).rows[0].count);
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("R1 — criar fluxo de robô com o payload exato do painel", () => {
  it("positivo autorizado: PUT exato da UI → 201, revisão 1, definition íntegra, snapshot de criação e GET do editor ok", async () => {
    const a = await provisionTenant("owner", true);
    const cookie = await cookieFor(a.tenantId, a.userId);

    const id = newFlowId(); // fluxo-<12hex> — mesmo algoritmo do clique "Novo fluxo"
    const response = await putFlow(cookie, id, PANEL_BODY());
    expect(response.statusCode).toBe(201);
    expect(response.json().flow).toMatchObject({ id, nome: "Novo fluxo", ativo: false, revisao: 1 });
    expect(response.json().flow.definition).toEqual(flowDefinitionSchema.parse(starterDefinition()));

    // O que a UI faz em seguida: navega ao editor, que busca o fluxo por id.
    const detail = await getFlow(cookie, id);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().flow).toMatchObject({ id, nome: "Novo fluxo", ativo: false, revisao: 1 });

    // Persistência real: linha no banco + snapshot de criação (1 versão).
    const row = await flowRow(a.tenantId, id);
    expect(row).toBeDefined();
    expect(row!.revision).toBe(1);
    expect(row!.name).toBe("Novo fluxo");
    expect(row!.active).toBe(false);
    expect(row!.definition).toEqual(flowDefinitionSchema.parse(starterDefinition()));
    expect(await snapshotCount(a.tenantId, id)).toBe(1);
  });

  it("duplo clique (mesma revisao_base 0 duas vezes): 1 cria (201), 2º toma 409 FLOW_VERSION_CONFLICT e nada duplica", async () => {
    const { tenantId, userId } = await provisionTenant("double");
    const cookie = await cookieFor(tenantId, userId);
    const id = newFlowId();
    const [first, second] = await Promise.all([putFlow(cookie, id, PANEL_BODY()), putFlow(cookie, id, PANEL_BODY())]);
    const created = [first, second].find((r) => r.statusCode === 201)!;
    const conflict = [first, second].find((r) => r.statusCode === 409)!;
    expect(created.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "FLOW_VERSION_CONFLICT", revisao: 1 });
    expect((await flowRow(tenantId, id))!.revision).toBe(1); // uma linha, uma revisão
    expect(await snapshotCount(tenantId, id)).toBe(1);
  });

  it("sem agent.manage: 403; sem cookie: 401 — nada é criado", async () => {
    const { tenantId } = await provisionTenant("nope");
    const readOnly = await provisionReadOnlyMember(tenantId);
    const id = newFlowId();

    const forbidden = await putFlow(readOnly, id, PANEL_BODY());
    expect(forbidden.statusCode).toBe(403);
    expect(await flowRow(tenantId, id)).toBeUndefined();

    const anonymous = await putFlow(undefined, id, PANEL_BODY());
    expect(anonymous.statusCode).toBe(401);
    expect(await flowRow(tenantId, id)).toBeUndefined();
    expect(await snapshotCount(tenantId, id)).toBe(0);
  });

  it("tenancy: tenant B não lê nem edita fluxo do tenant A; gatilho com sessão de A → 400", async () => {
    const a = await provisionTenant("tenant-a", true);
    const b = await provisionTenant("tenant-b");
    const cookieA = await cookieFor(a.tenantId, a.userId);
    const cookieB = await cookieFor(b.tenantId, b.userId);
    const id = newFlowId();
    expect((await putFlow(cookieA, id, PANEL_BODY())).statusCode).toBe(201);

    // B não vê o fluxo de A...
    expect((await getFlow(cookieB, id)).statusCode).toBe(404);
    // ...e não consegue editar com o token de revisão de A (nada é criado para B).
    const crossEdit = await putFlow(cookieB, id, { nome: "B invade", ativo: false, definition: starterDefinition(), revisao_base: 1 });
    expect(crossEdit.statusCode).toBe(409);
    expect(crossEdit.json()).toMatchObject({ code: "FLOW_VERSION_CONFLICT", revisao: 0 });
    expect(await flowRow(b.tenantId, id)).toBeUndefined();

    // Definition apontando para sessão WhatsApp de A → 400 acionável.
    const foreignRef = await putFlow(cookieB, newFlowId(), {
      nome: "B com sessão de A", ativo: false,
      definition: { ...starterDefinition(), triggers: { ctwa: false, session_ids: [a.sessionId!], keywords: [] } },
      revisao_base: 0
    });
    expect(foreignRef.statusCode).toBe(400);
    expect(foreignRef.json().error).toContain("não pertencem à organização");

    // Espaço de ids é por tenant: B pode criar o MESMO id para si (design upsert).
    expect((await putFlow(cookieB, id, PANEL_BODY())).statusCode).toBe(201);
    expect((await flowRow(b.tenantId, id))!.revision).toBe(1);
    expect((await flowRow(a.tenantId, id))!.name).toBe("Novo fluxo"); // A intacto
  });
});

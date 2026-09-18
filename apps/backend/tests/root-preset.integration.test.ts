// W4B — Preset de empresa (R26) no POST /root/workspaces: a whitelist pedida
// (pipeline/tags/fields/flows) é copiada do workspace-modelo dentro da
// transação; contatos, conversas, sessões WhatsApp e credenciais NUNCA;
// flows fora do pedido não copiam; sem preset o comportamento é inalterado;
// não-root → 403 e falha de preset desfaz o workspace inteiro.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "preset-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let template = ""; // workspace-modelo
let otherTenant = "";
let rootId = "";
let adminId = "";
let rootCookie = "";
let adminCookie = "";
let ownerEmail = "";
let templateStagesAllCount = 0; // 7 semeadas pelo trigger + 1 custom ("Acolhimento")
const createdWorkspaces: string[] = [];

async function login(userId: string, email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  return (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"]!).split(";")[0];
}

async function createWorkspace(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/root/workspaces", headers: { cookie: rootCookie }, payload });
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Workspace-modelo: o trigger (0098) semeia as 7 etapas padrão; acima delas,
    // uma etapa custom, etiquetas, campos, fluxos (1 ativo + 2 inativos —
    // uq_qualification_flows_one_active_per_tenant) e dados operacionais que
    // JAMAIS podem vazar: contatos, conversas, sessão com credenciais.
    template = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Modelo preset ${suffix}`])).rows[0].id;
    await client.query(
      `INSERT INTO pipeline_stages(tenant_id,name,color,position,technical_status)
       VALUES($1,'Acolhimento','#123456',15,'em_atendimento')`,
      [template]
    );
    templateStagesAllCount = (await client.query<{ c: number }>("SELECT count(*)::int c FROM pipeline_stages WHERE tenant_id=$1", [template])).rows[0].c;
    await client.query(
      "INSERT INTO lead_tags(id,tenant_id,name,color) VALUES(gen_random_uuid(),$1,'VIP','#FF0000'),(gen_random_uuid(),$1,'Parceiro','#00FF00')",
      [template]
    );
    await client.query(
      "INSERT INTO custom_field_defs(tenant_id,entity,key,label,type) VALUES($1,'lead','empresa','Empresa','text')",
      [template]
    );
    await client.query(
      `INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES
         ($1,'flow-a','Fluxo A',true,$2),
         ($1,'flow-b','Fluxo B',false,$2),
         ($1,'flow-c','Fluxo C',false,$2)`,
      [template, JSON.stringify({ steps: [] })]
    );
    const templateSessionId = (await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,credentials_encrypted)
       VALUES($1,'Modelo Conectado',true,'{"ciphertext":"segredo-do-modelo"}') RETURNING id`,
      [template]
    )).rows[0].id;
    const leadTemplate = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,'5511900000001','Contato Modelo','preset-test') RETURNING id",
      [template]
    )).rows[0].id;
    await client.query(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,'5511900000002','Contato Modelo 2','preset-test')",
      [template]
    );
    await client.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id) VALUES($1,$2,'5511900000001','Contato Modelo',$3)",
      [template, templateSessionId, leadTemplate]
    );

    // Tenant comum com ADMIN (não-root) para o teste de autorização.
    otherTenant = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Preset admin ${suffix}`])).rows[0].id;
    await client.query("INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system) VALUES($1,'OWNER','',true,true) ON CONFLICT DO NOTHING", [otherTenant]);
    const adminRoleId = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [otherTenant])).rows[0].id;
    rootId = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id", [`preset-root-${suffix}@test.local`, await hash(password, 4)])).rows[0].id;
    adminId = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [`preset-admin-${suffix}@test.local`, await hash(password, 4)])).rows[0].id;
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [otherTenant, adminId, adminRoleId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  rootCookie = await login(rootId, `preset-root-${suffix}@test.local`);
  adminCookie = await login(adminId, `preset-admin-${suffix}@test.local`);
});

afterAll(async () => {
  if (rootId && adminId) {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN ($1,$2)", [rootId, adminId]);
    await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[template, otherTenant, ...createdWorkspaces]]);
    await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [rootId, adminId]);
  }
  await app.close();
  await pool.end();
});

describe("POST /root/workspaces — preset", () => {
  it("copia pipeline/tags/fields/flows pedidos; ZERO contatos/conversas/sessões/credenciais", async () => {
    const templateStages = (await pool.query<{ name: string }>("SELECT name FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position", [template])).rows.map((row) => row.name);
    const templateTagNames = (await pool.query<{ name: string }>("SELECT name FROM lead_tags WHERE tenant_id=$1 ORDER BY name", [template])).rows.map((row) => row.name);
    ownerEmail = `owner-preset-${suffix}@test.local`;
    const response = await createWorkspace({
      name: "Empresa Preset",
      ownerEmail,
      preset_source_tenant_id: template,
      preset: { pipeline: true, tags: true, custom_fields: true, flows: ["flow-a", "flow-b"] }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    createdWorkspaces.push(body.workspace.id);
    expect(body.preset).toEqual({
      pipeline_stages: templateStages.length,
      tags: 2,
      custom_fields: 1,
      flows: 2
    });

    const workspaceId = body.workspace.id;
    // Pipeline: estrutura equivalente ao modelo (nomes/posição), etapa custom presente
    // e transições remapeadas para os ids novos (FK composta).
    const stages = (await pool.query<{ name: string }>("SELECT name FROM pipeline_stages WHERE tenant_id=$1", [workspaceId])).rows.map((row) => row.name);
    expect(stages.sort()).toEqual([...templateStages].sort());
    expect(stages).toContain("Acolhimento");
    expect((await pool.query<{ c: number }>("SELECT count(*)::int c FROM pipeline_transitions WHERE tenant_id=$1", [workspaceId])).rows[0].c).toBeGreaterThan(0);
    // Etiquetas e campos com estrutura do modelo (ids novos: PK global).
    const tags = (await pool.query<{ name: string }>("SELECT name FROM lead_tags WHERE tenant_id=$1", [workspaceId])).rows.map((row) => row.name);
    expect(tags.sort()).toEqual([...templateTagNames].sort());
    const fields = (await pool.query<{ key: string }>("SELECT key FROM custom_field_defs WHERE tenant_id=$1", [workspaceId])).rows;
    expect(fields).toEqual([{ key: "empresa" }]);
    // Fluxos: só os pedidos; exatamente um ativo; o não pedido (flow-c) não copia.
    const flows = (await pool.query<{ id: string; active: boolean }>("SELECT id,active FROM qualification_flows WHERE tenant_id=$1 ORDER BY id", [workspaceId])).rows;
    expect(flows).toEqual([{ id: "flow-a", active: true }, { id: "flow-b", active: false }]);
    // Nada operacional vaza.
    expect((await pool.query<{ c: number }>("SELECT count(*)::int c FROM scheduling_leads WHERE tenant_id=$1", [workspaceId])).rows[0].c).toBe(0);
    expect((await pool.query<{ c: number }>("SELECT count(*)::int c FROM conversations WHERE tenant_id=$1", [workspaceId])).rows[0].c).toBe(0);
    const sessions = (await pool.query<{ label: string; is_primary: boolean; credentials_encrypted: string | null }>(
      "SELECT label,is_primary,credentials_encrypted FROM whatsapp_sessions WHERE tenant_id=$1", [workspaceId]
    )).rows;
    expect(sessions).toEqual([{ label: "Principal", is_primary: true, credentials_encrypted: null }]);
    // Auditoria: linha própria no mesmo operation_group do POST.
    const audit = (await pool.query<{ metadata: { source_tenant_id: string; copied: unknown }; operation_group: string }>(
      "SELECT metadata,operation_group FROM audit_logs WHERE workspace_id=$1 AND action='root.tenant.preset'", [workspaceId]
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.source_tenant_id).toBe(template);
    expect(audit[0].metadata.copied).toEqual(body.preset);
    const createAudit = (await pool.query<{ operation_group: string }>(
      "SELECT operation_group FROM audit_logs WHERE workspace_id=$1 AND action='root.workspaces.create'", [workspaceId]
    )).rows[0];
    expect(createAudit.operation_group).toBe(audit[0].operation_group);
  });

  it("flows all_active copia apenas os ativos do modelo", async () => {
    const response = await createWorkspace({
      name: "Empresa Preset Ativos",
      ownerEmail: `owner-active-${suffix}@test.local`,
      preset_source_tenant_id: template,
      preset: { flows: "all_active" }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    createdWorkspaces.push(body.workspace.id);
    expect(body.preset.flows).toBe(1);
    const flows = (await pool.query<{ id: string; active: boolean }>("SELECT id,active FROM qualification_flows WHERE tenant_id=$1", [body.workspace.id])).rows;
    expect(flows).toEqual([{ id: "flow-a", active: true }]);
  });

  it("seção não pedida não copia: só tags; pipeline/fields/flows ficam de fábrica", async () => {
    const response = await createWorkspace({
      name: "Empresa Preset Tags",
      ownerEmail: `owner-tags-${suffix}@test.local`,
      preset_source_tenant_id: template,
      preset: { tags: true }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    createdWorkspaces.push(body.workspace.id);
    expect(body.preset).toEqual({ pipeline_stages: 0, tags: 2, custom_fields: 0, flows: 0 });
    const workspaceId = body.workspace.id;
    expect((await pool.query<{ c: number }>("SELECT count(*)::int c FROM qualification_flows WHERE tenant_id=$1", [workspaceId])).rows[0].c).toBe(0);
    expect((await pool.query<{ c: number }>("SELECT count(*)::int c FROM custom_field_defs WHERE tenant_id=$1", [workspaceId])).rows[0].c).toBe(0);
    // Pipeline intacto: somente as etapas semeadas pelo trigger — sem a etapa custom.
    const stages = (await pool.query<{ name: string }>("SELECT name FROM pipeline_stages WHERE tenant_id=$1", [workspaceId])).rows.map((row) => row.name);
    expect(stages).not.toContain("Acolhimento");
    expect(stages.length).toBe(templateStagesAllCount - 1);
  });

  it("preset exige preset_source_tenant_id → 400", async () => {
    const response = await createWorkspace({ name: "Empresa Solta", ownerEmail: `owner-solta-${suffix}@test.local`, preset: { tags: true } });
    expect(response.statusCode).toBe(400);
  });

  it("workspace-modelo inexistente → 404 e nenhuma linha de workspace criada", async () => {
    const before = (await pool.query<{ c: number }>("SELECT count(*)::int c FROM tenants")).rows[0].c;
    const response = await createWorkspace({
      name: "Empresa Rollback",
      ownerEmail: `owner-rollback-${suffix}@test.local`,
      preset_source_tenant_id: randomUUID(),
      preset: { tags: true }
    });
    expect(response.statusCode).toBe(404);
    const after = (await pool.query<{ c: number }>("SELECT count(*)::int c FROM tenants")).rows[0].c;
    expect(after).toBe(before);
  });
});

describe("POST /root/workspaces — sem preset e autorização", () => {
  it("sem preset: 201 sem chave preset e sem auditoria root.tenant.preset", async () => {
    const response = await createWorkspace({ name: "Empresa Simples", ownerEmail: `owner-plain-${suffix}@test.local` });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    createdWorkspaces.push(body.workspace.id);
    expect(body.preset).toBeUndefined();
    expect(body.capabilities.length).toBeGreaterThan(0);
    expect((await pool.query<{ c: number }>(
      "SELECT count(*)::int c FROM audit_logs WHERE workspace_id=$1 AND action='root.tenant.preset'", [body.workspace.id]
    )).rows[0].c).toBe(0);
  });

  it("não-root → 403", async () => {
    const response = await app.inject({ method: "POST", url: "/root/workspaces", headers: { cookie: adminCookie }, payload: { name: "Hacker", ownerEmail: `owner-hack-${suffix}@test.local` } });
    expect(response.statusCode).toBe(403);
  });
});

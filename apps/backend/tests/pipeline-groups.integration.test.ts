// Grupos opcionais de pipelines (0185 + organization): empresa limpa nasce sem
// grupos, CRUD isolado por empresa, mover pipeline entre grupos sem tocar nos
// demais campos, duplicação preserva grupo, arquivar desagrupa na mesma
// transação, ordem exige permutação exata e PUT /organization/pipelines/order
// responde lendo APÓS o commit.
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
const emailA = `pipe-groups-a-${suffix}@test.local`;
const emailB = `pipe-groups-b-${suffix}@test.local`;
let tenantA = "";
let tenantB = "";
let userA = "";
let userB = "";
let cookieA = "";
let cookieB = "";

type Pipeline = { id: string; name: string; color: string; position: number; group_id: string | null };
type Group = { id: string; name: string; position: number };

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

let groupA = "";
let groupRenamed = "";
let groupOfB = "";
let pipelineInGroup = "";

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    ({ tenantId: tenantA, userId: userA } = await setupTenant(client, `clean-pg-a-${suffix}`, emailA));
    ({ tenantId: tenantB, userId: userB } = await setupTenant(client, `clean-pg-b-${suffix}`, emailB));
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
}, 120_000); // limpeza em cascata estoura o hookTimeout default sob carga

describe("grupos opcionais de pipelines", { timeout: 30_000 }, () => {
  it("empresa limpa nasce sem grupos e com pipelines sem grupo", async () => {
    const list = (await inject(cookieA, "GET", "/organization/pipelines")).json();
    expect(list.groups).toEqual([]);
    expect(list.channels).toBeDefined();
    for (const pipeline of list.pipelines as Pipeline[]) {
      expect(pipeline.group_id).toBeNull();
    }
  });

  it("cria grupos em sequência (0-based), nome ativo duplicado → 409 e lista só {id,name,position}", async () => {
    const created = await inject(cookieA, "POST", "/organization/pipeline-groups", { name: "Vendas" });
    expect(created.statusCode).toBe(201);
    groupA = created.json().group.id;
    expect(created.json().group).toEqual({ id: groupA, name: "Vendas", position: 0, created_at: expect.any(String), updated_at: expect.any(String) });
    const second = await inject(cookieA, "POST", "/organization/pipeline-groups", { name: "Pós-venda" });
    expect(second.statusCode).toBe(201);
    groupRenamed = second.json().group.id;
    expect(second.json().group.position).toBe(1);
    expect((await inject(cookieA, "POST", "/organization/pipeline-groups", { name: "vendas" })).statusCode).toBe(409);
    const list = (await inject(cookieA, "GET", "/organization/pipelines")).json();
    expect(list.groups).toEqual([
      { id: groupA, name: "Vendas", position: 0 },
      { id: groupRenamed, name: "Pós-venda", position: 1 }
    ]);
  });

  it("renomeia grupo; PATCH sem campo → 400", async () => {
    const renamed = await inject(cookieA, "PATCH", `/organization/pipeline-groups/${groupA}`, { name: "Comercial" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().group.name).toBe("Comercial");
    expect((await inject(cookieA, "PATCH", `/organization/pipeline-groups/${groupA}`, {})).statusCode).toBe(400);
    const list = (await inject(cookieA, "GET", "/organization/pipelines")).json();
    expect(list.groups.map((group: Group) => group.name)).toEqual(["Comercial", "Pós-venda"]);
  });

  it("cria pipeline no grupo, move por PATCH sem tocar nos outros campos e duplicar preserva o grupo", async () => {
    const created = await inject(cookieA, "POST", "/organization/pipelines", { name: "Boleto", group_id: groupA });
    expect(created.statusCode).toBe(201);
    pipelineInGroup = created.json().pipeline.id;
    expect(created.json().pipeline.group_id).toBe(groupA);
    // Mesmo grupo aceita vários pipelines; grupo vazio é permitido.
    await inject(cookieA, "POST", "/organization/pipelines", { name: "Solo", group_id: groupA });
    // Grupo inexistente/outro tenant → 404.
    expect((await inject(cookieA, "POST", "/organization/pipelines", { name: "X", group_id: randomUUID() })).statusCode).toBe(404);
    expect((await inject(cookieB, "POST", "/organization/pipelines", { name: "B1", group_id: groupA })).statusCode).toBe(404);
    // PATCH só de grupo: move sem alterar name/color.
    const before = (await inject(cookieA, "GET", "/organization/pipelines")).json().pipelines.find((pipeline: Pipeline) => pipeline.id === pipelineInGroup)!;
    const moved = await inject(cookieA, "PATCH", `/organization/pipelines/${pipelineInGroup}`, { group_id: groupRenamed });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().pipeline).toMatchObject({ id: pipelineInGroup, name: before.name, color: before.color, group_id: groupRenamed });
    // PATCH sem campo continua 400.
    expect((await inject(cookieA, "PATCH", `/organization/pipelines/${pipelineInGroup}`, {})).statusCode).toBe(400);
    // group_id null desagrupa; volta para o grupo em seguida.
    expect((await inject(cookieA, "PATCH", `/organization/pipelines/${pipelineInGroup}`, { group_id: null })).json().pipeline.group_id).toBeNull();
    expect((await inject(cookieA, "PATCH", `/organization/pipelines/${pipelineInGroup}`, { group_id: groupA })).json().pipeline.group_id).toBe(groupA);
    // Duplicar herda o grupo da origem.
    const duplicated = await inject(cookieA, "POST", `/organization/pipelines/${pipelineInGroup}/duplicate`, {});
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json().pipeline.group_id).toBe(groupA);
  });

  it("ordem de grupos exige permutação exata dos ativos e grava positions 0..n-1", async () => {
    groupOfB = (await inject(cookieB, "POST", "/organization/pipeline-groups", { name: "B" })).json().group.id;
    expect((await inject(cookieA, "PUT", "/organization/pipeline-groups/order", { group_ids: [groupA] })).statusCode).toBe(400);
    expect((await inject(cookieA, "PUT", "/organization/pipeline-groups/order", { group_ids: [groupA, groupA] })).statusCode).toBe(400);
    expect((await inject(cookieA, "PUT", "/organization/pipeline-groups/order", { group_ids: [groupA, groupOfB] })).statusCode).toBe(400);
    const reordered = await inject(cookieA, "PUT", "/organization/pipeline-groups/order", { group_ids: [groupRenamed, groupA] });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().groups).toEqual([
      { id: groupRenamed, name: "Pós-venda", position: 0 },
      { id: groupA, name: "Comercial", position: 1 }
    ]);
    expect((await inject(cookieA, "GET", "/organization/pipelines")).json().groups).toEqual(reordered.json().groups);
  });

  it("PUT /organization/pipelines/order responde com a ordem JÁ gravada (leitura pós-commit)", async () => {
    const pipelines = (await inject(cookieA, "GET", "/organization/pipelines")).json().pipelines as Pipeline[];
    const reversed = [...pipelines].reverse().map((pipeline) => pipeline.id);
    const reordered = await inject(cookieA, "PUT", "/organization/pipelines/order", { pipeline_ids: reversed });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().pipelines.map((pipeline: Pipeline) => [pipeline.id, pipeline.position]))
      .toEqual(reversed.map((id, index) => [id, index]));
  });

  it("arquivar grupo desagrupa os pipelines na mesma transação e o grupo some das listas", async () => {
    const archived = await inject(cookieA, "POST", `/organization/pipeline-groups/${groupA}/archive`, {});
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toEqual({ id: groupA, archived: true });
    const list = (await inject(cookieA, "GET", "/organization/pipelines")).json();
    expect(list.groups.map((group: Group) => group.id)).toEqual([groupRenamed]);
    expect(list.pipelines.find((pipeline: Pipeline) => pipeline.id === pipelineInGroup)!.group_id).toBeNull();
    // Grupo arquivado: nem re-arquivar, nem renomear, nem vincular pipeline.
    expect((await inject(cookieA, "POST", `/organization/pipeline-groups/${groupA}/archive`, {})).statusCode).toBe(404);
    expect((await inject(cookieA, "PATCH", `/organization/pipeline-groups/${groupA}`, { name: "Zumbi" })).statusCode).toBe(404);
    expect((await inject(cookieA, "PATCH", `/organization/pipelines/${pipelineInGroup}`, { group_id: groupA })).statusCode).toBe(404);
    // Nome de grupo arquivado pode ser reutilizado.
    expect((await inject(cookieA, "POST", "/organization/pipeline-groups", { name: "Comercial" })).statusCode).toBe(201);
  });

  it("isolamento entre empresas: grupo de A é 404/invisível para B", async () => {
    expect((await inject(cookieB, "PATCH", `/organization/pipeline-groups/${groupRenamed}`, { name: "Invadido" })).statusCode).toBe(404);
    expect((await inject(cookieB, "POST", `/organization/pipeline-groups/${groupRenamed}/archive`, {})).statusCode).toBe(404);
    expect((await inject(cookieB, "PUT", "/organization/pipeline-groups/order", { group_ids: [groupOfB] })).statusCode).toBe(200);
    const listB = (await inject(cookieB, "GET", "/organization/pipelines")).json();
    expect(listB.groups).toEqual([{ id: groupOfB, name: "B", position: 0 }]);
    expect(listB.pipelines.every((pipeline: Pipeline) => pipeline.group_id === null)).toBe(true);
  });

  it("audit registra as mutações de grupo", async () => {
    const actions = (await pool.query<{ action: string }>(
      "SELECT DISTINCT action FROM audit_logs WHERE workspace_id=$1 AND resource_type='pipeline_group'",
      [tenantA]
    )).rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["pipeline_group.created", "pipeline_group.updated", "pipeline_group.archived", "pipeline_group.reordered"]));
  });
});

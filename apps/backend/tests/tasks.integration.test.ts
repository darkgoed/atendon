// W1C — Tarefas (migration 0169, contrato "Tarefas"): escopo mine/team,
// atribuição exige tasks.assign, responsável muda status, tenancy e keyset.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "tasks-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
let outsider = "";
let leadA = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

async function loginAs(userId: string) {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = emails.get(userId)!;
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"]!).split(";")[0];
  cookies.set(userId, cookie);
  return cookie;
}

async function createUser(client: pg.PoolClient, tenantId: string | null, roleId: string | null, email: string) {
  const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)]);
  if (tenantId && roleId) {
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, roleId]);
  }
  emails.set(user.rows[0].id, email);
  return user.rows[0].id;
}

async function roleIdOf(client: pg.PoolClient, tenantId: string, name: string) {
  return (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name=$2", [tenantId, name])).rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Tasks A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Tasks B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    const ownerARole = await roleIdOf(client, tenantA, "OWNER");
    const opARole = await roleIdOf(client, tenantA, "OPERADOR");
    const ownerBRole = await roleIdOf(client, tenantB, "OWNER");
    ownerA = await createUser(client, tenantA, ownerARole, `tasks-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, opARole, `tasks-a-op-${randomUUID()}@test.local`);
    outsider = await createUser(client, null, null, `tasks-out-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, ownerBRole, `tasks-b-owner-${randomUUID()}@test.local`);
    // FK scheduling_leads(tenant_id,unit_id) exige unidade real.
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'calls','Calls','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
      [tenantA]
    );
    leadA = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source) VALUES($1,$2,'Lead Tarefas','calls','qualificado','tasks-test') RETURNING id",
      [tenantA, `5511${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("tarefas — fluxo feliz", () => {
  it("cria atribuída, responsável vê em mine e conclui", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Ligar para o lead", description: "Orçamento", assignee_id: operatorA, priority: "alta", lead_id: leadA }
    });
    expect(created.statusCode).toBe(201);
    const task = created.json().task;
    expect(task.assignee).toMatchObject({ id: operatorA });
    expect(task.lead).toMatchObject({ id: leadA });
    expect(task.status).toBe("aberta");

    const mine = await app.inject({ url: "/tasks?scope=mine", headers: { cookie: await loginAs(operatorA) } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.map((item: { id: string }) => item.id)).toContain(task.id);

    const done = await app.inject({
      method: "PATCH", url: `/tasks/${task.id}`, headers: { cookie: await loginAs(operatorA) },
      payload: { status: "concluida" }
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().task.status).toBe("concluida");
    expect(done.json().task.completed_at).toBeTruthy();

    const team = await app.inject({ url: "/tasks?scope=team&status=concluida", headers: { cookie: await loginAs(ownerA) } });
    expect(team.statusCode).toBe(200);
    expect(team.json().items.map((item: { id: string }) => item.id)).toContain(task.id);
  });

  it("owner reatribui (tasks.assign) e notificação de tarefa é criada", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Reatribuível", assignee_id: ownerA }
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id;
    const reassigned = await app.inject({
      method: "PATCH", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(ownerA) },
      payload: { assignee_id: operatorA, due_at: "2026-12-01T10:00:00Z" }
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json().task.assignee.id).toBe(operatorA);
    const notifications = await pool.query(
      "SELECT 1 FROM internal_notifications WHERE tenant_id=$1 AND user_id=$2 AND type='task_assigned' AND source_id=$3",
      [tenantA, operatorA, taskId]
    );
    expect(notifications.rowCount).toBeGreaterThan(0);
  });
});

describe("tarefas — permissões", () => {
  it("operador sem tasks.assign: team 403, atribuir a outro 403, reassign/prazo 403", async () => {
    const team = await app.inject({ url: "/tasks?scope=team", headers: { cookie: await loginAs(operatorA) } });
    expect(team.statusCode).toBe(403);

    const assignToOther = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(operatorA) },
      payload: { title: "Para o owner", assignee_id: ownerA }
    });
    expect(assignToOther.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(operatorA) },
      payload: { title: "Minha tarefa", assignee_id: operatorA }
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id;

    const reassign = await app.inject({
      method: "PATCH", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(operatorA) },
      payload: { assignee_id: ownerA }
    });
    expect(reassign.statusCode).toBe(403);

    const dueDate = await app.inject({
      method: "PATCH", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(operatorA) },
      payload: { priority: "alta" }
    });
    expect(dueDate.statusCode).toBe(403);

    const ownerTask = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Do owner", assignee_id: ownerA }
    });
    const forbiddenDelete = await app.inject({
      method: "DELETE", url: `/tasks/${ownerTask.json().task.id}`, headers: { cookie: await loginAs(operatorA) }
    });
    expect(forbiddenDelete.statusCode).toBe(403);

    // Conteúdo (título/descrição): só gestão, autor ou responsável. Operador
    // não edita tarefa de outro (nem atribuída a ele? sim, responsável pode —
    // aqui não é responsável nem autor).
    const titleOther = await app.inject({
      method: "PATCH", url: `/tasks/${ownerTask.json().task.id}`, headers: { cookie: await loginAs(operatorA) },
      payload: { title: "hack" }
    });
    expect(titleOther.statusCode).toBe(403);
    const titleOwn = await app.inject({
      method: "PATCH", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(operatorA) },
      payload: { title: "Minha tarefa renomeada" }
    });
    expect(titleOwn.statusCode).toBe(200);
    expect(titleOwn.json().task.title).toBe("Minha tarefa renomeada");

    // Responsável pode excluir a própria tarefa (autor ou tasks.assign).
    const selfDelete = await app.inject({
      method: "DELETE", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(operatorA) }
    });
    expect(selfDelete.statusCode).toBe(200);
  });

  it("responsável inválido (fora do workspace) → 400", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Fantasma", assignee_id: outsider }
    });
    expect(created.statusCode).toBe(400);
  });
});

describe("tarefas — tenancy e lead", () => {
  it("workspace B não vê nem manipula tarefa de A", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Só do A", assignee_id: ownerA }
    });
    const taskId = created.json().task.id;
    const listB = await app.inject({ url: "/tasks?scope=team", headers: { cookie: await loginAs(ownerB) } });
    expect(listB.json().items.map((item: { id: string }) => item.id)).not.toContain(taskId);
    expect((await app.inject({ method: "PATCH", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(ownerB) }, payload: { title: "hack" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/tasks/${taskId}`, headers: { cookie: await loginAs(ownerB) } })).statusCode).toBe(404);
  });

  it("lead inexistente → 404; lead do tenant → vinculado", async () => {
    const missing = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Sem lead", lead_id: randomUUID() }
    });
    expect(missing.statusCode).toBe(404);
    const linked = await app.inject({
      method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) },
      payload: { title: "Com lead", lead_id: leadA }
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().task.lead.id).toBe(leadA);
  });
});

describe("tarefas — keyset", () => {
  it("cursor pagina sem repetir itens", async () => {
    // Testes anteriores deste arquivo deixam tarefas no acervo do workspace;
    // o keyset aqui é determinístico sobre o conjunto criado abaixo.
    await pool.query("DELETE FROM tasks WHERE tenant_id=$1", [tenantA]);
    for (const title of ["k1", "k2", "k3"]) {
      await app.inject({ method: "POST", url: "/tasks", headers: { cookie: await loginAs(ownerA) }, payload: { title } });
    }
    const first = await app.inject({ url: "/tasks?scope=team&limit=2", headers: { cookie: await loginAs(ownerA) } });
    expect(first.statusCode).toBe(200);
    expect(first.json().page.has_more).toBe(true);
    const firstIds = first.json().items.map((item: { id: string }) => item.id);
    const second = await app.inject({ url: `/tasks?scope=team&limit=2&cursor=${first.json().page.next_cursor}`, headers: { cookie: await loginAs(ownerA) } });
    const secondIds = second.json().items.map((item: { id: string }) => item.id);
    expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
    const all = await app.inject({ url: "/tasks?scope=team&limit=100", headers: { cookie: await loginAs(ownerA) } });
    expect(all.json().items.length).toBe(firstIds.length + secondIds.length);
  });
});

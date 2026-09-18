// W4B — Busca global (GET /search): validação do q, tenancy A/B, match por
// nome e por telefone (contatos/conversas), match de tarefa por título,
// seções omitidas/vazias conforme permissão e cursor keyset por seção.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";

const password = "search-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
let leitorA = ""; // role custom SEM leads.follow_up.read
const mariaPhoneA = "5511987654321";
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

async function search(userId: string, query: string) {
  const response = await app.inject({ url: `/search?${query}`, headers: { cookie: await loginAs(userId) } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Search A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Search B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OWNER"), `search-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OPERADOR"), `search-a-op-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, await roleIdOf(client, tenantB, "OWNER"), `search-b-owner-${randomUUID()}@test.local`);
    // Leitor: tasks.read + conversations.read, sem leads.follow_up.read →
    // seção contacts deve ser OMITIDA da resposta (não 403, não vazia).
    const leitorRole = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system) VALUES($1,'LEITOR','Somente leitura limitada',false,false) RETURNING id",
      [tenantA]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) SELECT $1,p.key FROM permissions p WHERE p.key=ANY($2::text[])",
      [leitorRole, ["tasks.read", "conversations.read"]]
    );
    leitorA = await createUser(client, tenantA, leitorRole, `search-a-leitor-${randomUUID()}@test.local`);

    // Contatos (scheduling_leads): Maria em A, homônima em B (tenancy).
    const leadMariaA = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Maria Teste Silva','search-test') RETURNING id",
      [tenantA, mariaPhoneA]
    )).rows[0].id;
    await client.query(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Zezinho Abreu','search-test')",
      [tenantA, "5511933334444"]
    );
    await client.query(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Maria Teste Silva','search-test')",
      [tenantB, "5512988887777"]
    );
    // Conversa precisa de lead real (FK lead_id NOT NULL desde 0098) e de sessão.
    const sessionA = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Busca',true) RETURNING id",
      [tenantA]
    )).rows[0].id;
    await client.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id,assigned_user_id) VALUES($1,$2,$3,'Maria Teste Silva',$4,$5)",
      [tenantA, sessionA, mariaPhoneA, leadMariaA, ownerA]
    );
    // Tarefas: do owner (visível a ele, invisível ao operador sem tasks.assign)
    // e do operador (visível a ele mesmo por criador).
    await client.query(
      "INSERT INTO tasks(tenant_id,title,description,assignee_id,created_by) VALUES($1,'Proposta Xanadu','Enviar Oráculo',$2,$2)",
      [tenantA, ownerA]
    );
    await client.query(
      "INSERT INTO tasks(tenant_id,title,assignee_id,created_by) VALUES($1,'Seguir lead',$2,$2)",
      [tenantA, operatorA]
    );
    await client.query(
      "INSERT INTO tasks(tenant_id,title,assignee_id,created_by) VALUES($1,'Tarefa Bonly',$2,$2)",
      [tenantB, ownerB]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (tenantA && tenantB) {
    await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
    await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[...emails.values()]]);
  }
  await app.close();
  await pool.end();
});

describe("GET /search — validação", () => {
  it("q com menos de 2 caracteres → 400", async () => {
    expect((await app.inject({ url: "/search?q=a", headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/search?q=", headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/search", headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(400);
  });
});

describe("GET /search — contatos e conversas por nome e telefone", () => {
  it("contato por nome", async () => {
    const body = await search(ownerA, "q=Maria%20Teste");
    expect(body.contacts.items).toEqual([expect.objectContaining({ name: "Maria Teste Silva", phone: mariaPhoneA })]);
  });

  it("contato por telefone (parcial, sem +)", async () => {
    const body = await search(ownerA, "q=1198765-4321");
    expect(body.contacts.items).toEqual([expect.objectContaining({ phone: mariaPhoneA })]);
    // Telefone de B não pertence a A.
    expect(body.contacts.items.map((item: { phone: string }) => item.phone)).not.toContain("5512988887777");
  });

  it("conversa por nome e por telefone", async () => {
    const byName = await search(ownerA, "q=Maria%20Teste");
    expect(byName.conversations.items).toHaveLength(1);
    const conversationId = byName.conversations.items[0].id;
    const byPhone = await search(ownerA, "q=98765-4321");
    expect(byPhone.conversations.items.map((item: { id: string }) => item.id)).toContain(conversationId);
  });

  it("operador em escopo mine não vê lead/conversa não atribuídos a ele", async () => {
    const body = await search(operatorA, "q=Maria%20Teste");
    expect(body.contacts.items).toEqual([]);
    expect(body.conversations.items).toEqual([]);
  });
});

describe("GET /search — tarefas", () => {
  it("tarefa por título", async () => {
    const body = await search(ownerA, "q=Xanadu");
    expect(body.tasks.items).toHaveLength(1);
    expect(body.tasks.items[0]).toMatchObject({ title: "Proposta Xanadu" });
  });

  it("tarefa por descrição", async () => {
    const body = await search(ownerA, "q=Or%C3%A1culo");
    expect(body.tasks.items.map((item: { title: string }) => item.title)).toContain("Proposta Xanadu");
  });

  it("operador sem tasks.assign vê apenas suas tarefas (criadas ou sob responsabilidade)", async () => {
    const own = await search(operatorA, "q=Seguir");
    expect(own.tasks.items.map((item: { title: string }) => item.title)).toContain("Seguir lead");
    const others = await search(operatorA, "q=Xanadu");
    expect(others.tasks.items).toEqual([]);
  });
});

describe("GET /search — tenancy", () => {
  it("workspace B não vê contatos, tarefas nem conversas de A", async () => {
    const bodyB = await search(ownerB, "q=Maria%20Teste");
    expect(bodyB.contacts.items.map((item: { phone: string }) => item.phone)).toEqual(["5512988887777"]);
    expect(await search(ownerB, "q=Xanadu")).toMatchObject({ tasks: { items: [] } });
    expect(await search(ownerB, "q=Or%C3%A1culo")).toMatchObject({ tasks: { items: [] } });
    const bodyA = await search(ownerA, "q=Tarefa%20Bonly");
    expect(bodyA.tasks.items).toEqual([]);
  });
});

describe("GET /search — permissões omitem seção", () => {
  it("sem leads.follow_up.read a chave contacts não existe; tasks/conversations existem", async () => {
    const body = await search(leitorA, "q=Maria%20Teste");
    expect(body.contacts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, "tasks")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "conversations")).toBe(true);
  });

  it("operador (tasks.read sem tasks.assign) mantém contacts visível a quem é dele", async () => {
    // Maria não é dele → vazio, mas a seção EXISTE (OPERADOR tem leads.follow_up.read).
    const body = await search(operatorA, "q=Maria%20Teste");
    expect(Object.prototype.hasOwnProperty.call(body, "contacts")).toBe(true);
  });
});

describe("GET /search — cursor keyset", () => {
  it("pagina por seção sem repetir itens", async () => {
    const titles = ["Cursor alfa", "Cursor beta", "Cursor gama"];
    await pool.query(
      "INSERT INTO tasks(tenant_id,title,assignee_id,created_by) SELECT $1,t.title,$2,$2 FROM unnest($3::text[]) t(title)",
      [tenantA, ownerA, titles]
    );
    const seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 5; page += 1) {
      const body = await search(ownerA, `q=Cursor&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      const pageIds = body.tasks.items.map((item: { id: string }) => item.id);
      for (const id of pageIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      if (!body.page.has_more || !body.page.next_cursor) break;
      cursor = body.page.next_cursor;
    }
    expect(seen.size).toBe(titles.length);
  });
});

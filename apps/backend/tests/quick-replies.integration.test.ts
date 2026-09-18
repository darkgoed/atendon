// W1C — Respostas rápidas (migration 0172, contrato "Quick replies"):
// leitura para qualquer agente (quick_replies.read), escrita com
// quick_replies.manage, shortcut único por tenant (409), tenancy.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "quick-replies-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
let supervisorA = "";
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

async function createUser(client: pg.PoolClient, tenantId: string, roleId: string, email: string) {
  const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)]);
  await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, roleId]);
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
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`QuickReplies A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`QuickReplies B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OWNER"), `qr-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OPERADOR"), `qr-a-op-${randomUUID()}@test.local`);
    supervisorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "SUPERVISOR"), `qr-a-sup-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, await roleIdOf(client, tenantB, "OWNER"), `qr-b-owner-${randomUUID()}@test.local`);
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

describe("quick replies — permissões", () => {
  it("operador lê (quick_replies.read) mas não escreve", async () => {
    const read = await app.inject({ url: "/quick-replies", headers: { cookie: await loginAs(operatorA) } });
    expect(read.statusCode).toBe(200);
    expect(read.json().items).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(operatorA) }, payload: { shortcut: "ola", body: "Olá!" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/quick-replies/${randomUUID()}`, headers: { cookie: await loginAs(operatorA) }, payload: { body: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/quick-replies/${randomUUID()}`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
  });

  it("supervisor (gestão) pode escrever", async () => {
    const created = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(supervisorA) },
      payload: { shortcut: "Preco", body: "Segue a proposta {{nome}}." }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reply.shortcut).toBe("preco");
  });
});

describe("quick replies — shortcut único por tenant", () => {
  it("mesmo atalho (qualquer caixa) no tenant → 409; outro tenant aceita", async () => {
    const created = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(ownerA) },
      payload: { shortcut: "endereco", body: "Nosso endereço é ..." }
    });
    expect(created.statusCode).toBe(201);
    const replyId = created.json().reply.id;

    const duplicate = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(ownerA) },
      payload: { shortcut: "Endereco", body: "Outro texto" }
    });
    expect(duplicate.statusCode).toBe(409);

    const otherTenant = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(ownerB) },
      payload: { shortcut: "endereco", body: "Endereço do workspace B" }
    });
    expect(otherTenant.statusCode).toBe(201);

    const renameClash = await app.inject({
      method: "PATCH", url: `/quick-replies/${replyId}`, headers: { cookie: await loginAs(ownerA) },
      payload: { shortcut: "preco" }
    });
    expect(renameClash.statusCode).toBe(409);
  });
});

describe("quick replies — CRUD e tenancy", () => {
  it("PATCH altera texto/atalho; DELETE remove; desconhecido → 404", async () => {
    const created = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(ownerA) },
      payload: { shortcut: "obrigado", body: "Obrigado pelo contato!" }
    });
    const replyId = created.json().reply.id;

    const updated = await app.inject({
      method: "PATCH", url: `/quick-replies/${replyId}`, headers: { cookie: await loginAs(ownerA) },
      payload: { body: "Obrigado, {{nome}}!" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().reply.body).toBe("Obrigado, {{nome}}!");
    expect(updated.json().reply.author.id).toBe(ownerA);

    expect((await app.inject({ method: "PATCH", url: `/quick-replies/${randomUUID()}`, headers: { cookie: await loginAs(ownerA) }, payload: { body: "x" } })).statusCode).toBe(404);

    const removed = await app.inject({ method: "DELETE", url: `/quick-replies/${replyId}`, headers: { cookie: await loginAs(ownerA) } });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/quick-replies/${replyId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(404);
    const list = await app.inject({ url: "/quick-replies", headers: { cookie: await loginAs(ownerA) } });
    expect(list.json().items.map((item: { id: string }) => item.id)).not.toContain(replyId);
  });

  it("listas não vazam entre workspaces", async () => {
    const created = await app.inject({
      method: "POST", url: "/quick-replies", headers: { cookie: await loginAs(ownerA) },
      payload: { shortcut: "sigiloso", body: "Interno do A" }
    });
    const listB = await app.inject({ url: "/quick-replies", headers: { cookie: await loginAs(ownerB) } });
    expect(listB.json().items.map((item: { id: string }) => item.id)).not.toContain(created.json().reply.id);
    expect((await app.inject({ method: "DELETE", url: `/quick-replies/${created.json().reply.id}`, headers: { cookie: await loginAs(ownerB) } })).statusCode).toBe(404);
  });
});

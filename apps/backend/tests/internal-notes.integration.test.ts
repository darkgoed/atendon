// W1B — notas internas com @menções (R3).
// Nota de lead com menção → internal_notification 'mention' para o mencionado
// do MESMO tenant; mencionado de outro tenant → 400; permissões espelham o
// acompanhamento de leads (leads.follow_up.read/manage) e de conversas
// (conversations.read/reply). Fonte unificada: scheduling_lead_notes p/ lead.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "internal-notes-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let userA1 = "";
let userA2 = "";
let userA3 = "";
let userB1 = "";
let leadId = "";
let conversationId = "";
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
  const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status,name) VALUES($1,$2,'active',$3) RETURNING id", [email, await hash(password, 4), `Usuário ${emails.size + 1}`]);
  await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, roleId]);
  emails.set(user.rows[0].id, email);
  return user.rows[0].id;
}

async function mentionCount(userId: string, sourceId: string) {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int count FROM internal_notifications
     WHERE tenant_id=$1 AND user_id=$2 AND type='mention' AND source_id=$3`,
    [tenantA, userId, sourceId]
  );
  return result.rows[0].count;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantIdA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`InternalNotes A ${randomUUID()}`])).rows[0].id;
    tenantA = tenantIdA;
    const tenantIdB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`InternalNotes B ${randomUUID()}`])).rows[0].id;
    tenantB = tenantIdB;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    const ownerRoleA = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantA])).rows[0].id;
    const ownerRoleB = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantB])).rows[0].id;
    userA1 = await createUser(client, tenantA, ownerRoleA, `notes-a1-${randomUUID()}@test.local`);
    userA2 = await createUser(client, tenantA, ownerRoleA, `notes-a2-${randomUUID()}@test.local`);
    userB1 = await createUser(client, tenantB, ownerRoleB, `notes-b1-${randomUUID()}@test.local`);
    // Usuário sem permissões (role vazia) para exercitar 403.
    const limitedRole = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description,is_system) VALUES($1,'SEM_PERMIS','role de teste sem permissões',false) RETURNING id",
      [tenantA]
    )).rows[0].id;
    userA3 = await createUser(client, tenantA, limitedRole, `notes-a3-${randomUUID()}@test.local`);

    // Fixture de lead: categoria + unidade + lead.
    await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'teste','Categoria teste')", [tenantA]);
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'teste','Unidade teste','08:00','18:00','{1,2,3,4,5}')",
      [tenantA]
    );
    leadId = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,interest_category_id,unit_id,source) VALUES($1,$2,'Lead notas','teste','teste','test') RETURNING id",
      [tenantA, `5511${10000000 + Math.floor(Math.random() * 89999999)}`]
    )).rows[0].id;

    const session = await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA]);
    conversationId = (await client.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,assigned_user_id) VALUES($1,$2,'5511999000202','Contato notas',$3) RETURNING id",
      [tenantA, session.rows[0].id, userA1]
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

describe("notas internas com menções", () => {
  it("cria nota de lead com menção → notificação 'mention' para o mencionado do tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/leads/${leadId}/notes`,
      headers: { cookie: await loginAs(userA1) },
      payload: { body: "Retomar contato amanhã @a2", mentions: [userA2] }
    });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    expect(note.body).toBe("Retomar contato amanhã @a2");
    expect(note.author_id).toBe(userA1);
    expect(note.author_name).toBeTypeOf("string");
    expect(note.mentions).toEqual([{ id: userA2, name: expect.any(String) }]);

    expect(await mentionCount(userA2, note.id)).toBe(1);
    expect(await mentionCount(userA1, note.id)).toBe(0);

    const list = await app.inject({ url: `/leads/${leadId}/notes`, headers: { cookie: await loginAs(userA1) } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(note.id);
    expect(list.json().items[0].mentions[0].id).toBe(userA2);
    // Fonte unificada: a nota vive em scheduling_lead_notes com mentions.
    const row = await pool.query<{ mentions: string[] | null }>(
      "SELECT mentions FROM scheduling_lead_notes WHERE tenant_id=$1 AND lead_id=$2 AND id=$3",
      [tenantA, leadId, note.id]
    );
    expect(row.rows[0].mentions).toEqual([userA2]);
  });

  it("menção a usuário de outro tenant → 400 e nada é gravado", async () => {
    const before = await pool.query<{ count: number }>("SELECT count(*)::int count FROM internal_notifications WHERE tenant_id=$1", [tenantA]);
    const created = await app.inject({
      method: "POST",
      url: `/leads/${leadId}/notes`,
      headers: { cookie: await loginAs(userA1) },
      payload: { body: "Menção inválida", mentions: [userB1] }
    });
    expect(created.statusCode).toBe(400);
    const after = await pool.query<{ count: number }>("SELECT count(*)::int count FROM internal_notifications WHERE tenant_id=$1", [tenantA]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("menção a si mesmo não notifica o autor; nota sem menções não cria evento", async () => {
    const self = await app.inject({
      method: "POST",
      url: `/leads/${leadId}/notes`,
      headers: { cookie: await loginAs(userA1) },
      payload: { body: "Nota própria", mentions: [userA1] }
    });
    expect(self.statusCode).toBe(201);
    expect(self.json().mentions).toEqual([{ id: userA1, name: expect.any(String) }]);
    expect(await mentionCount(userA1, self.json().id)).toBe(0);

    const plain = await app.inject({
      method: "POST",
      url: `/leads/${leadId}/notes`,
      headers: { cookie: await loginAs(userA1) },
      payload: { body: "Nota sem menções" }
    });
    expect(plain.statusCode).toBe(201);
    expect(await mentionCount(userA1, plain.json().id)).toBe(0);
  });

  it("nota de conversa gera 'mention' para o mencionado; leitura espelha conversations.read", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/notes`,
      headers: { cookie: await loginAs(userA1) },
      payload: { body: "Conferir protocolo do cliente", mentions: [userA2] }
    });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    expect(note.body).toBe("Conferir protocolo do cliente");
    expect(await mentionCount(userA2, note.id)).toBe(1);

    const list = await app.inject({ url: `/conversations/${conversationId}/notes`, headers: { cookie: await loginAs(userA2) } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(note.id);
  });

  it("permissões: sem conversations.read/leads.follow_up.manage → 403; conversa de outro tenant → 404", async () => {
    const cookieA3 = await loginAs(userA3);
    expect((await app.inject({ url: `/conversations/${conversationId}/notes`, headers: { cookie: cookieA3 } })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: `/leads/${leadId}/notes`,
      headers: { cookie: cookieA3 },
      payload: { body: "sem permissão" }
    })).statusCode).toBe(403);

    const cookieB1 = await loginAs(userB1);
    expect((await app.inject({ url: `/conversations/${conversationId}/notes`, headers: { cookie: cookieB1 } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/leads/${leadId}/notes`, headers: { cookie: cookieB1 } })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/notes`,
      headers: { cookie: cookieB1 },
      payload: { body: "cross-tenant" }
    })).statusCode).toBe(404);
  });

  it("lead na lixeira → 404 em GET/POST de notas (deleted_at IS NULL)", async () => {
    await pool.query("UPDATE scheduling_leads SET deleted_at=now() WHERE id=$1", [leadId]);
    try {
      expect((await app.inject({ url: `/leads/${leadId}/notes`, headers: { cookie: await loginAs(userA1) } })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST",
        url: `/leads/${leadId}/notes`,
        headers: { cookie: await loginAs(userA1) },
        payload: { body: "nota em lead na lixeira" }
      })).statusCode).toBe(404);
    } finally {
      await pool.query("UPDATE scheduling_leads SET deleted_at=NULL WHERE id=$1", [leadId]);
    }
  });
});
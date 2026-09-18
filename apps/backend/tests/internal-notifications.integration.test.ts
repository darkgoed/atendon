// W1B — central de notificações internas por usuário (R2).
// Isolamento: feed é SEMPRE escopado ao user_id do token (tenant A/B e
// usuários distintos), unread count, read/read-all idempotentes e keyset.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "internal-notification-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let userA1 = "";
let userA2 = "";
let userA3 = "";
let userB1 = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();
const notificationA1: string[] = [];
let notificationB1 = "";
let notificationSequence = 0;

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

async function insertNotification(tenantId: string, userId: string, overrides: Partial<{ type: string; title: string; body: string; read: boolean }> = {}) {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO internal_notifications(tenant_id,user_id,type,title,body,source_type,actor_id,read_at,created_at)
     VALUES($1,$2,$3,$4,$5,'internal_note',NULL,CASE WHEN $6 THEN now() ELSE NULL END, now() - ($7 || ' seconds')::interval)
     RETURNING id`,
    [tenantId, userId, overrides.type ?? "mention", overrides.title ?? "Você foi mencionado", overrides.body ?? "corpo", overrides.read ?? false, String(notificationSequence++)]
  );
  return row.rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [tenantName, emailsForTenant] of [
      [`InternalNotifications A ${randomUUID()}`, [`notif-a1-${randomUUID()}@test.local`, `notif-a2-${randomUUID()}@test.local`, `notif-a3-${randomUUID()}@test.local`]],
      [`InternalNotifications B ${randomUUID()}`, [`notif-b1-${randomUUID()}@test.local`]]
    ] as const) {
      const tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [tenantName])).rows[0].id;
      if (!tenantA) tenantA = tenantId; else tenantB = tenantId;
      await ensureWorkspaceDefaultRoles(client, tenantId);
      const ownerRole = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantId])).rows[0].id;
      for (const email of emailsForTenant) {
        const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status,name) VALUES($1,$2,'active',$3) RETURNING id", [email, await hash(password, 4), `Usuário ${emails.size + 1}`]);
        await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, ownerRole]);
        emails.set(user.rows[0].id, email);
      }
    }
    const aUsers = [...emails.keys()];
    userA1 = aUsers[0]; userA2 = aUsers[1]; userA3 = aUsers[2]; userB1 = aUsers[3];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  notificationA1.push(await insertNotification(tenantA, userA1));
  notificationA1.push(await insertNotification(tenantA, userA1, { type: "task_assigned", title: "Tarefa atribuída" }));
  notificationA1.push(await insertNotification(tenantA, userA1, { read: true }));
  notificationB1 = await insertNotification(tenantB, userB1);
  await insertNotification(tenantA, userA2);
  await pool.query("UPDATE internal_notifications SET actor_id=$1 WHERE id=$2", [userA2, notificationA1[0]]);
  for (let index = 0; index < 35; index++) await insertNotification(tenantA, userA3);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("central de notificações internas", () => {
  it("feed é user-scoped: itens, total_unread, filtro unread e actor_name", async () => {
    const feed = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userA1) } });
    expect(feed.statusCode).toBe(200);
    const body = feed.json();
    expect(body.items).toHaveLength(3);
    expect(body.total_unread).toBe(2);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(notificationA1));
    expect(body.items.map((item: { id: string }) => item.id)).not.toContain(notificationB1);
    expect(body.page.has_more).toBe(false);
    expect(body.page.next_cursor).toBeNull();
    const withActor = body.items.find((item: { id: string }) => item.id === notificationA1[0]);
    expect(withActor.actor_name).toBeTypeOf("string");

    const unread = await app.inject({ url: "/me/internal-notifications?unread=true", headers: { cookie: await loginAs(userA1) } });
    expect(unread.json().items).toHaveLength(2);
    expect(unread.json().total_unread).toBe(2);
  });

  it("isola por tenant e usuário: A2 só vê as suas, B1 nunca vê nada de A", async () => {
    const feedA2 = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userA2) } });
    expect(feedA2.json().total_unread).toBe(1);
    expect(feedA2.json().items.map((item: { id: string }) => item.id)).not.toContain(notificationA1[0]);

    const feedB1 = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userB1) } });
    const ids = feedB1.json().items.map((item: { id: string }) => item.id);
    expect(ids).toEqual([notificationB1]);
    for (const id of notificationA1) expect(ids).not.toContain(id);
  });

  it("keyset cursor: limit default 30, has_more e próxima página sem repetir", async () => {
    const first = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userA3) } });
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(30);
    expect(firstBody.page.has_more).toBe(true);
    expect(firstBody.page.next_cursor).toBeTypeOf("string");
    const second = await app.inject({ url: `/me/internal-notifications?cursor=${firstBody.page.next_cursor}`, headers: { cookie: await loginAs(userA3) } });
    const secondBody = second.json();
    expect(secondBody.items).toHaveLength(5);
    expect(secondBody.page.has_more).toBe(false);
    const firstIds = new Set(firstBody.items.map((item: { id: string }) => item.id));
    for (const item of secondBody.items) expect(firstIds.has(item.id)).toBe(false);
  });

  it("read marca só a própria; re-read idempotente; id de outro usuário/tenant → 404", async () => {
    const read = await app.inject({ method: "POST", url: `/me/internal-notifications/${notificationA1[0]}/read`, headers: { cookie: await loginAs(userA1) } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ ok: true });
    const again = await app.inject({ method: "POST", url: `/me/internal-notifications/${notificationA1[0]}/read`, headers: { cookie: await loginAs(userA1) } });
    expect(again.statusCode).toBe(200);
    const unread = await app.inject({ url: "/me/internal-notifications?unread=true", headers: { cookie: await loginAs(userA1) } });
    expect(unread.json().items).toHaveLength(1);

    const foreignUser = await app.inject({ method: "POST", url: `/me/internal-notifications/${notificationB1}/read`, headers: { cookie: await loginAs(userA1) } });
    expect(foreignUser.statusCode).toBe(404);

    const foreignTenant = await app.inject({ method: "POST", url: `/me/internal-notifications/${notificationA1[1]}/read`, headers: { cookie: await loginAs(userB1) } });
    expect(foreignTenant.statusCode).toBe(404);
  });

  it("read-all zera o unread só do chamador (outro usuário e outro tenant intactos)", async () => {
    const readAll = await app.inject({ method: "POST", url: "/me/internal-notifications/read-all", headers: { cookie: await loginAs(userA1) } });
    expect(readAll.statusCode).toBe(200);
    expect(readAll.json().updated).toBe(1);
    const feed = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userA1) } });
    expect(feed.json().total_unread).toBe(0);

    const feedA2 = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userA2) } });
    expect(feedA2.json().total_unread).toBe(1);
    const feedB1 = await app.inject({ url: "/me/internal-notifications", headers: { cookie: await loginAs(userB1) } });
    expect(feedB1.json().total_unread).toBe(1);
  });
});
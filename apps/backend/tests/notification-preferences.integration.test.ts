import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let conversationId = "";
let firstCookie = "";
let secondCookie = "";

async function login(email: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  return (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"]!).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Notifications ${randomUUID()}`])).rows[0].id;
  const client = await pool.connect();
  const password = "notification-password";
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const role = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantId])).rows[0].id;
    for (const email of [`notify-a-${randomUUID()}@test.local`, `notify-b-${randomUUID()}@test.local`]) {
      const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)]);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, role]);
      if (!firstCookie) firstCookie = email; else secondCookie = email;
    }
    const session = await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId]);
    conversationId = (await client.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,'5511999000101','Contato silenciado') RETURNING id",
      [tenantId, session.rows[0].id]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  [firstCookie, secondCookie] = await Promise.all([login(firstCookie, password), login(secondCookie, password)]);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await app.close();
  await pool.end();
});

describe("personal panel notification preferences", () => {
  it("defaults to enabled and isolates controls and mutes per user/workspace", async () => {
    const defaults = await app.inject({ url: "/me/notification-preferences", headers: { cookie: firstCookie } });
    expect(defaults.json()).toMatchObject({
      preferences: { enabled: true, sound_enabled: true, visual_enabled: true },
      muted_conversations: []
    });
    const changed = await app.inject({
      method: "PATCH",
      url: "/me/notification-preferences",
      headers: { cookie: firstCookie },
      payload: { sound_enabled: false }
    });
    expect(changed.json().preferences).toEqual({ enabled: true, sound_enabled: false, visual_enabled: true, sound_key: null, volume: null });
    expect((await app.inject({ url: "/me/notification-preferences", headers: { cookie: secondCookie } })).json().preferences.sound_enabled).toBe(true);

    expect((await app.inject({
      method: "PATCH",
      url: `/conversations/${conversationId}/notification-mute`,
      headers: { cookie: firstCookie },
      payload: { muted: true }
    })).statusCode).toBe(200);
    expect((await app.inject({ url: "/me/notification-preferences", headers: { cookie: firstCookie } })).json().muted_conversations[0].id).toBe(conversationId);
    expect((await app.inject({ url: "/me/notification-preferences", headers: { cookie: secondCookie } })).json().muted_conversations).toEqual([]);
  });
});

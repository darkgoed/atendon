// W1B — preferências por usuário (R1/R16): sound_key/volume na preferência de
// notificação e aparência por usuário.
// Os handlers de /me/notification-preferences do patch do orquestrador
// (app.ts) são espelhados sob /test/me/... para não duplicar a rota real
// enquanto app.ts não é integrado; /me/appearance-preferences é rota nova
// deste módulo e é testada no caminho real.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { registerPanelNotificationPreferenceHandlers } from "../src/modules/internal/prefs-routes.js";

const password = "user-prefs-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
// registerInternalPreferenceRoutes já é registrado em app.ts pelo orquestrador;
// aqui só os handlers espelhados sob /test.
void app.register(async (instance) => registerPanelNotificationPreferenceHandlers(instance), { prefix: "/test" });
let tenantA = "";
let userA1 = "";
let userA2 = "";
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

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`UserPrefs ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    const ownerRole = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantA])).rows[0].id;
    await createUser(client, tenantA, ownerRole, `prefs-a1-${randomUUID()}@test.local`);
    await createUser(client, tenantA, ownerRole, `prefs-a2-${randomUUID()}@test.local`);
    const ids = [...emails.keys()];
    userA1 = ids[0];
    userA2 = ids[1];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantA]);
  await app.close();
  await pool.end();
});

describe("preferências de notificação (sound_key/volume)", () => {
  it("defaults do painel e isolamento por usuário", async () => {
    const first = await app.inject({ url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) } });
    expect(first.statusCode).toBe(200);
    expect(first.json().preferences).toMatchObject({ enabled: true, sound_enabled: true, visual_enabled: true, sound_key: null, volume: null });

    const changed = await app.inject({
      method: "PATCH",
      url: "/test/me/notification-preferences",
      headers: { cookie: await loginAs(userA1) },
      payload: { sound_key: "ding", volume: 80 }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().preferences).toEqual({ enabled: true, sound_enabled: true, visual_enabled: true, sound_key: "ding", volume: 80 });

    const persisted = await app.inject({ url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) } });
    expect(persisted.json().preferences).toEqual({ enabled: true, sound_enabled: true, visual_enabled: true, sound_key: "ding", volume: 80 });

    const second = await app.inject({ url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA2) } });
    expect(second.json().preferences.sound_key).toBeNull();
    expect(second.json().preferences.volume).toBeNull();
  });

  it("volume inválido → 400; limites 0 e 100 aceitos", async () => {
    for (const volume of [150, -1, 101, 2.5, "80"]) {
      const invalid = await app.inject({
        method: "PATCH",
        url: "/test/me/notification-preferences",
        headers: { cookie: await loginAs(userA1) },
        payload: { volume }
      });
      expect(invalid.statusCode).toBe(400);
    }
    const zero = await app.inject({ method: "PATCH", url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) }, payload: { volume: 0 } });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().preferences.volume).toBe(0);
    const max = await app.inject({ method: "PATCH", url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) }, payload: { volume: 100 } });
    expect(max.json().preferences.volume).toBe(100);
  });

  it("null explícito reseta sound_key/volume; campo ausente mantém", async () => {
    const patch = await app.inject({ method: "PATCH", url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) }, payload: { sound_key: "chime", volume: 40 } });
    expect(patch.json().preferences).toMatchObject({ sound_key: "chime", volume: 40 });
    const partial = await app.inject({ method: "PATCH", url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) }, payload: { volume: 55 } });
    expect(partial.json().preferences).toMatchObject({ sound_key: "chime", volume: 55 });
    const reset = await app.inject({ method: "PATCH", url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) }, payload: { sound_key: null } });
    expect(reset.json().preferences).toMatchObject({ sound_key: null, volume: 55 });
    expect((await app.inject({ url: "/test/me/notification-preferences", headers: { cookie: await loginAs(userA1) } })).json().preferences.sound_key).toBeNull();
  });
});

describe("preferências de aparência por usuário", () => {
  it("persiste tema/densidade/accent por usuário e não vaza para outro", async () => {
    const first = await app.inject({ url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ theme: null, accent: null, density: null });

    const patch = await app.inject({
      method: "PATCH",
      url: "/me/appearance-preferences",
      headers: { cookie: await loginAs(userA1) },
      payload: { theme: "dark", density: "compact" }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ theme: "dark", accent: null, density: "compact" });

    const second = await app.inject({ url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA2) } });
    expect(second.json()).toEqual({ theme: null, accent: null, density: null });

    const partial = await app.inject({
      method: "PATCH",
      url: "/me/appearance-preferences",
      headers: { cookie: await loginAs(userA1) },
      payload: { accent: "indigo" }
    });
    expect(partial.json()).toEqual({ theme: "dark", accent: "indigo", density: "compact" });

    const reset = await app.inject({ method: "PATCH", url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) }, payload: { theme: null } });
    expect(reset.json()).toEqual({ theme: null, accent: "indigo", density: "compact" });
    expect((await app.inject({ url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) } })).json()).toEqual({ theme: null, accent: "indigo", density: "compact" });
  });

  it("valores inválidos → 400 (tema/densidade desconhecidos, corpo vazio, campo extra)", async () => {
    expect((await app.inject({ method: "PATCH", url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) }, payload: { theme: "blue" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) }, payload: { density: "spacious" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/me/appearance-preferences", headers: { cookie: await loginAs(userA1) }, payload: { theme: "dark", extra: true } })).statusCode).toBe(400);
  });
});
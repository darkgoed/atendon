import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const email = `logout-${suffix}@test.local`;
const password = "logout-test-password";
let userId = "";
let tenantId = "";

function cookie(response: { headers: { [key: string]: unknown } }) {
  const value = response.headers["set-cookie"] as string | string[];
  return (Array.isArray(value) ? value[0] : value).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Logout ${suffix}`, `logout-${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    userId = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)])).rows[0].id;
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantId, userId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
  await app.close();
});

describe("POST /auth/logout session revocation", () => {
  it("revokes replayed and parallel cookies for the same user", async () => {
    const first = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const second = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const cookieA = cookie(first); const cookieB = cookie(second);
    expect((await app.inject({ url: "/me", headers: { cookie: cookieA } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: cookieA } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/me", headers: { cookie: cookieA } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: { cookie: cookieB } })).statusCode).toBe(401);
  });

  it("propagates a database failure from GET /me as 500 with a valid token", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const sessionCookie = cookie(login);
    const query = vi.spyOn(db, "query").mockRejectedValueOnce(new Error("database unavailable"));
    try {
      const response = await app.inject({ method: "GET", url: "/me", headers: { cookie: sessionCookie } });
      expect(response.statusCode).toBe(500);
    } finally {
      query.mockRestore();
    }
  });

  it("continues to reject an invalid token with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/me", headers: { cookie: "atendon_session=invalid" } });
    expect(response.statusCode).toBe(401);
  });

  it("propagates a database failure during logout as 500", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const sessionCookie = cookie(login);
    const query = vi.spyOn(db, "query").mockRejectedValueOnce(new Error("database unavailable"));
    try {
      const response = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: sessionCookie } });
      expect(response.statusCode).toBe(500);
    } finally {
      query.mockRestore();
    }
  });
  it("is idempotent without a cookie or with an invalid cookie", async () => {
    for (const headers of [{}, { cookie: "atendon_session=invalid" }]) {
      const response = await app.inject({ method: "POST", url: "/auth/logout", headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain("atendon_session=");
      expect(response.headers["set-cookie"]).toContain("Path=/");
    }
  });
});

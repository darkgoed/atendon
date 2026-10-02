import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantId = "";
let userId = "";
let cookie = "";
let sessionId = "";

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`AuthScope ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    userId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`auth-scope-${suffix}@test.local`])).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status)
       SELECT $1,$2,id,'active' FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, userId]
    );
    await client.query("COMMIT");
  } finally { client.release(); }
  cookie = `atendon_session=${await createSessionToken({
    userId,
    tenantId,
    email: `auth-scope-${suffix}@test.local`,
    role: "OWNER"
  })}`;
});

afterAll(async () => {
  await pool.query("DELETE FROM workspace_sessions WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
  await app.close();
});

describe("auth request-scoped (sem cache entre requests)", () => {
  it("request autenticada seguida de bump de session_version → 401 na request seguinte", async () => {
    const before = await app.inject({ url: "/me", headers: { cookie } });
    expect(before.statusCode).toBe(200);

    await pool.query("UPDATE users SET session_version=session_version+1 WHERE id=$1", [userId]);
    const after = await app.inject({ url: "/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("workspace_session revogada → 401 na request seguinte", async () => {
    sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO workspace_sessions(id,user_id,tenant_id,kind,expires_at) VALUES($1,$2,$3,'session',now()+interval '1 hour') RETURNING id",
      [randomUUID(), userId, tenantId]
    )).rows[0].id;
    await pool.query("UPDATE users SET session_version=session_version+1 WHERE id=$1", [userId]);
    const scopedCookie = `atendon_session=${await createSessionToken({
      userId,
      tenantId,
      email: `auth-scope-${suffix}@test.local`,
      role: "OWNER",
      sid: sessionId
    })}`;
    const ok = await app.inject({ url: "/me", headers: { cookie: scopedCookie } });
    expect(ok.statusCode).toBe(200);

    await pool.query("UPDATE workspace_sessions SET revoked_at=now() WHERE id=$1", [sessionId]);
    const revoked = await app.inject({ url: "/me", headers: { cookie: scopedCookie } });
    expect(revoked.statusCode).toBe(401);
  });

  it("erro de autenticação não vira resultado aproveitável: request seguinte reavalia", async () => {
    // Restaura a versão que o cookie original carrega e confirma que a
    // request volta a autenticar (nenhum 401 ficou memoizado).
    await pool.query("UPDATE users SET session_version=1 WHERE id=$1", [userId]);
    const recovered = await app.inject({ url: "/me", headers: { cookie } });
    expect(recovered.statusCode).toBe(200);
  });
});

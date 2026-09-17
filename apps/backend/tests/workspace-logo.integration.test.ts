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
const ownerEmail = `logo-owner-${suffix}@test.local`;
const operatorEmail = `logo-operator-${suffix}@test.local`;
const foreignOwnerEmail = `logo-foreign-owner-${suffix}@test.local`;
let tenantId = "";
let foreignTenantId = "";
let ownerUserId = "";
let operatorUserId = "";
let foreignOwnerUserId = "";
let ownerCookie = "";
let operatorCookie = "";
let foreignOwnerCookie = "";

const LOGO_PREFIX = "data:image/png;base64,";
const validLogo = `${LOGO_PREFIX}${Buffer.from("fake-png-bytes").toString("base64")}`;

async function cookieFor(userId: string, email: string, activeTenantId: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId,tenantId: activeTenantId,email,role })}`;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Logo ${suffix}`])).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Logo foreign ${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client,tenantId);
    await ensureWorkspaceDefaultRoles(client,foreignTenantId);
    ownerUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[ownerEmail])).rows[0].id;
    operatorUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[operatorEmail])).rows[0].id;
    foreignOwnerUserId = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[foreignOwnerEmail])).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId,ownerUserId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [tenantId,operatorUserId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [foreignTenantId,foreignOwnerUserId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = await cookieFor(ownerUserId,ownerEmail,tenantId,"OWNER");
  operatorCookie = await cookieFor(operatorUserId,operatorEmail,tenantId,"OPERADOR");
  foreignOwnerCookie = await cookieFor(foreignOwnerUserId,foreignOwnerEmail,foreignTenantId,"OWNER");
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])",[[ownerUserId,operatorUserId,foreignOwnerUserId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[[tenantId,foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[ownerUserId,operatorUserId,foreignOwnerUserId]]);
  await pool.end();
  await app.close();
});

describe("workspace logo REST API",() => {
  it("saves the logo, returns it on /me and clears it on DELETE",async () => {
    const patched = await app.inject({
      method: "PATCH",url: "/workspaces/current/logo",headers: { cookie: ownerCookie },
      payload: { logo_data: validLogo }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().workspace).toMatchObject({ id: tenantId,name: `Logo ${suffix}`,logo_data: validLogo });

    const me = await app.inject({ method: "GET",url: "/me",headers: { cookie: ownerCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeWorkspace).toMatchObject({ id: tenantId,logo_data: validLogo });

    const cleared = await app.inject({
      method: "DELETE",url: "/workspaces/current/logo",headers: { cookie: ownerCookie }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().workspace).toMatchObject({ id: tenantId,logo_data: null });

    const meAfterDelete = await app.inject({ method: "GET",url: "/me",headers: { cookie: ownerCookie } });
    expect(meAfterDelete.json().activeWorkspace.logo_data).toBeNull();
  });

  it("rejects invalid payloads with 400",async () => {
    const oversizeBase64 = Buffer.alloc(150_001,"a").toString("base64");
    const cases: unknown[] = [
      123,
      "not-a-data-url",
      "data:image/gif;base64,R0lGOD",
      "data:image/png;base64,!!!not-base64!!!",
      `${LOGO_PREFIX}${oversizeBase64}`
    ];
    for (const logo_data of cases) {
      const response = await app.inject({
        method: "PATCH",url: "/workspaces/current/logo",headers: { cookie: ownerCookie },
        payload: { logo_data }
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await pool.query<{ logo_data: string | null }>(
      "SELECT logo_data FROM tenants WHERE id=$1",[tenantId]
    )).rows[0].logo_data).toBeNull();
  });

  it("requires workspace.update permission",async () => {
    expect((await app.inject({
      method: "PATCH",url: "/workspaces/current/logo",headers: { cookie: operatorCookie },
      payload: { logo_data: validLogo }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "DELETE",url: "/workspaces/current/logo",headers: { cookie: operatorCookie }
    })).statusCode).toBe(403);
  });

  it("isolates logos per tenant",async () => {
    const patched = await app.inject({
      method: "PATCH",url: "/workspaces/current/logo",headers: { cookie: ownerCookie },
      payload: { logo_data: validLogo }
    });
    expect(patched.statusCode).toBe(200);

    const foreignMe = await app.inject({ method: "GET",url: "/me",headers: { cookie: foreignOwnerCookie } });
    expect(foreignMe.statusCode).toBe(200);
    expect(foreignMe.json().activeWorkspace).toMatchObject({ id: foreignTenantId,logo_data: null });
    expect(foreignMe.json().workspaces).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tenantId })
    ]));

    const foreignPatch = await app.inject({
      method: "PATCH",url: "/workspaces/current/logo",headers: { cookie: foreignOwnerCookie },
      payload: { logo_data: validLogo }
    });
    expect(foreignPatch.statusCode).toBe(200);
    expect((await pool.query<{ logo_data: string | null }>(
      "SELECT logo_data FROM tenants WHERE id=$1",[tenantId]
    )).rows[0].logo_data).toBe(validLogo);
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const FLAG = "scheduling_meeting_confirmation_v1";
const SETTINGS_URL = "/settings/ai-meeting-confirmation";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const managerAEmail = `conf-manager-a-${suffix}@test.local`;
const operatorAEmail = `conf-operator-a-${suffix}@test.local`;
const managerBEmail = `conf-manager-b-${suffix}@test.local`;
let tenantA = "";
let tenantB = "";
let managerAUserId = "";
let operatorAUserId = "";
let managerBUserId = "";
let managerACookie = "";
let operatorACookie = "";
let managerBCookie = "";

async function cookieFor(token: string) {
  return `atendon_session=${token}`;
}

function settingsRequest(cookie: string, payload?: unknown) {
  return app.inject({
    method: "PUT",
    url: SETTINGS_URL,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
}

async function effectiveFlag(cookie: string) {
  const response = await app.inject({ url: "/feature-flags", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return (response.json().flags as Record<string, boolean>)[FLAG];
}

async function persistedOverride(tenantId: string) {
  const result = await pool.query<{ enabled: boolean; updated_by_user_id: string | null }>(
    "SELECT enabled,updated_by_user_id FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key=$2",
    [tenantId, FLAG]
  );
  return result.rows[0] ?? null;
}

async function overrideKeys(tenantId: string) {
  const result = await pool.query<{ flag_key: string }>(
    "SELECT flag_key FROM tenant_feature_flag_overrides WHERE tenant_id=$1 ORDER BY flag_key",
    [tenantId]
  );
  return result.rows.map((row) => row.flag_key);
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`MeetingConf A ${suffix}`]
    )).rows[0].id;
    tenantB = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`MeetingConf B ${suffix}`]
    )).rows[0].id;
    // Legacy integration-fixture trigger (only in atendon_test) seeds capability
    // overrides; remove them so per-tenant assertions see only this suite's rows.
    await client.query(
      `DELETE FROM tenant_feature_flag_overrides
       WHERE tenant_id=ANY($1::uuid[])
         AND flag_key=ANY($2::text[])`,
      [[tenantA, tenantB], ["dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1", "workspace_admin_v1"]]
    );
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    managerAUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [managerAEmail]
    )).rows[0].id;
    operatorAUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [operatorAEmail]
    )).rows[0].id;
    managerBUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [managerBEmail]
    )).rows[0].id;
    for (const [tenantId, userId, role] of [
      [tenantA, managerAUserId, "OWNER"],
      [tenantA, operatorAUserId, "OPERADOR"],
      [tenantB, managerBUserId, "OWNER"]
    ] as const) {
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now()
         FROM workspace_roles
         WHERE workspace_id=$1 AND name=$3`,
        [tenantId, userId, role]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  managerACookie = await cookieFor(await createSessionToken({
    userId: managerAUserId,
    tenantId: tenantA,
    email: managerAEmail,
    role: "OWNER"
  }));
  operatorACookie = await cookieFor(await createSessionToken({
    userId: operatorAUserId,
    tenantId: tenantA,
    email: operatorAEmail,
    role: "OPERADOR"
  }));
  managerBCookie = await cookieFor(await createSessionToken({
    userId: managerBUserId,
    tenantId: tenantB,
    email: managerBEmail,
    role: "OWNER"
  }));
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])",
    [[tenantA, tenantB]]
  );
  await pool.query(
    "DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])",
    [[managerAUserId, operatorAUserId, managerBUserId]]
  );
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[managerAUserId, operatorAUserId, managerBUserId]]);
  await pool.end();
  await app.close();
});

describe("PUT /settings/ai-meeting-confirmation", () => {
  it("rejects an operator without agent.manage and writes nothing", async () => {
    const unauthenticated = await app.inject({ method: "PUT", url: SETTINGS_URL, payload: { enabled: true } });
    expect(unauthenticated.statusCode).toBe(401);

    const forbidden = await settingsRequest(operatorACookie, { enabled: true });
    expect(forbidden.statusCode).toBe(403);
    expect(await persistedOverride(tenantA)).toBeNull();
    expect(await effectiveFlag(operatorACookie)).toBe(false);
  });

  it("lets the manager toggle the own tenant flag and persists the effective value", async () => {
    const enabled = await settingsRequest(managerACookie, { enabled: true });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ enabled: true });

    expect(await effectiveFlag(managerACookie)).toBe(true);
    expect(await persistedOverride(tenantA)).toMatchObject({
      enabled: true,
      updated_by_user_id: managerAUserId
    });

    const disabled = await settingsRequest(managerACookie, { enabled: false });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ enabled: false });

    expect(await effectiveFlag(managerACookie)).toBe(false);
    expect(await persistedOverride(tenantA)).toMatchObject({
      enabled: false,
      updated_by_user_id: managerAUserId
    });
  });

  it("keeps tenant B isolated from tenant A changes in both directions", async () => {
    await settingsRequest(managerACookie, { enabled: true });
    expect(await effectiveFlag(managerBCookie)).toBe(false);
    expect(await persistedOverride(tenantB)).toBeNull();

    const enabledB = await settingsRequest(managerBCookie, { enabled: true });
    expect(enabledB.statusCode).toBe(200);
    expect(enabledB.json()).toEqual({ enabled: true });
    expect(await effectiveFlag(managerACookie)).toBe(true);

    await settingsRequest(managerBCookie, { enabled: false });
    expect(await effectiveFlag(managerBCookie)).toBe(false);
    expect(await effectiveFlag(managerACookie)).toBe(true);
  });

  it("cannot change other flags or reach other tenants through this endpoint", async () => {
    for (const payload of [
      { enabled: true, key: "compact_prompt_v2" },
      { enabled: true, flag_key: "compact_prompt_v2" },
      { enabled: true, tenantId: tenantB },
      { enabled: "true" },
      {}
    ]) {
      const rejected = await settingsRequest(managerACookie, payload);
      expect(rejected.statusCode).toBe(400);
    }

    // Only this suite's flag was ever overridden, and the 400s changed nothing.
    expect(await overrideKeys(tenantA)).toEqual([FLAG]);
    expect(await overrideKeys(tenantB)).toEqual([FLAG]);
    expect(await effectiveFlag(managerACookie)).toBe(true);
    expect(await effectiveFlag(managerBCookie)).toBe(false);

    // No ROOT route access for the manager: no arbitrary tenant/flag writes.
    const rootOverride = await app.inject({
      method: "PUT",
      url: `/root/workspaces/${tenantB}/feature-flags/${FLAG}/override`,
      headers: { cookie: managerACookie },
      payload: { enabled: true }
    });
    expect(rootOverride.statusCode).toBe(403);
    expect((await app.inject({
      url: "/root/feature-flags",
      headers: { cookie: managerACookie }
    })).statusCode).toBe(403);
    expect(await persistedOverride(tenantB)).toMatchObject({ enabled: false });
  });
});

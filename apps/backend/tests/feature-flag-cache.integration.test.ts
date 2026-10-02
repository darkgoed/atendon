import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import {
  clearEffectiveFlagsCacheForTests,
  effectiveFlagsCacheKeysForTests,
  listEffectiveFeatureFlags,
  setEffectiveFlagsCacheOverrideForTests
} from "../src/modules/operations/feature-flags.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const rootEmail = `flag-cache-root-${suffix}@test.local`;
let tenantA = "";
let tenantB = "";
let rootCookie = "";

async function workspaceFlags(cookie: string) {
  const response = await app.inject({ url: "/feature-flags", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().flags as Record<string, boolean>;
}

beforeAll(async () => {
  // Hooks de teste ligam o caminho real de produção (cache por tenant com
  // invalidação pós-COMMIT) mesmo fora de NODE_ENV=production.
  setEffectiveFlagsCacheOverrideForTests(true);
  clearEffectiveFlagsCacheForTests();
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`FlagCache A ${suffix}`]
    )).rows[0].id;
    tenantB = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`FlagCache B ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    const rootUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
      [rootEmail]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status) SELECT $1,$2,id,'active' FROM workspace_roles WHERE workspace_id=$1 AND name='ROOT'",
      [tenantA, rootUserId]
    );
    await client.query("COMMIT");
    rootCookie = `atendon_session=${await createSessionToken({
      userId: rootUserId,
      tenantId: tenantA,
      email: rootEmail,
      role: "ROOT",
      isRoot: true,
      rootWorkspaceAccess: true
    })}`;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  clearEffectiveFlagsCacheForTests();
  setEffectiveFlagsCacheOverrideForTests(null);
  await pool.query(
    `DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])`,
    [[tenantA, tenantB]]
  );
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM workspace_sessions WHERE user_id IN (SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM users WHERE email=$1", [rootEmail]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.end();
});

describe("cache de feature flags — invalidação dirigida", () => {
  it("toggle global via rota reflete imediatamente (invalidação pós-COMMIT, não TTL)", async () => {
    const key = "ai_turn_visibility_v1";
    // O estado original pode ser NULL (usa default) — restaurar "false"
    // explicitamente mudaria a semântica do catálogo para os outros testes.
    const originalGlobal = (await pool.query<{ global_enabled: boolean | null }>(
      "SELECT global_enabled FROM feature_flag_definitions WHERE flag_key=$1",
      [key]
    )).rows[0].global_enabled;

    // Popula o cache para tenantA e tenantB.
    expect((await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled).toBe(originalGlobal ?? false);
    expect((await listEffectiveFeatureFlags(pool, tenantB)).find((flag) => flag.key === key)!.enabled).toBe(originalGlobal ?? false);
    expect(effectiveFlagsCacheKeysForTests().sort()).toEqual([tenantA, tenantB].sort());

    const response = await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/global`,
      headers: { cookie: rootCookie },
      payload: { enabled: true }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().flag.globalEnabled, response.body).toBe(true);

    // Global afeta todos os tenants: cache inteiro foi limpo.
    expect(effectiveFlagsCacheKeysForTests()).toEqual([]);
    expect((await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled).toBe(true);
    expect((await listEffectiveFeatureFlags(pool, tenantB)).find((flag) => flag.key === key)!.enabled).toBe(true);

    const restore = await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/global`,
      headers: { cookie: rootCookie },
      payload: { enabled: originalGlobal }
    });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(
      (await pool.query<{ global_enabled: boolean | null }>(
        "SELECT global_enabled FROM feature_flag_definitions WHERE flag_key=$1",
        [key]
      )).rows[0].global_enabled
    ).toBe(originalGlobal);
    expect((await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled).toBe(originalGlobal ?? false);
  });

  it("override por tenant reflete só no tenant alvo e isola os demais", async () => {
    clearEffectiveFlagsCacheForTests();
    const key = "post_sales_v1";
    const originalA = (await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled;
    const originalB = (await listEffectiveFeatureFlags(pool, tenantB)).find((flag) => flag.key === key)!.enabled;
    expect(effectiveFlagsCacheKeysForTests().sort()).toEqual([tenantA, tenantB].sort());

    const response = await app.inject({
      method: "PUT",
      url: `/root/workspaces/${tenantA}/feature-flags/${key}/override`,
      headers: { cookie: rootCookie },
      payload: { enabled: !originalA }
    });
    expect(response.statusCode).toBe(200);

    // Apenas o tenantA foi invalidado; tenantB permanece em cache.
    expect(effectiveFlagsCacheKeysForTests()).toEqual([tenantB]);
    expect((await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled).toBe(!originalA);
    expect((await listEffectiveFeatureFlags(pool, tenantB)).find((flag) => flag.key === key)!.enabled).toBe(originalB);

    // Flags por workspace visíveis ao próprio workspace seguem o override.
    const flagsA = await workspaceFlags(rootCookie);
    expect(flagsA[key]).toBe(!originalA);

    await app.inject({
      method: "DELETE",
      url: `/root/workspaces/${tenantA}/feature-flags/${key}/override`,
      headers: { cookie: rootCookie }
    });
    expect((await listEffectiveFeatureFlags(pool, tenantA)).find((flag) => flag.key === key)!.enabled).toBe(originalA);
  });
});

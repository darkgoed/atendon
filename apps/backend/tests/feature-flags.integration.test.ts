import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { FEATURE_FLAG_KEYS } from "../src/modules/operations/feature-flags.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const rootEmail = `flags-root-${suffix}@test.local`;
const ownerAEmail = `flags-owner-a-${suffix}@test.local`;
const ownerBEmail = `flags-owner-b-${suffix}@test.local`;
let tenantA = "";
let tenantB = "";
let rootUserId = "";
let ownerAUserId = "";
let ownerBUserId = "";
let rootCookie = "";
let ownerACookie = "";
let ownerBCookie = "";

async function cookieFor(token: string) {
  return `atendon_session=${token}`;
}

async function workspaceFlags(cookie: string) {
  const response = await app.inject({ url: "/feature-flags", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().flags as Record<string, boolean>;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Flags A ${suffix}`]
    )).rows[0].id;
    tenantB = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Flags B ${suffix}`]
    )).rows[0].id;
    // This suite verifies catalog defaults themselves, so opt out of the
    // legacy integration-fixture trigger installed only in atendon_test.
    await client.query(
      `DELETE FROM tenant_feature_flag_overrides
       WHERE tenant_id=ANY($1::uuid[])
         AND flag_key=ANY($2::text[])`,
      [[tenantA, tenantB], ["dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1", "workspace_admin_v1"]]
    );
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    rootUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
      [rootEmail]
    )).rows[0].id;
    ownerAUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [ownerAEmail]
    )).rows[0].id;
    ownerBUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [ownerBEmail]
    )).rows[0].id;
    for (const [tenantId, userId] of [[tenantA, ownerAUserId], [tenantB, ownerBUserId]]) {
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now()
         FROM workspace_roles
         WHERE workspace_id=$1 AND name='OWNER'`,
        [tenantId, userId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  rootCookie = await cookieFor(await createSessionToken({
    userId: rootUserId,
    email: rootEmail,
    isRoot: true
  }));
  ownerACookie = await cookieFor(await createSessionToken({
    userId: ownerAUserId,
    tenantId: tenantA,
    email: ownerAEmail,
    role: "OWNER"
  }));
  ownerBCookie = await cookieFor(await createSessionToken({
    userId: ownerBUserId,
    tenantId: tenantB,
    email: ownerBEmail,
    role: "OWNER"
  }));
});

afterAll(async () => {
  await pool.query(
    `UPDATE feature_flag_definitions
     SET global_enabled=NULL,kill_switch_enabled=false,updated_by_user_id=NULL,updated_at=now()
     WHERE flag_key='compact_prompt_v2'`
  );
  await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [rootUserId]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[rootUserId, ownerAUserId, ownerBUserId]]);
  await pool.end();
  await app.close();
});

describe("operational feature flags", () => {
  it("exposes the exact catalog with released product flags ON and keeps workspace access read-only", async () => {
    const released = new Set([
      "scheduling_meet_outbox_v2",
      "case_organization_v1",
      "dashboard_widgets_v1",
      "web_push_v1",
    ]);
    const flags = await workspaceFlags(ownerACookie);
    expect(FEATURE_FLAG_KEYS).toHaveLength(20);
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
    expect(Object.entries(flags).every(([key, enabled]) => enabled === released.has(key))).toBe(true);

    expect((await app.inject({
      url: "/root/feature-flags",
      headers: { cookie: ownerACookie }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PATCH",
      url: "/root/feature-flags/compact_prompt_v2/global",
      headers: { cookie: ownerACookie },
      payload: { enabled: true }
    })).statusCode).toBe(403);

    const rootList = await app.inject({ url: "/root/feature-flags", headers: { cookie: rootCookie } });
    expect(rootList.statusCode).toBe(200);
    expect(rootList.json().flags).toHaveLength(20);
    expect(rootList.json().flags.every((flag: {
      key: string;
      defaultEnabled: boolean;
      globalEnabled: boolean | null;
      killSwitchEnabled: boolean;
    }) => !flag.defaultEnabled && flag.globalEnabled === (released.has(flag.key) ? true : null) && !flag.killSwitchEnabled)).toBe(true);
  });

  it("serves the capability catalog and applies dependency cascades atomically", async () => {
    const catalog = await app.inject({ url: "/capabilities", headers: { cookie: ownerACookie } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().capabilities).toHaveLength(7);
    expect(catalog.json().capabilities.find((item: { key: string }) => item.key === "pipeline_v1"))
      .toMatchObject({ displayName: "Pipeline", dependencies: ["leads_v1"], supported: true, enabled: false });
    expect(catalog.json().capabilities.find((item: { key: string }) => item.key === "tripz_ai_v1"))
      .toMatchObject({ displayName: "Tripz IA", availabilityMode: "supported_tenants", supported: false, enabled: false, source: "unsupported" });

    const enabled = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantA}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "pipeline_v1", override: true }] }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "pipeline_v1", override: true, reason: "direct" }),
      expect.objectContaining({ key: "leads_v1", override: true, reason: "dependency_required" })
    ]));
    expect(enabled.json().capabilities.find((item: { key: string }) => item.key === "pipeline_v1").enabled).toBe(true);

    const confirmation = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantA}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "leads_v1", override: false }] }
    });
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json()).toMatchObject({
      code: "CAPABILITY_CASCADE_CONFIRMATION_REQUIRED",
      affectedCapabilities: ["pipeline_v1"]
    });
    const unchanged = await app.inject({ url: "/capabilities", headers: { cookie: ownerACookie } });
    expect(unchanged.json().capabilities.find((item: { key: string }) => item.key === "leads_v1").enabled).toBe(true);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantA}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "leads_v1", override: false }], confirmCascade: true }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "leads_v1", override: false, reason: "direct" }),
      expect.objectContaining({ key: "pipeline_v1", override: false, reason: "cascade" })
    ]));
    const operationGroups = await pool.query<{ groups: number; entries: number }>(
      `SELECT count(DISTINCT operation_group)::int groups,count(*)::int entries
       FROM audit_logs
       WHERE actor_user_id=$1 AND workspace_id=$2
         AND operation_group=$3 AND resource_type='capability_override'`,
      [rootUserId, tenantA, disabled.json().operationGroup]
    );
    expect(operationGroups.rows[0]).toEqual({ groups: 1, entries: 2 });

    await pool.query(
      "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key=ANY($2::text[])",
      [tenantA, ["leads_v1", "pipeline_v1"]]
    );
  });

  it("keeps provisioned support tenant-scoped and preserves inheritance by null", async () => {
    const unsupported = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantB}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "tripz_ai_v1", override: true }] }
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", feature: "tripz_ai_v1" });

    await pool.query(
      "INSERT INTO tenant_capability_support(tenant_id,capability_key,provisioned_by) VALUES($1,'tripz_ai_v1','test')",
      [tenantA]
    );
    const supported = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantA}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "tripz_ai_v1", override: true }] }
    });
    expect(supported.statusCode).toBe(200);
    expect(supported.json().capabilities.find((item: { key: string }) => item.key === "tripz_ai_v1"))
      .toMatchObject({ supported: true, tenantOverride: true, enabled: true, source: "tenant_override" });

    const inherited = await app.inject({
      method: "PATCH",
      url: `/root/workspaces/${tenantA}/capabilities`,
      headers: { cookie: rootCookie },
      payload: { changes: [{ key: "tripz_ai_v1", override: null }] }
    });
    expect(inherited.statusCode).toBe(200);
    expect(inherited.json().capabilities.find((item: { key: string }) => item.key === "tripz_ai_v1"))
      .toMatchObject({ supported: true, tenantOverride: null, enabled: false, source: "default" });
    await pool.query("DELETE FROM tenant_capability_support WHERE tenant_id=$1", [tenantA]);
  });

  it("applies kill switch before tenant override, global and default, with audited rollback", async () => {
    const key = "compact_prompt_v2";
    const globalOn = await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/global`,
      headers: { cookie: rootCookie },
      payload: { enabled: true }
    });
    expect(globalOn.statusCode).toBe(200);
    expect((await workspaceFlags(ownerACookie))[key]).toBe(true);
    expect((await workspaceFlags(ownerBCookie))[key]).toBe(true);

    const tenantOff = await app.inject({
      method: "PUT",
      url: `/root/workspaces/${tenantA}/feature-flags/${key}/override`,
      headers: { cookie: rootCookie },
      payload: { enabled: false }
    });
    expect(tenantOff.statusCode).toBe(200);
    expect(tenantOff.json().flag).toMatchObject({ enabled: false, source: "tenant_override" });
    expect((await workspaceFlags(ownerACookie))[key]).toBe(false);
    expect((await workspaceFlags(ownerBCookie))[key]).toBe(true);

    const killOn = await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/kill-switch`,
      headers: { cookie: rootCookie },
      payload: { enabled: true }
    });
    expect(killOn.statusCode).toBe(200);
    expect((await workspaceFlags(ownerACookie))[key]).toBe(false);
    expect((await workspaceFlags(ownerBCookie))[key]).toBe(false);
    const tenantState = await app.inject({
      url: `/root/workspaces/${tenantA}/feature-flags`,
      headers: { cookie: rootCookie }
    });
    expect(tenantState.statusCode).toBe(200);
    expect(tenantState.json().flags.find((flag: { key: string }) => flag.key === key))
      .toMatchObject({ enabled: false, source: "kill_switch", tenantOverride: false });

    expect((await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/kill-switch`,
      headers: { cookie: rootCookie },
      payload: { enabled: false }
    })).statusCode).toBe(200);
    expect((await workspaceFlags(ownerACookie))[key]).toBe(false);
    expect((await workspaceFlags(ownerBCookie))[key]).toBe(true);

    const overrideRollback = await app.inject({
      method: "DELETE",
      url: `/root/workspaces/${tenantA}/feature-flags/${key}/override`,
      headers: { cookie: rootCookie }
    });
    expect(overrideRollback.statusCode).toBe(200);
    expect(overrideRollback.json().flag).toMatchObject({ enabled: true, source: "global" });
    expect((await workspaceFlags(ownerACookie))[key]).toBe(true);

    const globalRollback = await app.inject({
      method: "PATCH",
      url: `/root/feature-flags/${key}/global`,
      headers: { cookie: rootCookie },
      payload: { enabled: null }
    });
    expect(globalRollback.statusCode).toBe(200);
    expect((await workspaceFlags(ownerACookie))[key]).toBe(false);
    expect((await workspaceFlags(ownerBCookie))[key]).toBe(false);

    const audits = await pool.query<{
      workspace_id: string | null;
      action: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT workspace_id,action,resource_id,metadata
       FROM audit_logs
       WHERE actor_user_id=$1 AND resource_id=$2
       ORDER BY created_at`,
      [rootUserId, key]
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "feature_flag.global.update",
      "feature_flag.tenant_override.update",
      "feature_flag.kill_switch.update",
      "feature_flag.kill_switch.update",
      "feature_flag.tenant_override.delete",
      "feature_flag.global.update"
    ]);
    expect(audits.rows.filter((row) => row.action.includes("tenant_override"))
      .every((row) => row.workspace_id === tenantA)).toBe(true);
    expect(JSON.stringify(audits.rows.map((row) => row.metadata))).not.toContain(ownerAEmail);
  });

  it("does not expose another workspace or accept unknown flags", async () => {
    const workspaceResponse = await app.inject({ url: "/feature-flags", headers: { cookie: ownerACookie } });
    expect(workspaceResponse.statusCode).toBe(200);
    expect(workspaceResponse.body).not.toContain(tenantA);
    expect(workspaceResponse.body).not.toContain(tenantB);
    expect((await app.inject({
      method: "PUT",
      url: `/root/workspaces/${tenantB}/feature-flags/not_a_flag/override`,
      headers: { cookie: rootCookie },
      payload: { enabled: true }
    })).statusCode).toBe(400);
    expect((await app.inject({
      url: `/root/workspaces/${randomUUID()}/feature-flags`,
      headers: { cookie: rootCookie }
    })).statusCode).toBe(404);
  });
});

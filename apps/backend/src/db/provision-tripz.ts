import type { Pool } from "pg";
import { db } from "./client.js";
import { config } from "../config.js";
import { TRIPZ_ZULU_SYSTEM_PROMPT } from "../modules/tripz-ai/zulu.js";

/** Stable public identifier; UUIDs remain tenant-owned and are resolved at runtime. */
export const TRIPZ_TENANT_SLUG = "tripzturismo-a44ab4";

export interface TripzProvisionResult {
  tenantId: string | null;
  agentId: string | null;
  changed: boolean;
  promptChanged: boolean;
  featureEnabled: boolean;
  reason?: "tenant_not_found" | "tenant_ambiguous" | "agent_not_found" | "already_current";
}

// Zulu only ever calls registrar_lead/atualizar_status_lead (see zulu.ts §15) — this
// is the agent's full tool contract, not a minimum to union with whatever else is stored.
export const REQUIRED_ZULU_TOOLS = ["registrar_lead", "atualizar_status_lead"] as const;

function enabledTools(): string[] {
  return [...REQUIRED_ZULU_TOOLS];
}

function includesRequiredTools(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === REQUIRED_ZULU_TOOLS.length
    && REQUIRED_ZULU_TOOLS.every((tool) => value.includes(tool));
}

/**
 * Publishes the Zulu prompt as a new immutable agent version for the existing
 * Tripz workspace. The deploy path invokes this explicit, tenant-scoped
 * publisher after migrations; re-running is idempotent and does not use a
 * hardcoded tenant UUID.
 */
export async function provisionTripzZulu(pool: Pool, tenantSlug = config.TRIPZ_TENANT_SLUG): Promise<TripzProvisionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["provision:tripz-zulu"]);
    const tenant = await client.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug=$1 AND status='active' FOR SHARE",
      [tenantSlug]
    );
    // Keep an exact-name fallback for older records created before slugs were
    // backfilled. It still cannot select an arbitrary tenant by UUID.
    const fallback = !tenant.rows[0] && tenantSlug === TRIPZ_TENANT_SLUG
      ? await client.query<{ id: string }>(
        "SELECT id FROM tenants WHERE lower(name)=lower($1) AND status='active' ORDER BY created_at,id LIMIT 2 FOR SHARE",
        ["Tripz Turismo"]
      )
      : { rows: [] as Array<{ id: string }> };
    if (fallback.rows.length > 1) {
      await client.query("ROLLBACK");
      return { tenantId: null, agentId: null, changed: false, promptChanged: false, featureEnabled: false, reason: "tenant_ambiguous" };
    }
    const resolvedTenant = tenant.rows[0] ?? fallback.rows[0];
    if (!resolvedTenant) {
      await client.query("ROLLBACK");
      return { tenantId: null, agentId: null, changed: false, promptChanged: false, featureEnabled: false, reason: "tenant_not_found" };
    }
    const tenantId = resolvedTenant.id;
    const agent = await client.query<{
      id: string;
      active_version_id: string | null;
      system_prompt: string;
      ai_model: string;
      model_params: Record<string, unknown>;
      enabled_tools: unknown;
      active_version_prompt: string | null;
      active_version_tools: unknown;
    }>(
      "SELECT agent.id,agent.active_version_id,agent.system_prompt,agent.ai_model,agent.model_params,agent.enabled_tools," +
      "version.system_prompt active_version_prompt,version.enabled_tools active_version_tools " +
      "FROM agent_configs agent " +
      "LEFT JOIN agent_config_versions version ON version.id=agent.active_version_id " +
      "AND version.tenant_id=agent.tenant_id AND version.agent_config_id=agent.id AND version.status='active' " +
      "WHERE agent.tenant_id=$1 AND agent.is_active ORDER BY agent.updated_at DESC,agent.id LIMIT 1 FOR UPDATE OF agent",
      [tenantId]
    );
    if (!agent.rows[0]) {
      await client.query("ROLLBACK");
      return { tenantId, agentId: null, changed: false, promptChanged: false, featureEnabled: false, reason: "agent_not_found" };
    }
    const current = agent.rows[0];
    const supportGrant = await client.query(
      `INSERT INTO tenant_capability_support(tenant_id,capability_key,provisioned_by)
       VALUES($1,'tripz_ai_v1','provision-tripz')
       ON CONFLICT(tenant_id,capability_key) DO UPDATE SET
         provisioned_by=EXCLUDED.provisioned_by,
         updated_at=now()
       WHERE tenant_capability_support.provisioned_by IS DISTINCT FROM EXCLUDED.provisioned_by
       RETURNING tenant_id`,
      [tenantId]
    );
    // Provisioning records technical support, but never chooses or rewrites the
    // ROOT-owned override (including an explicit false value).
    const currentFlag = await client.query<{ enabled: boolean }>(
      `SELECT CASE
         WHEN definition.kill_switch_enabled THEN false
         ELSE COALESCE(override.enabled,definition.global_enabled,definition.default_enabled)
       END enabled
       FROM feature_flag_definitions definition
       LEFT JOIN tenant_feature_flag_overrides override
         ON override.tenant_id=$1 AND override.flag_key=definition.flag_key
       WHERE definition.flag_key='tripz_ai_v1'`,
      [tenantId]
    );
    const adminGrants = await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) " +
      "SELECT role.id,permission.permission_key FROM workspace_roles role " +
      "CROSS JOIN (VALUES ('tripz_ai.use'),('tripz_ai.manage')) permission(permission_key) " +
      "WHERE role.workspace_id=$1 AND role.name IN ('OWNER','ADMIN') " +
      "ON CONFLICT DO NOTHING RETURNING role_id",
      [tenantId]
    );
    const operatorGrants = await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) " +
      "SELECT role.id,'tripz_ai.use' FROM workspace_roles role " +
      "WHERE role.workspace_id=$1 AND role.name IN ('SUPERVISOR','OPERADOR') " +
      "ON CONFLICT DO NOTHING RETURNING role_id",
      [tenantId]
    );
    const provisioningChanged = (supportGrant.rowCount ?? 0)
      + (adminGrants.rowCount ?? 0)
      + (operatorGrants.rowCount ?? 0) > 0;
    const featureEnabled = currentFlag.rows[0]?.enabled ?? false;
    const promptCurrent = current.system_prompt === TRIPZ_ZULU_SYSTEM_PROMPT
      && current.active_version_prompt === TRIPZ_ZULU_SYSTEM_PROMPT;
    const toolsCurrent = includesRequiredTools(current.enabled_tools)
      && includesRequiredTools(current.active_version_tools);
    if (promptCurrent && toolsCurrent) {
      await client.query("COMMIT");
      return { tenantId, agentId: current.id, changed: provisioningChanged, promptChanged: false, featureEnabled, reason: "already_current" };
    }
    const nextEnabledTools = enabledTools();
    const version = await client.query<{ version_number: number }>(
      "SELECT COALESCE(MAX(version_number),0)::int+1 version_number " +
      "FROM agent_config_versions WHERE agent_config_id=$1",
      [current.id]
    );
    await client.query(
      "UPDATE agent_config_versions SET status='retired',retired_at=now() " +
      "WHERE agent_config_id=$1 AND status='active'",
      [current.id]
    );
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO agent_config_versions(" +
      "tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model," +
      "model_params,enabled_tools,created_by_user_id,activated_at) " +
      "VALUES($1,$2,$3,'manual','active',$4,$5,$6::jsonb,$7::jsonb,NULL,now()) RETURNING id",
      [
        tenantId,
        current.id,
        version.rows[0].version_number,
        TRIPZ_ZULU_SYSTEM_PROMPT,
        current.ai_model,
        JSON.stringify(current.model_params ?? {}),
        JSON.stringify(nextEnabledTools)
      ]
    );
    await client.query(
      "UPDATE agent_configs SET system_prompt=$2,active_version_id=$3,enabled_tools=$5::jsonb,updated_at=now() " +
      "WHERE id=$1 AND tenant_id=$4",
      [current.id, TRIPZ_ZULU_SYSTEM_PROMPT, inserted.rows[0].id, tenantId, JSON.stringify(nextEnabledTools)]
    );
    await client.query("COMMIT");
    return { tenantId, agentId: current.id, changed: true, promptChanged: !promptCurrent, featureEnabled };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  provisionTripzZulu(db)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exitCode = result.changed || result.reason === "already_current" ? 0 : 2;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Tripz provisioning failed");
      process.exitCode = 1;
    });
}

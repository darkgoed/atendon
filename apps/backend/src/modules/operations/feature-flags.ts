import pg from "pg";
import { z } from "zod";

export const FEATURE_FLAG_KEYS = [
  "ai_turn_visibility_v1", "conversations_delta_v2", "alerts_delivery_v2",
  "evaluation_event_enqueue_v2", "scheduling_meet_outbox_v2",
  "ai_deterministic_confirmations_v2", "evaluator_payload_redaction_v2",
  "state_tool_gating_v2", "compact_prompt_v2", "case_organization_v1",
  "dashboard_widgets_v1", "web_push_v1", "tripz_ai_v1", "post_sales_v1",
  "dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1",
  "workspace_admin_v1"
] as const;

export const CAPABILITY_KEYS = [
  "dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1",
  "post_sales_v1", "tripz_ai_v1", "workspace_admin_v1"
] as const;

export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];
export type CapabilityKey = typeof CAPABILITY_KEYS[number];
export type FeatureFlagKind = "rollout" | "capability";
export type CapabilityAvailabilityMode = "all_tenants" | "supported_tenants";

export const GLOBAL_ONLY_FEATURE_FLAG_KEYS = [
  "case_organization_v1", "dashboard_widgets_v1", "web_push_v1"
] as const satisfies readonly FeatureFlagKey[];
const globalOnlyFeatureFlags = new Set<FeatureFlagKey>(GLOBAL_ONLY_FEATURE_FLAG_KEYS);

/** OFF never permits regression of the underlying security invariant. */
export const NON_REGRESSIVE_SECURITY_FLAG_KEYS = [
  "ai_deterministic_confirmations_v2", "evaluator_payload_redaction_v2"
] as const satisfies readonly FeatureFlagKey[];

export type FeatureFlagDecisionSource =
  | "unsupported" | "kill_switch" | "tenant_override" | "global"
  | "default" | "dependency";

const versionedKeyPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_v[1-9][0-9]*$/;
export const featureFlagKeySchema = z.string().min(4).max(120).regex(versionedKeyPattern)
  .transform((value) => value as FeatureFlagKey);
export const capabilityKeySchema = featureFlagKeySchema.transform((value) => value as CapabilityKey);
export type FeatureFlagQueryable = pg.Pool | pg.PoolClient;

export interface GlobalFeatureFlag {
  key: FeatureFlagKey;
  description: string;
  displayName: string;
  kind: FeatureFlagKind;
  tenantConfigurable: boolean;
  availabilityMode: CapabilityAvailabilityMode;
  uiOrder: number | null;
  defaultEnabled: boolean;
  globalEnabled: boolean | null;
  killSwitchEnabled: boolean;
  globalEffectiveEnabled: boolean;
  updatedAt: string;
}

export interface EffectiveFeatureFlag extends GlobalFeatureFlag {
  dependencies: FeatureFlagKey[];
  supported: boolean;
  tenantOverride: boolean | null;
  enabled: boolean;
  source: FeatureFlagDecisionSource;
  blockedBy: FeatureFlagKey[];
}

export interface EffectiveCapability extends EffectiveFeatureFlag {
  key: CapabilityKey;
  kind: "capability";
  dependencies: CapabilityKey[];
  blockedBy: CapabilityKey[];
}

interface FeatureFlagRow {
  flag_key: FeatureFlagKey;
  description: string;
  display_name?: string;
  kind?: FeatureFlagKind;
  tenant_configurable?: boolean;
  availability_mode?: CapabilityAvailabilityMode;
  ui_order?: number | null;
  default_enabled: boolean;
  global_enabled: boolean | null;
  kill_switch_enabled: boolean;
  tenant_override?: boolean | null;
  supported?: boolean;
  updated_at: string;
}

interface DependencyRow {
  capability_key: FeatureFlagKey;
  required_capability_key: FeatureFlagKey;
}

function globalFlag(row: FeatureFlagRow): GlobalFeatureFlag {
  return {
    key: row.flag_key,
    description: row.description,
    displayName: row.display_name ?? row.flag_key,
    kind: row.kind ?? "rollout",
    tenantConfigurable: row.tenant_configurable ?? !globalOnlyFeatureFlags.has(row.flag_key),
    availabilityMode: row.availability_mode ?? "all_tenants",
    uiOrder: row.ui_order ?? null,
    defaultEnabled: row.default_enabled,
    globalEnabled: row.global_enabled,
    killSwitchEnabled: row.kill_switch_enabled,
    globalEffectiveEnabled: row.kill_switch_enabled ? false : row.global_enabled ?? row.default_enabled,
    updatedAt: row.updated_at
  };
}

/** Resolves support > kill > tenant override > global > default. */
export function decideFeatureFlag(row: FeatureFlagRow): EffectiveFeatureFlag {
  const base = globalFlag(row);
  const tenantOverride = globalOnlyFeatureFlags.has(row.flag_key) ? null : row.tenant_override ?? null;
  const common = {
    ...base,
    dependencies: [] as FeatureFlagKey[],
    supported: row.supported ?? true,
    tenantOverride,
    blockedBy: [] as FeatureFlagKey[]
  };
  if (!common.supported) return { ...common, enabled: false, source: "unsupported" };
  if (row.kill_switch_enabled) return { ...common, enabled: false, source: "kill_switch" };
  if (tenantOverride !== null) return { ...common, enabled: tenantOverride, source: "tenant_override" };
  if (row.global_enabled !== null) return { ...common, enabled: row.global_enabled, source: "global" };
  return { ...common, enabled: row.default_enabled, source: "default" };
}

function resolveFeatureFlagRows(
  rows: readonly FeatureFlagRow[],
  dependencyRows: readonly DependencyRow[]
): EffectiveFeatureFlag[] {
  const decisions = new Map(rows.map((row) => [row.flag_key, decideFeatureFlag(row)]));
  const dependencies = new Map<FeatureFlagKey, FeatureFlagKey[]>();
  for (const dependency of dependencyRows) {
    const current = dependencies.get(dependency.capability_key) ?? [];
    current.push(dependency.required_capability_key);
    dependencies.set(dependency.capability_key, current);
  }
  const resolved = new Map<FeatureFlagKey, EffectiveFeatureFlag>();
  const resolving = new Set<FeatureFlagKey>();
  const resolve = (key: FeatureFlagKey): EffectiveFeatureFlag | undefined => {
    const prior = resolved.get(key);
    if (prior) return prior;
    const decision = decisions.get(key);
    if (!decision) return undefined;
    const required = dependencies.get(key) ?? [];
    const withDependencies = { ...decision, dependencies: required };
    if (!decision.enabled || required.length === 0) {
      resolved.set(key, withDependencies);
      return withDependencies;
    }
    if (resolving.has(key)) {
      const cyclic = { ...withDependencies, enabled: false, source: "dependency" as const, blockedBy: required };
      resolved.set(key, cyclic);
      return cyclic;
    }
    resolving.add(key);
    const blockedBy = required.filter((requiredKey) => !resolve(requiredKey)?.enabled);
    resolving.delete(key);
    const result = blockedBy.length > 0
      ? { ...withDependencies, enabled: false, source: "dependency" as const, blockedBy }
      : withDependencies;
    resolved.set(key, result);
    return result;
  };
  return rows.map((row) => resolve(row.flag_key)!).filter(Boolean);
}

export function featureFlagMetricLabels(decision: EffectiveFeatureFlag) {
  return { flag: decision.key, source: decision.source, enabled: decision.enabled ? "true" : "false" } as const;
}

const definitionColumns = `d.flag_key,d.description,d.display_name,d.kind,
  d.tenant_configurable,d.availability_mode,d.ui_order,d.default_enabled,
  d.global_enabled,d.kill_switch_enabled,d.updated_at`;

async function loadDependencyRows(client: FeatureFlagQueryable): Promise<DependencyRow[]> {
  return (await client.query<DependencyRow>(
    `SELECT capability_key,required_capability_key FROM capability_dependencies
     ORDER BY capability_key,required_capability_key`
  )).rows;
}

export async function listGlobalFeatureFlags(client: FeatureFlagQueryable): Promise<GlobalFeatureFlag[]> {
  const result = await client.query<FeatureFlagRow>(
    `SELECT flag_key,description,display_name,kind,tenant_configurable,
            availability_mode,ui_order,default_enabled,global_enabled,
            kill_switch_enabled,updated_at
     FROM feature_flag_definitions ORDER BY flag_key`
  );
  return result.rows.map(globalFlag);
}

export async function listEffectiveFeatureFlags(
  client: FeatureFlagQueryable,
  tenantId: string
): Promise<EffectiveFeatureFlag[]> {
  const [result, dependencies] = await Promise.all([
    client.query<FeatureFlagRow>(
      `SELECT ${definitionColumns},o.enabled tenant_override,
              (d.availability_mode='all_tenants' OR support.tenant_id IS NOT NULL) supported
       FROM feature_flag_definitions d
       LEFT JOIN tenant_feature_flag_overrides o
         ON o.flag_key=d.flag_key AND o.tenant_id=$1
       LEFT JOIN tenant_capability_support support
         ON support.capability_key=d.flag_key AND support.tenant_id=$1
       ORDER BY d.kind,d.ui_order NULLS LAST,d.flag_key`,
      [tenantId]
    ),
    loadDependencyRows(client)
  ]);
  return resolveFeatureFlagRows(result.rows, dependencies);
}

export async function listEffectiveCapabilities(
  client: FeatureFlagQueryable,
  tenantId: string
): Promise<EffectiveCapability[]> {
  return (await listEffectiveFeatureFlags(client, tenantId))
    .filter((flag): flag is EffectiveCapability => flag.kind === "capability")
    .sort((left, right) => (left.uiOrder ?? Number.MAX_SAFE_INTEGER) - (right.uiOrder ?? Number.MAX_SAFE_INTEGER));
}

export async function getEffectiveFeatureFlag(
  client: FeatureFlagQueryable,
  tenantId: string,
  key: FeatureFlagKey
): Promise<EffectiveFeatureFlag> {
  const decision = (await listEffectiveFeatureFlags(client, tenantId)).find((flag) => flag.key === key);
  if (!decision) throw Object.assign(new Error("Feature flag não encontrada"), { statusCode: 500 });
  return decision;
}

/** Stable, uncached application API for commercial capability gates. */
export async function resolveCapability(
  client: FeatureFlagQueryable,
  tenantId: string,
  key: CapabilityKey
): Promise<EffectiveCapability> {
  const decision = (await listEffectiveCapabilities(client, tenantId)).find((capability) => capability.key === key);
  if (!decision) throw Object.assign(new Error("Capability não encontrada"), { statusCode: 500 });
  return decision;
}

export async function isFeatureFlagEnabled(
  client: FeatureFlagQueryable,
  tenantId: string,
  key: FeatureFlagKey
): Promise<boolean> {
  return (await getEffectiveFeatureFlag(client, tenantId, key)).enabled;
}

export async function isCapabilityEnabled(
  client: FeatureFlagQueryable,
  tenantId: string,
  key: CapabilityKey
): Promise<boolean> {
  return (await resolveCapability(client, tenantId, key)).enabled;
}

export function effectiveFeatureFlagMap(flags: readonly EffectiveFeatureFlag[]): Record<FeatureFlagKey, boolean> {
  return Object.fromEntries(flags.map((flag) => [flag.key, flag.enabled])) as Record<FeatureFlagKey, boolean>;
}

export async function listAllTenantEffectiveFeatureFlags(
  client: FeatureFlagQueryable
): Promise<Record<string, Record<FeatureFlagKey, boolean>>> {
  const tenants = await client.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
  const effective: Record<string, Record<FeatureFlagKey, boolean>> = {};
  for (const tenant of tenants.rows) {
    effective[tenant.id] = effectiveFeatureFlagMap(await listEffectiveFeatureFlags(client, tenant.id));
  }
  return effective;
}

async function lockedDefinition(client: pg.PoolClient, key: FeatureFlagKey): Promise<FeatureFlagRow> {
  const result = await client.query<FeatureFlagRow>(
    `SELECT flag_key,description,display_name,kind,tenant_configurable,
            availability_mode,ui_order,default_enabled,global_enabled,
            kill_switch_enabled,updated_at
     FROM feature_flag_definitions WHERE flag_key=$1 FOR UPDATE`,
    [key]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Feature flag não encontrada"), { statusCode: 404 });
  return result.rows[0];
}

export async function setGlobalFeatureFlag(
  client: pg.PoolClient,
  key: FeatureFlagKey,
  enabled: boolean | null,
  actorUserId: string
) {
  const previous = await lockedDefinition(client, key);
  const updated = await client.query<FeatureFlagRow>(
    `UPDATE feature_flag_definitions
     SET global_enabled=$2,updated_by_user_id=$3,updated_at=now()
     WHERE flag_key=$1
     RETURNING flag_key,description,display_name,kind,tenant_configurable,
               availability_mode,ui_order,default_enabled,global_enabled,
               kill_switch_enabled,updated_at`,
    [key, enabled, actorUserId]
  );
  return { previous: globalFlag(previous), current: globalFlag(updated.rows[0]) };
}

export async function setFeatureFlagKillSwitch(
  client: pg.PoolClient,
  key: FeatureFlagKey,
  enabled: boolean,
  actorUserId: string
) {
  const previous = await lockedDefinition(client, key);
  const updated = await client.query<FeatureFlagRow>(
    `UPDATE feature_flag_definitions
     SET kill_switch_enabled=$2,updated_by_user_id=$3,updated_at=now()
     WHERE flag_key=$1
     RETURNING flag_key,description,display_name,kind,tenant_configurable,
               availability_mode,ui_order,default_enabled,global_enabled,
               kill_switch_enabled,updated_at`,
    [key, enabled, actorUserId]
  );
  return { previous: globalFlag(previous), current: globalFlag(updated.rows[0]) };
}

export async function setTenantFeatureFlagOverride(
  client: pg.PoolClient,
  tenantId: string,
  key: FeatureFlagKey,
  enabled: boolean,
  actorUserId: string
) {
  await lockedDefinition(client, key);
  if (globalOnlyFeatureFlags.has(key)) {
    throw Object.assign(new Error("Esta feature flag aceita apenas liberação global e kill switch"), { statusCode: 400 });
  }
  const previous = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM tenant_feature_flag_overrides
     WHERE tenant_id=$1 AND flag_key=$2 FOR UPDATE`,
    [tenantId, key]
  );
  await client.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled,updated_by_user_id)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id,flag_key) DO UPDATE SET
       enabled=EXCLUDED.enabled,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
    [tenantId, key, enabled, actorUserId]
  );
  return { previous: previous.rows[0]?.enabled ?? null, current: enabled };
}

export async function deleteTenantFeatureFlagOverride(
  client: pg.PoolClient,
  tenantId: string,
  key: FeatureFlagKey
) {
  await lockedDefinition(client, key);
  if (globalOnlyFeatureFlags.has(key)) {
    throw Object.assign(new Error("Esta feature flag não possui override por workspace"), { statusCode: 400 });
  }
  const deleted = await client.query<{ enabled: boolean }>(
    `DELETE FROM tenant_feature_flag_overrides
     WHERE tenant_id=$1 AND flag_key=$2 RETURNING enabled`,
    [tenantId, key]
  );
  return { previous: deleted.rows[0]?.enabled ?? null, current: null };
}

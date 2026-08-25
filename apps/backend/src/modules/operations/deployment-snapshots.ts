import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import {
  listAllTenantEffectiveFeatureFlags,
  listGlobalFeatureFlags,
  type FeatureFlagKey
} from "./feature-flags.js";

const deployVersionSchema = z.string().trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DeploymentFeatureFlagSnapshot {
  id: string;
  deployVersion: string;
  latestMigration: string;
  globalFlags: Record<FeatureFlagKey, {
    defaultEnabled: boolean;
    globalEnabled: boolean | null;
    killSwitchEnabled: boolean;
    enabled: boolean;
  }>;
  effectiveFlags: Record<string, Record<FeatureFlagKey, boolean>>;
  snapshotHash: string;
  createdAt: string;
  created: boolean;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

export function deploymentSnapshotHash(input: {
  deployVersion: string;
  latestMigration: string;
  globalFlags: DeploymentFeatureFlagSnapshot["globalFlags"];
  effectiveFlags: DeploymentFeatureFlagSnapshot["effectiveFlags"];
}): string {
  return createHash("sha256").update(canonicalJson(input as unknown as JsonValue)).digest("hex");
}

export async function recordDeploymentFeatureFlagSnapshot(
  pool: pg.Pool,
  deployVersionInput: string
): Promise<DeploymentFeatureFlagSnapshot> {
  const deployVersion = deployVersionSchema.parse(deployVersionInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('atendon:deployment-feature-flag-snapshot',0))");
    const migration = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1"
    );
    const latestMigration = migration.rows[0]?.filename;
    if (!latestMigration) {
      throw new Error("Nenhuma migration registrada; execute migrations antes do snapshot");
    }

    const globalState = await listGlobalFeatureFlags(client);
    const globalFlags = Object.fromEntries(globalState.map((flag) => [
      flag.key,
      {
        defaultEnabled: flag.defaultEnabled,
        globalEnabled: flag.globalEnabled,
        killSwitchEnabled: flag.killSwitchEnabled,
        enabled: flag.globalEffectiveEnabled
      }
    ])) as DeploymentFeatureFlagSnapshot["globalFlags"];
    const effectiveFlags = await listAllTenantEffectiveFeatureFlags(client);
    const snapshotHash = deploymentSnapshotHash({
      deployVersion,
      latestMigration,
      globalFlags,
      effectiveFlags
    });

    const existing = await client.query<{
      id: string;
      deploy_version: string;
      latest_migration: string;
      global_flags: DeploymentFeatureFlagSnapshot["globalFlags"];
      effective_flags: DeploymentFeatureFlagSnapshot["effectiveFlags"];
      snapshot_hash: string;
      created_at: string;
    }>(
      `SELECT id,deploy_version,latest_migration,global_flags,effective_flags,
              snapshot_hash,created_at
       FROM deployment_feature_flag_snapshots
       WHERE deploy_version=$1
       FOR UPDATE`,
      [deployVersion]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].snapshot_hash !== snapshotHash) {
        throw new Error(
          `DEPLOY_VERSION ${deployVersion} já possui snapshot diferente; use uma nova versão de deploy`
        );
      }
      await client.query("COMMIT");
      return {
        id: existing.rows[0].id,
        deployVersion,
        latestMigration: existing.rows[0].latest_migration,
        globalFlags: existing.rows[0].global_flags,
        effectiveFlags: existing.rows[0].effective_flags,
        snapshotHash,
        createdAt: existing.rows[0].created_at,
        created: false
      };
    }

    const inserted = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO deployment_feature_flag_snapshots(
         deploy_version,latest_migration,global_flags,effective_flags,snapshot_hash
       ) VALUES($1,$2,$3,$4,$5)
       RETURNING id,created_at`,
      [deployVersion, latestMigration, globalFlags, effectiveFlags, snapshotHash]
    );
    await client.query("COMMIT");
    return {
      id: inserted.rows[0].id,
      deployVersion,
      latestMigration,
      globalFlags,
      effectiveFlags,
      snapshotHash,
      createdAt: inserted.rows[0].created_at,
      created: true
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

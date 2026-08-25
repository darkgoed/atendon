import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const MIGRATION_LOCK_NAME = "atendon:schema-migrations";
const SAFE_BASELINE_CUTOFF = "0027_manual_ai_pause.sql";
const SUPERVISOR_ROLE_MIGRATION = "0089_supervisor_role.sql";

interface MigrationClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface MigrationFile {
  filename: string;
  checksum: string;
  sql: string;
}

interface MigrationLedgerRow {
  filename: string;
  checksum: string;
  execution_mode: "applied" | "adopted";
}

export interface MigrationRunResult {
  applied: string[];
  adopted: string[];
  existing: string[];
}

export interface MigrationRunOptions {
  ownerRole?: string;
}

function quotedRoleName(value: string): string {
  if (!/^[a-z_][a-z0-9_$]{0,62}$/.test(value)) {
    throw new Error("Migration owner role must be a simple lowercase PostgreSQL identifier");
  }
  return `"${value}"`;
}

const BASELINE_STATE_SQL = `SELECT
  to_regclass('public.tenants') IS NOT NULL AS core_exists,
  (
    to_regclass('public.tenants') IS NOT NULL
    AND to_regclass('public.whatsapp_sessions') IS NOT NULL
    AND to_regclass('public.agent_configs') IS NOT NULL
    AND to_regclass('public.conversations') IS NOT NULL
    AND to_regclass('public.messages') IS NOT NULL
    AND to_regclass('public.usage_logs') IS NOT NULL
    AND to_regclass('public.tenant_ai_settings') IS NOT NULL
    AND to_regclass('public.scheduling_appointments') IS NOT NULL
    AND to_regclass('public.users') IS NOT NULL
    AND to_regclass('public.permissions') IS NOT NULL
    AND to_regclass('public.workspace_roles') IS NOT NULL
    AND to_regclass('public.audit_logs') IS NOT NULL
    AND to_regclass('public.system_alerts') IS NOT NULL
    AND to_regclass('public.panel_users') IS NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_sessions' AND column_name='instance_name')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='provider_message_key')
    AND EXISTS (
      SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace namespace ON namespace.oid=index_relation.relnamespace
      JOIN pg_index definition ON definition.indexrelid=index_relation.oid
      WHERE namespace.nspname='public'
        AND index_relation.relname='idx_messages_provider_message_key'
        AND definition.indisunique
    )
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='status')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='processing_started_at')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_ai_settings' AND column_name='humanizer_config')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_ai_settings' AND column_name='openrouter_provider')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='session_version')
  ) AS baseline_complete`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory)).filter((filename) => filename.endsWith(".sql")).sort();
  return Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(`${directory}/${filename}`, "utf8");
    return { filename, sql, checksum: checksum(sql) };
  }));
}

async function recordMigration(client: MigrationClient, migration: MigrationFile, mode: "applied" | "adopted") {
  await client.query(
    `INSERT INTO schema_migrations(filename,checksum,execution_mode)
     VALUES($1,$2,$3)`,
    [migration.filename, migration.checksum, mode]
  );
}

async function assertMigrationPreconditions(
  client: MigrationClient,
  migration: MigrationFile
): Promise<void> {
  if (migration.filename !== SUPERVISOR_ROLE_MIGRATION) return;
  const collision = await client.query<{ unsafe_collision: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM workspace_roles
       WHERE name='SUPERVISOR' AND is_system=false
     ) unsafe_collision`
  );
  if (collision.rows[0]?.unsafe_collision) {
    throw new Error(
      "A custom SUPERVISOR role already exists. Rename or explicitly audit it before applying the system Supervisor role migration"
    );
  }
}

export async function runMigrations(
  client: MigrationClient,
  directory: string,
  log: (message: string) => void = console.log,
  options: MigrationRunOptions = {}
): Promise<MigrationRunResult> {
  const files = await migrationFiles(directory);
  let locked = false;
  let roleAssumed = false;
  try {
    if (options.ownerRole) {
      await client.query(`SET ROLE ${quotedRoleName(options.ownerRole)}`);
      roleAssumed = true;
    }
    // Runtime limits protect request pools. Schema changes are an explicit,
    // separately named exception and remain bounded by the operational
    // migration window rather than inheriting request-level timeouts.
    await client.query(`SET application_name='atendon-migration';
      SET statement_timeout=0;
      SET lock_timeout=0;
      SET idle_in_transaction_session_timeout=0`);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [MIGRATION_LOCK_NAME]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('applied','adopted')),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const ledger = await client.query<MigrationLedgerRow>(
      "SELECT filename,checksum,execution_mode FROM schema_migrations ORDER BY filename"
    );
    const recorded = new Map(ledger.rows.map((row) => [row.filename, row]));

    for (const row of ledger.rows) {
      const file = files.find((candidate) => candidate.filename === row.filename);
      if (!file) throw new Error(`Recorded migration file is missing: ${row.filename}`);
      if (file.checksum !== row.checksum.trim()) {
        throw new Error(`Migration checksum mismatch: ${row.filename}`);
      }
    }

    const result: MigrationRunResult = { applied: [], adopted: [], existing: [] };
    if (ledger.rows.length === 0 && files.length > 0) {
      const baseline = await client.query<{ core_exists: boolean; baseline_complete: boolean }>(BASELINE_STATE_SQL);
      if (baseline.rows[0]?.core_exists) {
        if (!baseline.rows[0].baseline_complete) {
          throw new Error("Existing schema cannot be safely adopted; verify missing historical migrations manually");
        }
        const cutoffIndex = files.findIndex((file) => file.filename === SAFE_BASELINE_CUTOFF);
        if (cutoffIndex < 0) throw new Error(`Safe baseline migration is missing: ${SAFE_BASELINE_CUTOFF}`);
        const baselineFiles = files.slice(0, cutoffIndex + 1);
        await client.query("BEGIN");
        try {
          for (const file of baselineFiles) await recordMigration(client, file, "adopted");
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        for (const file of baselineFiles) {
          recorded.set(file.filename, { filename: file.filename, checksum: file.checksum, execution_mode: "adopted" });
          result.adopted.push(file.filename);
          log(`Adopted ${file.filename}`);
        }
      }
    }

    for (const file of files) {
      if (recorded.has(file.filename)) {
        if (!result.adopted.includes(file.filename)) result.existing.push(file.filename);
        continue;
      }
      await client.query("BEGIN");
      try {
        await assertMigrationPreconditions(client, file);
        await client.query(file.sql);
        await recordMigration(client, file, "applied");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration failed: ${file.filename}: ${reason}`, { cause: error });
      }
      result.applied.push(file.filename);
      log(`Applied ${file.filename}`);
    }
    return result;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [MIGRATION_LOCK_NAME]);
    if (roleAssumed) await client.query("RESET ROLE");
  }
}

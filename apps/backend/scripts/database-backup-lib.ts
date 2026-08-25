import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { z } from "zod";

export const CRITICAL_DATABASE_TABLES = [
  "tenants",
  "users",
  "workspace_members",
  "conversations",
  "messages",
  "scheduling_leads",
  "scheduling_appointments",
  "scheduling_meeting_provisioning_outbox",
  "scheduling_meeting_contact_delivery_outbox",
  "ai_tool_call_journal",
  "agent_message_transaction_claims",
  "system_alerts",
  "audit_logs"
] as const;

const disposableDatabasePattern = /^atendon_restore_verify_[0-9a-f]{32}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("atendon-postgresql-backup"),
  createdAt: z.string().datetime(),
  deployVersion: z.string().min(1),
  source: z.object({
    host: z.string().min(1),
    port: z.string().regex(/^\d+$/),
    database: z.string().min(1)
  }),
  migrations: z.object({
    latest: z.string().nullable(),
    count: z.number().int().nonnegative()
  }),
  schema: z.object({
    constraints: z.number().int().nonnegative(),
    foreignKeys: z.number().int().nonnegative()
  }),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
  dump: z.object({
    file: z.string().min(1),
    format: z.literal("custom"),
    noOwner: z.literal(true),
    noAcl: z.literal(true),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(sha256Pattern)
  })
}).strict();

export type DatabaseBackupManifest = z.infer<typeof manifestSchema>;

export type RestoreVerificationReport = {
  schemaVersion: 1;
  kind: "atendon-postgresql-restore-verification";
  verifiedAt: string;
  success: boolean;
  manifestFile: string;
  dumpSha256: string;
  target: { host: string; port: string; database: string };
  migrations: {
    expectedLatest: string | null;
    actualLatest: string | null;
    expectedCount: number;
    actualCount: number;
  };
  tableCounts: Record<string, { expected: number; actual: number; matches: boolean }>;
  constraints: {
    expectedTotal: number;
    total: number;
    invalid: number;
    expectedForeignKeys: number;
    foreignKeys: number;
    invalidForeignKeys: number;
    matches: boolean;
  };
  cleanup: { requested: boolean; completed: boolean };
  error?: string;
};

type DatabaseIdentity = {
  host: string;
  port: string;
  database: string;
};

type BackupOptions = {
  databaseUrl: string;
  outputDirectory: string;
  deployVersion: string;
  ownerRole?: string;
  pgDumpBinary?: string;
  now?: Date;
};

type RestoreOptions = {
  manifestFile: string;
  adminDatabaseUrl: string;
  targetDatabase: string;
  reportFile: string;
  cleanup: boolean;
  confirmDrop?: string;
  pgRestoreBinary?: string;
};

type RestoreEnvironment = Record<string, string | undefined>;

export function resolveRestoreAdminDatabaseUrl(
  environment: RestoreEnvironment,
  requestedEnvironmentName = "RESTORE_ADMIN_DATABASE_URL"
): string | undefined {
  const explicit = environment[requestedEnvironmentName]?.trim();
  if (explicit) return explicit;
  if (requestedEnvironmentName !== "RESTORE_ADMIN_DATABASE_URL") return undefined;

  const source = environment.MIGRATION_DATABASE_URL?.trim();
  const user = environment.POSTGRES_USER?.trim();
  const password = environment.POSTGRES_PASSWORD?.trim();
  if (!source || !user || !password) return undefined;
  const parsed = new URL(source);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("MIGRATION_DATABASE_URL deve usar postgres:// ou postgresql://");
  }
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function normalizedHost(host: string): string {
  const lower = host.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(lower) ? "loopback" : lower;
}

export function databaseIdentity(databaseUrl: string, label = "URL do banco"): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} não é uma URL PostgreSQL válida`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${label} deve usar postgres:// ou postgresql://`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!parsed.hostname || !database) throw new Error(`${label} deve informar host e banco`);
  return {
    host: normalizedHost(parsed.hostname),
    port: parsed.port || "5432",
    database
  };
}

function databaseProcessEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password)
  };
  const sslMappings: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY"
  };
  for (const [parameter, variable] of Object.entries(sslMappings)) {
    const value = parsed.searchParams.get(parameter);
    if (value) env[variable] = value;
  }
  return env;
}

export function validateDisposableDatabaseName(database: string): void {
  if (!disposableDatabasePattern.test(database)) {
    throw new Error(
      "Banco de restore inseguro: use atendon_restore_verify_ seguido de UUID hexadecimal sem hífens"
    );
  }
}

export function assertDifferentDatabaseTargets(
  source: DatabaseIdentity,
  target: DatabaseIdentity
): void {
  if (
    source.host === target.host
    && source.port === target.port
    && source.database === target.database
  ) {
    throw new Error("Source e target do restore não podem ser o mesmo banco");
  }
}

async function safeDirectory(input: string, label: string): Promise<string> {
  if (!input.trim() || !isAbsolute(input)) throw new Error(`${label} deve ser um diretório absoluto explícito`);
  const resolved = resolve(input);
  if (resolved === "/" || resolved === resolve(homedir())) {
    throw new Error(`${label} não pode ser a raiz nem o diretório home`);
  }
  if (resolved.split("/").filter(Boolean).length < 2) {
    throw new Error(`${label} deve apontar para uma subpasta dedicada, não um diretório amplo`);
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (canonical === "/" || canonical === resolve(homedir())) {
    throw new Error(`${label} resolve para um diretório amplo e inseguro`);
  }
  if (canonical.split("/").filter(Boolean).length < 2) {
    throw new Error(`${label} resolve para um diretório amplo e inseguro`);
  }
  const directoryStats = await stat(canonical);
  if (!directoryStats.isDirectory()) throw new Error(`${label} não é um diretório`);
  if ((directoryStats.mode & 0o077) !== 0) {
    throw new Error(`${label} deve ter permissões restritas (0700)`);
  }
  return canonical;
}

async function safeReportFile(input: string): Promise<string> {
  if (!input.trim() || !isAbsolute(input)) throw new Error("Arquivo de relatório deve usar caminho absoluto");
  const directory = await safeDirectory(dirname(resolve(input)), "Diretório do relatório");
  return join(directory, basename(input));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function validatedBackupOwnerRole(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-z_][a-z0-9_$]{0,62}$/.test(value)) {
    throw new Error("Backup owner role must be a simple lowercase PostgreSQL identifier");
  }
  return value;
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function executableVersion(binary: string): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => reject(new Error(`Binário PostgreSQL indisponível: ${binary} (${error.message})`)));
    child.once("close", (code) => {
      if (code === 0) resolveVersion(stdout.trim());
      else reject(new Error(`Não foi possível executar ${binary}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

async function dumpToFile(input: {
  binary: string;
  databaseUrl: string;
  ownerRole?: string;
  snapshot: string;
  targetFile: string;
}): Promise<void> {
  await executableVersion(input.binary);
  await new Promise<void>((resolveDump, reject) => {
    const output = createWriteStream(input.targetFile, { mode: 0o600, flags: "wx" });
    const child = spawn(input.binary, [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      ...(input.ownerRole ? [`--role=${input.ownerRole}`] : []),
      `--snapshot=${input.snapshot}`
    ], {
      env: databaseProcessEnvironment(input.databaseUrl),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let outputError: Error | undefined;
    output.once("error", (error) => { outputError = error; child.kill("SIGTERM"); });
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once("error", (error) => reject(new Error(`pg_dump não pôde iniciar: ${error.message}`)));
    child.once("close", (code) => {
      output.end(() => {
        if (outputError) reject(outputError);
        else if (code === 0) resolveDump();
        else reject(new Error(`pg_dump falhou (código ${code}): ${stderr.trim().slice(0, 2_000)}`));
      });
    });
  });
  await chmod(input.targetFile, 0o600);
}

async function restoreFromFile(input: {
  binary: string;
  databaseUrl: string;
  dumpFile: string;
}): Promise<void> {
  await executableVersion(input.binary);
  const identity = databaseIdentity(input.databaseUrl);
  await new Promise<void>((resolveRestore, reject) => {
    const child = spawn(input.binary, [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      `--dbname=${identity.database}`
    ], {
      env: databaseProcessEnvironment(input.databaseUrl),
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    const archive = createReadStream(input.dumpFile);
    archive.once("error", (error) => { child.kill("SIGTERM"); reject(error); });
    archive.pipe(child.stdin);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once("error", (error) => reject(new Error(`pg_restore não pôde iniciar: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolveRestore();
      else reject(new Error(`pg_restore falhou (código ${code}): ${stderr.trim().slice(0, 2_000)}`));
    });
  });
}

async function migrationState(client: pg.PoolClient | pg.Client): Promise<{ latest: string | null; count: number }> {
  const exists = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text table_name"
  );
  if (!exists.rows[0]?.table_name) return { latest: null, count: 0 };
  const result = await client.query<{ latest: string | null; count: number }>(
    "SELECT max(filename) latest,count(*)::int count FROM schema_migrations"
  );
  return result.rows[0];
}

async function criticalTableCounts(
  client: pg.PoolClient | pg.Client,
  expectedTables: readonly string[] = CRITICAL_DATABASE_TABLES
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of expectedTables) {
    if (!CRITICAL_DATABASE_TABLES.includes(table as typeof CRITICAL_DATABASE_TABLES[number])) {
      throw new Error(`Tabela crítica não permitida: ${table}`);
    }
    const exists = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass($1)::text table_name",
      [`public.${table}`]
    );
    if (!exists.rows[0]?.table_name) continue;
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int count FROM ${quoteIdentifier(table)}`
    );
    counts[table] = result.rows[0].count;
  }
  return counts;
}

export async function createDatabaseBackup(options: BackupOptions): Promise<{
  dumpFile: string;
  manifestFile: string;
  manifest: DatabaseBackupManifest;
}> {
  const ownerRole = validatedBackupOwnerRole(options.ownerRole);
  const outputDirectory = await safeDirectory(options.outputDirectory, "Diretório de backup");
  const identity = databaseIdentity(options.databaseUrl, "DATABASE_URL");
  const now = options.now ?? new Date();
  const timestamp = now.toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
  const safeDatabase = identity.database.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const stem = `atendon-${safeDatabase}-${timestamp}`;
  const finalDump = join(outputDirectory, `${stem}.dump`);
  const finalManifest = join(outputDirectory, `${stem}.manifest.json`);
  const operationId = randomUUID();
  const temporaryDump = join(outputDirectory, `.${stem}.${operationId}.dump.tmp`);
  const temporaryManifest = join(outputDirectory, `.${stem}.${operationId}.manifest.tmp`);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  let publishedDump = false;
  let publishedManifest = false;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (ownerRole) {
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    }
    const snapshot = (await client.query<{ snapshot: string }>(
      "SELECT pg_export_snapshot() snapshot"
    )).rows[0].snapshot;
    const migrations = await migrationState(client);
    const tableCounts = await criticalTableCounts(client);
    const constraints = await constraintState(client);
    await dumpToFile({
      binary: options.pgDumpBinary ?? (process.env.PG_DUMP_BIN?.trim() || "pg_dump"),
      databaseUrl: options.databaseUrl,
      ownerRole,
      snapshot,
      targetFile: temporaryDump
    });
    await client.query("COMMIT");
    const dumpStats = await stat(temporaryDump);
    const manifest: DatabaseBackupManifest = {
      schemaVersion: 1,
      kind: "atendon-postgresql-backup",
      createdAt: now.toISOString(),
      deployVersion: options.deployVersion.trim() || "unknown",
      source: identity,
      migrations,
      schema: {
        constraints: constraints.total,
        foreignKeys: constraints.foreignKeys
      },
      tableCounts,
      dump: {
        file: basename(finalDump),
        format: "custom",
        noOwner: true,
        noAcl: true,
        bytes: dumpStats.size,
        sha256: await sha256File(temporaryDump)
      }
    };
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await link(temporaryDump, finalDump);
    publishedDump = true;
    await link(temporaryManifest, finalManifest);
    publishedManifest = true;
    await Promise.all([rm(temporaryDump), rm(temporaryManifest)]);
    return { dumpFile: finalDump, manifestFile: finalManifest, manifest };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await Promise.all([
      rm(temporaryDump, { force: true }),
      rm(temporaryManifest, { force: true }),
      ...(publishedDump ? [rm(finalDump, { force: true })] : []),
      ...(publishedManifest ? [rm(finalManifest, { force: true })] : [])
    ]);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function readAndValidateManifest(manifestFile: string): Promise<{
  manifest: DatabaseBackupManifest;
  dumpFile: string;
}> {
  const parsed = manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  if (basename(parsed.dump.file) !== parsed.dump.file) {
    throw new Error("Manifesto contém caminho de dump inseguro");
  }
  const dumpFile = join(dirname(resolve(manifestFile)), parsed.dump.file);
  const dumpStats = await stat(dumpFile);
  if (!dumpStats.isFile() || dumpStats.size !== parsed.dump.bytes) {
    throw new Error("Tamanho do dump diverge do manifesto");
  }
  const actualChecksum = await sha256File(dumpFile);
  if (actualChecksum !== parsed.dump.sha256) throw new Error("Checksum SHA-256 do dump inválido");
  return { manifest: parsed, dumpFile };
}

function targetDatabaseUrl(adminDatabaseUrl: string, targetDatabase: string): string {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${targetDatabase}`;
  return parsed.toString();
}

async function constraintState(
  client: pg.Client | pg.PoolClient
): Promise<Pick<RestoreVerificationReport["constraints"], "total" | "invalid" | "foreignKeys" | "invalidForeignKeys">> {
  const result = await client.query<{
    total: number;
    invalid: number;
    foreign_keys: number;
    invalid_foreign_keys: number;
  }>(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE NOT con.convalidated)::int invalid,
            count(*) FILTER (WHERE con.contype='f')::int foreign_keys,
            count(*) FILTER (
              WHERE con.contype='f' AND NOT con.convalidated
            )::int invalid_foreign_keys
     FROM pg_constraint con
     JOIN pg_namespace ns ON ns.oid=con.connamespace
     WHERE ns.nspname='public'`
  );
  return {
    total: result.rows[0].total,
    invalid: result.rows[0].invalid,
    foreignKeys: result.rows[0].foreign_keys,
    invalidForeignKeys: result.rows[0].invalid_foreign_keys
  };
}

async function writeReport(reportFile: string, report: RestoreVerificationReport): Promise<void> {
  const target = await safeReportFile(reportFile);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  try {
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyDatabaseRestore(options: RestoreOptions): Promise<RestoreVerificationReport> {
  validateDisposableDatabaseName(options.targetDatabase);
  if (options.cleanup && options.confirmDrop !== options.targetDatabase) {
    throw new Error("Cleanup exige --confirm-drop exatamente igual ao banco descartável");
  }
  if (!options.cleanup && options.confirmDrop) {
    throw new Error("--confirm-drop só pode ser usado junto com --cleanup");
  }
  const { manifest, dumpFile } = await readAndValidateManifest(options.manifestFile);
  const adminIdentity = databaseIdentity(options.adminDatabaseUrl, "URL administrativa");
  const targetIdentity = { ...adminIdentity, database: options.targetDatabase };
  assertDifferentDatabaseTargets(manifest.source, targetIdentity);
  const admin = new pg.Client({ connectionString: options.adminDatabaseUrl });
  let created = false;
  let cleanupCompleted = false;
  let pendingError: unknown;
  let report: RestoreVerificationReport | undefined;
  try {
    await admin.connect();
    const existing = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) exists",
      [options.targetDatabase]
    );
    if (existing.rows[0].exists) {
      throw new Error("Banco descartável já existe; o verificador nunca sobrescreve um target existente");
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(options.targetDatabase)} TEMPLATE template0`);
    created = true;
    const restoredUrl = targetDatabaseUrl(options.adminDatabaseUrl, options.targetDatabase);
    await restoreFromFile({
      binary: options.pgRestoreBinary ?? (process.env.PG_RESTORE_BIN?.trim() || "pg_restore"),
      databaseUrl: restoredUrl,
      dumpFile
    });
    const restored = new pg.Client({ connectionString: restoredUrl });
    try {
      await restored.connect();
      const migrations = await migrationState(restored);
      const actualCounts = await criticalTableCounts(restored, Object.keys(manifest.tableCounts));
      const tableCounts = Object.fromEntries(Object.entries(manifest.tableCounts).map(([table, expected]) => {
        const actual = actualCounts[table] ?? -1;
        return [table, { expected, actual, matches: actual === expected }];
      }));
      const constraints = await constraintState(restored);
      const constraintsMatch = constraints.total === manifest.schema.constraints
        && constraints.foreignKeys === manifest.schema.foreignKeys;
      const valid = migrations.latest === manifest.migrations.latest
        && migrations.count === manifest.migrations.count
        && Object.values(tableCounts).every((count) => count.matches)
        && constraintsMatch
        && constraints.invalid === 0
        && constraints.invalidForeignKeys === 0;
      report = {
        schemaVersion: 1,
        kind: "atendon-postgresql-restore-verification",
        verifiedAt: new Date().toISOString(),
        success: valid,
        manifestFile: basename(options.manifestFile),
        dumpSha256: manifest.dump.sha256,
        target: targetIdentity,
        migrations: {
          expectedLatest: manifest.migrations.latest,
          actualLatest: migrations.latest,
          expectedCount: manifest.migrations.count,
          actualCount: migrations.count
        },
        tableCounts,
        constraints: {
          expectedTotal: manifest.schema.constraints,
          ...constraints,
          expectedForeignKeys: manifest.schema.foreignKeys,
          matches: constraintsMatch
        },
        cleanup: { requested: options.cleanup, completed: false },
        ...(valid ? {} : { error: "Restore divergiu do manifesto ou contém constraints inválidas" })
      };
      if (!valid) throw new Error(report.error);
    } finally {
      await restored.end().catch(() => undefined);
    }
  } catch (error) {
    pendingError = error;
  } finally {
    if (created && options.cleanup && options.confirmDrop === options.targetDatabase) {
      await admin.query(`DROP DATABASE ${quoteIdentifier(options.targetDatabase)}`)
        .then(() => { cleanupCompleted = true; })
        .catch((cleanupError) => {
          pendingError ??= cleanupError;
        });
    }
    await admin.end().catch(() => undefined);
  }
  report ??= {
    schemaVersion: 1,
    kind: "atendon-postgresql-restore-verification",
    verifiedAt: new Date().toISOString(),
    success: false,
    manifestFile: basename(options.manifestFile),
    dumpSha256: manifest.dump.sha256,
    target: targetIdentity,
    migrations: {
      expectedLatest: manifest.migrations.latest,
      actualLatest: null,
      expectedCount: manifest.migrations.count,
      actualCount: 0
    },
    tableCounts: Object.fromEntries(
      Object.entries(manifest.tableCounts).map(([table, expected]) => [
        table,
        { expected, actual: -1, matches: false }
      ])
    ),
    constraints: {
      expectedTotal: manifest.schema.constraints,
      total: 0,
      invalid: 0,
      expectedForeignKeys: manifest.schema.foreignKeys,
      foreignKeys: 0,
      invalidForeignKeys: 0,
      matches: false
    },
    cleanup: { requested: options.cleanup, completed: cleanupCompleted },
    error: pendingError instanceof Error ? pendingError.message : String(pendingError)
  };
  report.cleanup.completed = cleanupCompleted;
  if (pendingError) {
    report.success = false;
    report.error ??= pendingError instanceof Error ? pendingError.message : String(pendingError);
  }
  await writeReport(options.reportFile, report);
  if (pendingError) throw pendingError;
  return report;
}

export function parseArguments(argv: string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Argumento inválido: ${argument}`);
    const key = argument.slice(2);
    if (["cleanup"].includes(key)) {
      parsed.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Valor ausente para --${key}`);
    parsed.set(key, value);
    index += 1;
  }
  return parsed;
}

export function requiredArgument(argumentsMap: Map<string, string | true>, name: string): string {
  const value = argumentsMap.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} é obrigatório`);
  return value;
}

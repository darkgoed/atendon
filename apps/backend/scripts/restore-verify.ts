import { existsSync, statSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  parseArguments,
  requiredArgument,
  resolveRestoreAdminDatabaseUrl,
  verifyDatabaseRestore
} from "./database-backup-lib.js";
import {
  assertPrivateMigrationEnvFile,
  resolveMigrationEnvPath,
  resolveRuntimeEnvPath
} from "../src/db/migration-config.js";

const migrationModuleUrl = new URL("../src/db/migrate.js", import.meta.url).href;
loadEnv({ path: resolveRuntimeEnvPath(migrationModuleUrl), quiet: true });
const migrationEnvPath = resolveMigrationEnvPath(migrationModuleUrl, process.env);
if (existsSync(migrationEnvPath)) {
  assertPrivateMigrationEnvFile(migrationEnvPath, statSync(migrationEnvPath).mode);
  loadEnv({ path: migrationEnvPath, override: true, quiet: true });
}

const argumentsMap = parseArguments(process.argv.slice(2));
const environmentName = String(argumentsMap.get("admin-database-env") ?? "RESTORE_ADMIN_DATABASE_URL");
if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
  throw new Error("--admin-database-env deve ser o nome seguro de uma variável de ambiente");
}
const adminDatabaseUrl = resolveRestoreAdminDatabaseUrl(process.env, environmentName);
if (!adminDatabaseUrl) {
  throw new Error(
    `${environmentName} não está configurada; defina-a ou configure POSTGRES_USER/POSTGRES_PASSWORD em .env.migration`
  );
}

const report = await verifyDatabaseRestore({
  manifestFile: requiredArgument(argumentsMap, "manifest"),
  adminDatabaseUrl,
  targetDatabase: requiredArgument(argumentsMap, "target-database"),
  reportFile: requiredArgument(argumentsMap, "report-file"),
  cleanup: argumentsMap.get("cleanup") === true,
  confirmDrop: typeof argumentsMap.get("confirm-drop") === "string"
    ? String(argumentsMap.get("confirm-drop"))
    : undefined,
  pgRestoreBinary: typeof argumentsMap.get("pg-restore") === "string"
    ? String(argumentsMap.get("pg-restore"))
    : undefined
});

console.log(JSON.stringify({
  status: report.success ? "verified" : "failed",
  reportFile: requiredArgument(argumentsMap, "report-file"),
  targetDatabase: report.target.database,
  cleanupCompleted: report.cleanup.completed,
  latestMigration: report.migrations.actualLatest
}));

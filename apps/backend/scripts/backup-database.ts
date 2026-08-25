import { existsSync, statSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  assertPrivateMigrationEnvFile,
  resolveMigrationEnvPath,
  resolveRuntimeEnvPath
} from "../src/db/migration-config.js";
import {
  createDatabaseBackup,
  parseArguments,
  requiredArgument
} from "./database-backup-lib.js";

// The shared resolvers are anchored to modules under src/db. Keep that anchor
// here as well; using this script's URL would walk one directory too far and
// silently miss both project-level environment files.
const migrationModuleUrl = new URL("../src/db/migrate.js", import.meta.url).href;
const requiredDeployVersion = process.env.DEPLOY_VERSION;
const requiredNodeEnvironment = process.env.NODE_ENV;
loadEnv({ path: resolveRuntimeEnvPath(migrationModuleUrl), quiet: true });
const migrationEnvPath = resolveMigrationEnvPath(migrationModuleUrl, process.env);
if (existsSync(migrationEnvPath)) {
  assertPrivateMigrationEnvFile(migrationEnvPath, statSync(migrationEnvPath).mode);
  loadEnv({ path: migrationEnvPath, override: true, quiet: true });
}
if (requiredDeployVersion !== undefined) process.env.DEPLOY_VERSION = requiredDeployVersion;
if (requiredNodeEnvironment !== undefined) process.env.NODE_ENV = requiredNodeEnvironment;

const argumentsMap = parseArguments(process.argv.slice(2));
const environmentName = String(argumentsMap.get("database-env") ?? "MIGRATION_DATABASE_URL");
if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
  throw new Error("--database-env deve ser o nome seguro de uma variável de ambiente");
}
const databaseUrl = process.env[environmentName]?.trim();
if (!databaseUrl) throw new Error(`${environmentName} não está configurada`);

const result = await createDatabaseBackup({
  databaseUrl,
  outputDirectory: requiredArgument(argumentsMap, "output-dir"),
  deployVersion: process.env.DEPLOY_VERSION?.trim() || "unknown",
  ownerRole: process.env.DATABASE_OWNER_ROLE?.trim() || undefined,
  pgDumpBinary: typeof argumentsMap.get("pg-dump") === "string"
    ? String(argumentsMap.get("pg-dump"))
    : undefined
});

console.log(JSON.stringify({
  status: "created",
  dumpFile: result.dumpFile,
  manifestFile: result.manifestFile,
  sha256: result.manifest.dump.sha256,
  latestMigration: result.manifest.migrations.latest,
  createdAt: result.manifest.createdAt
}));

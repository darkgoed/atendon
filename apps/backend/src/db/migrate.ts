import { existsSync, statSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertPrivateMigrationEnvFile,
  parseMigrationConfig,
  resolveMigrationEnvPath,
  resolveRuntimeEnvPath
} from "./migration-config.js";
import { runMigrations } from "./migration-runner.js";

loadEnv({ path: resolveRuntimeEnvPath(import.meta.url), quiet: true });
const migrationEnvPath = resolveMigrationEnvPath(import.meta.url, process.env);
if (existsSync(migrationEnvPath)) {
  const requiredNodeEnvironment = process.env.NODE_ENV;
  assertPrivateMigrationEnvFile(migrationEnvPath, statSync(migrationEnvPath).mode);
  loadEnv({ path: migrationEnvPath, override: true, quiet: true });
  // An explicit NODE_ENV on the deploy command is authoritative. A stale
  // NODE_ENV in .env.migration must never downgrade a production migration.
  if (requiredNodeEnvironment !== undefined) process.env.NODE_ENV = requiredNodeEnvironment;
}

const directory = fileURLToPath(new URL("./migrations", import.meta.url));
const migrationConfig = parseMigrationConfig(process.env);
const client = new pg.Client({ connectionString: migrationConfig.databaseUrl });
try {
  await client.connect();
  await runMigrations(client, directory, console.log, { ownerRole: migrationConfig.ownerRole });
} finally {
  await client.end();
}

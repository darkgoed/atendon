import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { databaseTarget, resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";
import { installTestOnlyTriggers } from "./test-triggers.js";

loadTestEnvironment();

const controllerUrl = resolveTestDatabaseUrl(process.env);
const databaseName = `atendon_test_${randomUUID().replaceAll("-", "")}`;
const databaseIdentifier = `"${databaseName}"`;
const disposableUrl = new URL(controllerUrl);
disposableUrl.pathname = `/${databaseName}`;
disposableUrl.search = "";

const controller = new pg.Client({ connectionString: controllerUrl });
let created = false;
let childResult: { code: number | null; signal: NodeJS.Signals | null } = {
  code: 1,
  signal: null
};

try {
  await controller.connect();
  await controller.query(`CREATE DATABASE ${databaseIdentifier} TEMPLATE template0`);
  created = true;

  const migrationClient = new pg.Client({ connectionString: disposableUrl.toString() });
  try {
    await migrationClient.connect();
    const directory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
    await runMigrations(migrationClient, directory, () => undefined);
    // Same test-only fixtures as scripts/migrate-test.ts; without them legacy
    // integration fixtures (stage 'fechado', flag overrides) fail on a fresh DB.
    await installTestOnlyTriggers(migrationClient);
  } finally {
    await migrationClient.end();
  }

  console.log(`Banco descartável migrado: ${databaseTarget(disposableUrl.toString())}`);
  const vitestEntry = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
  const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: disposableUrl.toString(),
      TEST_DATABASE_URL: disposableUrl.toString(),
      REDIS_URL: process.env.TEST_REDIS_URL?.trim() || "redis://localhost:6382/15"
    }
  });
  childResult = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
} finally {
  if (created) {
    await controller.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [databaseName]
    );
    await controller.query(`DROP DATABASE ${databaseIdentifier}`);
    console.log(`Banco descartável removido: ${databaseName}`);
  }
  await controller.end();
}

if (childResult.signal) process.kill(process.pid, childResult.signal);
process.exitCode = childResult.code ?? 1;

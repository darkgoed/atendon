import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { resolveTestDatabaseUrl } from "./test-database.js";
import { installTestOnlyTriggers } from "./test-triggers.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();

const databaseUrl = resolveTestDatabaseUrl(process.env);
const directory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await runMigrations(client, directory);
  await installTestOnlyTriggers(client);
} finally {
  await client.end();
}

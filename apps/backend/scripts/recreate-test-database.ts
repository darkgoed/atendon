import pg from "pg";
import { databaseTarget, resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();
const testUrl = resolveTestDatabaseUrl(process.env);
const target = new URL(testUrl);
const databaseName = decodeURIComponent(target.pathname.slice(1));
if (!databaseName.endsWith("_test") || databaseName === "postgres") {
  throw new Error(`Recusa ao recriar banco sem sufixo _test: ${databaseTarget(testUrl)}`);
}
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";
const identifier = `"${databaseName.replaceAll('"','""')}"`;
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
try {
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[databaseName]);
  await admin.query(`DROP DATABASE IF EXISTS ${identifier}`);
  await admin.query(`CREATE DATABASE ${identifier}`);
  console.log(`Banco de testes recriado: ${databaseTarget(testUrl)}`);
} finally {
  await admin.end();
}

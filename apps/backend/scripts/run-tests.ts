import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();

const testDatabaseUrl = resolveTestDatabaseUrl(process.env);
const vitestEntry = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: process.env.TEST_REDIS_URL?.trim() || "redis://localhost:6382/15"
  }
});

const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.code ?? 1;

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const testEnvPath = fileURLToPath(new URL("../../../.env.test", import.meta.url));

function assertPrivateFile(path: string): void {
  if (!existsSync(path)) throw new Error(`${path} não existe; copie .env.test.example e use chmod 0600`);
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error(`${path} deve ter permissão 0600`);
  }
}

export function loadTestEnvironment(): void {
  assertPrivateFile(testEnvPath);
  // Tests use only the curated test file (plus variables explicitly supplied
  // by the caller/CI). Loading the runtime .env here can expose production
  // provider, SMTP, OAuth and webhook credentials to test code.
  loadEnv({ path: testEnvPath, override: true, quiet: true });
  process.env.NODE_ENV = "test";
  // resolveTestDatabaseUrl requires a distinct runtime target as a guardrail,
  // but test runners never connect to this placeholder.
  process.env.DATABASE_URL ??= "postgresql://test-only@127.0.0.1:1/atendon_runtime_not_used";
  process.env.PANEL_SEED_PASSWORD ??= "atendon-test-only-password";
}

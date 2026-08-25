import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const panelDir = __dirname;
const baseURL = process.env.PANEL_E2E_BASE_URL ?? "http://127.0.0.1:3299";
const panelOrigin = new URL(baseURL).origin;
const managedBackend = !process.env.PANEL_E2E_BACKEND_URL;
const backendURL = process.env.PANEL_E2E_BACKEND_URL ?? "http://127.0.0.1:3319";
const reuseExistingServer = process.env.PANEL_E2E_REUSE_EXISTING_SERVER === "1";

let managedDatabaseUrl: string | undefined;
let managedRedisUrl: string | undefined;
let managedPanelSeedPassword: string | undefined;
if (managedBackend) {
  const testEnvPath = resolve(panelDir, "../../.env.test");
  if (!existsSync(testEnvPath) || (statSync(testEnvPath).mode & 0o777) !== 0o600) {
    throw new Error(`${testEnvPath} deve existir e ter permissão 0600`);
  }
  const testFileEnvironment: Record<string, string | undefined> = {};
  loadEnv({ path: testEnvPath, processEnv: testFileEnvironment, quiet: true });
  managedDatabaseUrl = process.env.TEST_DATABASE_URL?.trim()
    ?? testFileEnvironment.TEST_DATABASE_URL?.trim();
  if (!managedDatabaseUrl) throw new Error("TEST_DATABASE_URL é obrigatória para executar o E2E");
  const database = new URL(managedDatabaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname.toLowerCase())
    || !/test/i.test(decodeURIComponent(database.pathname))) {
    throw new Error("O E2E gerenciado exige um banco de testes em loopback");
  }

  managedRedisUrl = process.env.TEST_REDIS_URL?.trim()
    ?? testFileEnvironment.TEST_REDIS_URL?.trim()
    ?? "redis://127.0.0.1:6382/15";
  const redis = new URL(managedRedisUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(redis.hostname.toLowerCase())
    || !/^\/(?:[1-9]|1[0-5])$/.test(redis.pathname)) {
    throw new Error("O E2E gerenciado exige um banco Redis de testes não padrão em loopback");
  }

  managedPanelSeedPassword = process.env.PANEL_SEED_PASSWORD
    ?? testFileEnvironment.PANEL_SEED_PASSWORD
    ?? "atendon-test-only-password";
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL,
    colorScheme: "dark",
    locale: "pt-BR",
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "only-on-failure",
    // Authentication is exercised with real test credentials. Do not persist
    // traces, which can retain filled form values.
    trace: "off",
    video: "off"
  },
  webServer: [
    ...(managedBackend ? [{
      command: "node dist/server.js",
      cwd: resolve(panelDir, "../backend"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: managedDatabaseUrl!,
        REDIS_URL: managedRedisUrl!,
        PANEL_SEED_PASSWORD: managedPanelSeedPassword!,
        HOST: "127.0.0.1",
        PORT: "3319",
        PANEL_ORIGIN: panelOrigin,
        PANEL_PUBLIC_URL: panelOrigin,
        WHATSAPP_ENABLED: "false"
      },
      reuseExistingServer,
      timeout: 120_000,
      url: `${backendURL}/health`
    }] : []),
    {
      command: "npm run build:ci && node ../../node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3299",
      cwd: panelDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BACKEND_URL: backendURL
      },
      reuseExistingServer,
      timeout: 180_000,
      url: `${baseURL}/login`
    }
  ]
});

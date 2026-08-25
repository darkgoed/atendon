import { describe, expect, it } from "vitest";
import {
  mergeRuntimeEnvironment,
  parseAppConfig,
  PRIVILEGED_DATABASE_ENVIRONMENT_KEYS,
  removePrivilegedDatabaseSecrets
} from "../src/config.js";
import { dedicatedEvaluatorRuntime } from "../src/modules/agent-improvement/evaluator-runtime.js";

function productionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    DEPLOY_VERSION: "2026.07.25-build.1",
    HOST: "127.0.0.1",
    DATABASE_URL: "postgresql://atendon_app:DatabasePass2026%21@database:5432/atendon",
    JWT_SECRET: "jwt-production-key-2026-with-strong-randomness",
    MEET_ENABLED: "true",
    MEET_JWT_SECRET: "meet-jwt-production-key-2026-with-randomness",
    MEET_JWT_APP_ID: "atendon",
    MEET_PUBLIC_URL: "https://meet.atendon.example",
    DATA_ENCRYPTION_KEY: "data-production-key-2026-with-strong-randomness",
    TENANT_API_KEY: "tenant-production-key-2026-with-strong-randomness",
    PANEL_SEED_PASSWORD: "StrongSeedPass2026",
    PANEL_ORIGIN: "https://app.atendon.example",
    PANEL_PUBLIC_URL: "https://app.atendon.example",
    WHATSAPP_ENABLED: "false",
    ...overrides
  };
}

describe("application configuration", () => {
  it("preserves development defaults without requiring production credentials", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only"
    });

    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.HOST).toBe("127.0.0.1");
    expect(parsed.CONTAINER_RUNTIME).toBe(false);
    expect(parsed.DEPLOY_VERSION).toBe("development");
    expect(parsed.PANEL_ORIGIN).toBe("http://localhost:3200");
    expect(parsed.AI_EVALUATOR_ENABLED).toBe(true);
    expect(parsed.MEET_RECORDING_RETENTION_DAYS).toBe(30);
    expect(parsed.MEET_ENABLED).toBe(false);
    expect(parsed.MEET_PUBLIC_URL).toBe("http://localhost:8444");
    expect(parsed).toMatchObject({
      DATABASE_CONNECTION_TIMEOUT_MS: 10_000,
      DATABASE_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 60_000,
      DATABASE_LOCK_TIMEOUT_MS: 15_000,
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: 60_000
    });
  });

  it("defaults the AI provider-request budget to a 14/2 hard-ceiling/reserved split when the new envs are absent", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only"
    });

    expect(parsed.AI_MAX_PROVIDER_REQUESTS_PER_TURN).toBe(14);
    expect(parsed.AI_RESERVED_FINAL_REQUESTS).toBe(2);
  });

  it("rejects a reserved final-request budget that is not smaller than the hard ceiling", () => {
    expect(() => parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: "4",
      AI_RESERVED_FINAL_REQUESTS: "4"
    })).toThrow(/AI_RESERVED_FINAL_REQUESTS/);

    expect(() => parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: "4",
      AI_RESERVED_FINAL_REQUESTS: "5"
    })).toThrow(/AI_RESERVED_FINAL_REQUESTS/);
  });

  it("accepts a custom reserved final-request budget smaller than the hard ceiling", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: "6",
      AI_RESERVED_FINAL_REQUESTS: "3"
    });

    expect(parsed.AI_MAX_PROVIDER_REQUESTS_PER_TURN).toBe(6);
    expect(parsed.AI_RESERVED_FINAL_REQUESTS).toBe(3);
  });

  it("allows the evaluator to be disabled with one temporary master switch", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      AI_EVALUATOR_ENABLED: "false"
    });

    expect(parsed.AI_EVALUATOR_ENABLED).toBe(false);
  });

  it("loads the optional OpenRouter management key used by the usage balance", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      OPENROUTER_MANAGEMENT_API_KEY: "test-management-key"
    });

    expect(parsed.OPENROUTER_MANAGEMENT_API_KEY).toBe("test-management-key");
  });

  it("accepts a complete VAPID configuration and rejects partial Web Push secrets", () => {
    const base = {
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only"
    };
    expect(parseAppConfig({
      ...base,
      WEB_PUSH_PUBLIC_KEY: "B".repeat(80),
      WEB_PUSH_PRIVATE_KEY: "p".repeat(40),
      WEB_PUSH_SUBJECT: "mailto:ops@atendon.example"
    })).toMatchObject({ WEB_PUSH_SUBJECT: "mailto:ops@atendon.example" });
    expect(() => parseAppConfig({ ...base, WEB_PUSH_PUBLIC_KEY: "B".repeat(80) }))
      .toThrow(/configure juntos web_push/i);
  });

  it("reuses the dedicated changelog OpenRouter runtime for evaluations", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      CHANGELOG_OPENROUTER_API_KEY: "test-openrouter-key"
    });

    expect(dedicatedEvaluatorRuntime(parsed)).toEqual({
      apiKey: "test-openrouter-key",
      model: "google/gemma-4-26b-a4b-it:free"
    });
  });

  it("parses explicit conservative database timeouts and rejects disabled runtime limits", () => {
    const base = {
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only"
    };
    const parsed = parseAppConfig({
      ...base,
      DATABASE_CONNECTION_TIMEOUT_MS: "12000",
      DATABASE_IDLE_TIMEOUT_MS: "45000",
      DATABASE_STATEMENT_TIMEOUT_MS: "90000",
      DATABASE_LOCK_TIMEOUT_MS: "20000",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "120000"
    });
    expect(parsed).toMatchObject({
      DATABASE_CONNECTION_TIMEOUT_MS: 12_000,
      DATABASE_IDLE_TIMEOUT_MS: 45_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 90_000,
      DATABASE_LOCK_TIMEOUT_MS: 20_000,
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: 120_000
    });

    for (const name of [
      "DATABASE_CONNECTION_TIMEOUT_MS",
      "DATABASE_IDLE_TIMEOUT_MS",
      "DATABASE_STATEMENT_TIMEOUT_MS",
      "DATABASE_LOCK_TIMEOUT_MS",
      "DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS"
    ]) {
      expect(() => parseAppConfig({ ...base, [name]: "0" })).toThrow();
    }
  });

  it("accepts an explicit production configuration with strong credentials", () => {
    const parsed = parseAppConfig(productionEnvironment());

    expect(parsed.NODE_ENV).toBe("production");
    expect(parsed.PANEL_PUBLIC_URL).toBe("https://app.atendon.example");
    expect(parsed.DEPLOY_VERSION).toBe("2026.07.25-build.1");
    expect(parsed.DATABASE_RUNTIME_ROLE).toBe("atendon_app");
    expect("MIGRATION_DATABASE_URL" in parsed).toBe(false);
  });

  it("allows the API to bind all interfaces only in an explicitly containerized runtime", () => {
    const parsed = parseAppConfig(productionEnvironment({
      CONTAINER_RUNTIME: "true",
      HOST: "0.0.0.0"
    }));

    expect(parsed.CONTAINER_RUNTIME).toBe(true);
    expect(parsed.HOST).toBe("0.0.0.0");
  });

  it("rejects a non-loopback bind without the explicit container runtime flag", () => {
    expect(() => parseAppConfig(productionEnvironment({ HOST: "0.0.0.0" })))
      .toThrow(/container_runtime/i);
    expect(() => parseAppConfig({
      DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      HOST: "0.0.0.0"
    })).toThrow(/container_runtime/i);
  });

  it("does not require Meet infrastructure credentials while the master switch is off", () => {
    const parsed = parseAppConfig(productionEnvironment({
      MEET_ENABLED: "false",
      MEET_JWT_SECRET: undefined,
      MEET_PUBLIC_URL: undefined
    }));
    expect(parsed.MEET_ENABLED).toBe(false);
  });

  it("requires a dedicated Meet JWT secret when enabled in production", () => {
    expect(() => parseAppConfig(productionEnvironment({ MEET_JWT_SECRET: undefined })))
      .toThrow(/MEET_JWT_SECRET/);
    expect(() => parseAppConfig(productionEnvironment({
      MEET_JWT_SECRET: "jwt-production-key-2026-with-strong-randomness"
    }))).toThrow(/credenciais independentes/i);
  });

  it("requires the Meet token app id in the accepted issuer and audience lists", () => {
    expect(() => parseAppConfig(productionEnvironment({
      MEET_JWT_ACCEPTED_ISSUERS: "another-app"
    }))).toThrow(/accepted_issuers.*meet_jwt_app_id/i);
    expect(() => parseAppConfig(productionEnvironment({
      MEET_JWT_ACCEPTED_AUDIENCES: "another-app"
    }))).toThrow(/accepted_audiences.*meet_jwt_app_id/i);
    expect(parseAppConfig(productionEnvironment({
      MEET_JWT_ACCEPTED_ISSUERS: "another-app, atendon",
      MEET_JWT_ACCEPTED_AUDIENCES: "atendon, another-app"
    })).MEET_ENABLED).toBe(true);
  });

  it("does not load migration credentials into runtime config and enforces the runtime role", () => {
    const parsed = parseAppConfig(productionEnvironment({
      MIGRATION_DATABASE_URL: "postgresql://migration:MigrationSecret2026@database:5432/atendon"
    }));
    expect("MIGRATION_DATABASE_URL" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("MigrationSecret2026");
    expect(() => parseAppConfig(productionEnvironment({
      DATABASE_URL: "postgresql://postgres:DatabasePass2026%21@database:5432/atendon"
    }))).toThrow(/database_runtime_role/i);
  });

  it("removes bootstrap and migration secrets from the API/worker environment", () => {
    const runtimeEnvironment: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://atendon_app:runtime@database/atendon",
      MIGRATION_DATABASE_URL: "postgresql://atendon_migration:migration@database/atendon",
      ATENDON_MIGRATION_DB_PASSWORD: "migration",
      POSTGRES_PASSWORD: "bootstrap"
    };
    removePrivilegedDatabaseSecrets(runtimeEnvironment);
    expect(runtimeEnvironment.DATABASE_URL).toContain("atendon_app");
    for (const name of PRIVILEGED_DATABASE_ENVIRONMENT_KEYS) {
      expect(runtimeEnvironment[name]).toBeUndefined();
    }
  });

  it("filters the runtime dotenv file before copying values to the process environment", () => {
    const dotenvValues: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://atendon_app:runtime@database/atendon",
      MIGRATION_DATABASE_URL: "postgresql://atendon_migration:migration@database/atendon",
      ATENDON_MIGRATION_DB_PASSWORD: "migration",
      POSTGRES_PASSWORD: "bootstrap",
      TEST_DATABASE_URL: "postgresql://admin:test@database/atendon_test"
    };
    const runtimeProcess: Record<string, string | undefined> = {};

    mergeRuntimeEnvironment(dotenvValues, runtimeProcess);

    expect(runtimeProcess).toEqual({
      DATABASE_URL: "postgresql://atendon_app:runtime@database/atendon"
    });
    expect(dotenvValues).toEqual({
      DATABASE_URL: "postgresql://atendon_app:runtime@database/atendon"
    });
  });

  it("requires an immutable deploy version in production", () => {
    expect(() => parseAppConfig(productionEnvironment({ DEPLOY_VERSION: undefined })))
      .toThrow(/deploy_version imutável é obrigatória/i);
    expect(() => parseAppConfig(productionEnvironment({ DEPLOY_VERSION: "latest" })))
      .toThrow(/deploy_version imutável é obrigatória/i);
  });

  it.each([
    ["JWT_SECRET", "change-this-to-at-least-32-random-characters"],
    ["DATA_ENCRYPTION_KEY", "change-this-data-key-to-at-least-32-random-characters"],
    ["TENANT_API_KEY", "change-this-tenant-api-key"],
    ["PANEL_SEED_PASSWORD", "change-me-now"]
  ])("rejects the public %s placeholder in production", (name, placeholder) => {
    expect(() => parseAppConfig(productionEnvironment({ [name]: placeholder }))).toThrow(/exemplo|32 caracteres|12 caracteres/i);
  });

  it("rejects the example database password in production", () => {
    expect(() => parseAppConfig(productionEnvironment({
      DATABASE_URL: "postgresql://atendon:atendon@database:5432/atendon"
    }))).toThrow(/database_url usa a senha pública de exemplo/i);
  });

  it("rejects the public Evolution credentials when WhatsApp is enabled", () => {
    expect(() => parseAppConfig(productionEnvironment({
      WHATSAPP_ENABLED: "true",
      EVOLUTION_API_KEY: "change-this-evolution-api-key",
      EVOLUTION_WEBHOOK_SECRET: "change-this-webhook-header-secret"
    }))).toThrow(/credencial aleatória/i);
  });

  it("requires the CSRF origin to match the public HTTPS panel origin", () => {
    expect(() => parseAppConfig(productionEnvironment({
      PANEL_ORIGIN: "http://localhost:3200"
    }))).toThrow(/panel_origin público com https/i);
    expect(() => parseAppConfig(productionEnvironment({
      PANEL_ORIGIN: "https://admin.atendon.example"
    }))).toThrow(/mesma origem/i);
    expect(() => parseAppConfig(productionEnvironment({
      PANEL_ORIGIN: "https://app.atendon.example/"
    }))).toThrow(/somente a origem/i);
  });

  it("requires independent production keys", () => {
    expect(() => parseAppConfig(productionEnvironment({
      DATA_ENCRYPTION_KEY: "jwt-production-key-2026-with-strong-randomness"
    }))).toThrow(/credenciais independentes/i);
  });

  it("rejects a local Google Meet OAuth callback in production", () => {
    expect(() => parseAppConfig(productionEnvironment({
      GOOGLE_MEET_OAUTH_CLIENT_ID: "meet-client-id",
      GOOGLE_MEET_OAUTH_CLIENT_SECRET: "meet-client-secret-value",
      GOOGLE_MEET_OAUTH_REDIRECT_URI: "http://localhost:3200/backend/scheduling/config/google-meet/oauth/callback"
    }))).toThrow(/callback do google meet deve ser pública/i);
  });
});

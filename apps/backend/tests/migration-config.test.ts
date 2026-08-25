import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertPrivateMigrationEnvFile,
  parseMigrationConfig,
  resolveMigrationEnvPath,
  resolveRuntimeEnvPath
} from "../src/db/migration-config.js";

describe("migration-only database configuration", () => {
  it("separates the repository runtime and migration environment files", () => {
    const migrateModuleUrl = new URL("../src/db/migrate.ts", import.meta.url).href;
    const runtimeEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
    const migrationEnvPath = fileURLToPath(new URL("../../../.env.migration", import.meta.url));

    expect(resolveRuntimeEnvPath(migrateModuleUrl)).toBe(runtimeEnvPath);
    expect(resolveMigrationEnvPath(migrateModuleUrl)).toBe(migrationEnvPath);
    expect(resolveRuntimeEnvPath(migrateModuleUrl)).not.toContain("/apps/.env");
    expect(resolveMigrationEnvPath(migrateModuleUrl, { MIGRATION_ENV_FILE: "./secrets/migration.env" }))
      .toBe(`${process.cwd()}/secrets/migration.env`);
  });

  it("requires a private migration environment file", () => {
    expect(() => assertPrivateMigrationEnvFile(".env.migration", 0o100600)).not.toThrow();
    expect(() => assertPrivateMigrationEnvFile(".env.migration", 0o100640)).toThrow(/0600/i);
    expect(() => assertPrivateMigrationEnvFile(".env.migration", 0o100604)).toThrow(/0600/i);
  });

  it("allows the single-url compatibility fallback only outside production", () => {
    const parsed = parseMigrationConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://local:secret@localhost:5436/atendon"
    });

    expect(parsed).toEqual({
      databaseUrl: "postgresql://local:secret@localhost:5436/atendon",
      usedDevelopmentFallback: true
    });
  });

  it("fails closed when production has no independent migration credential", () => {
    expect(() => parseMigrationConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://atendon_app:runtime-secret@database:5432/atendon"
    })).toThrow(/migration_database_url separada é obrigatória/i);
  });

  it("requires distinct production users targeting the same database", () => {
    const runtime = "postgresql://atendon_app:runtime-secret@database:5432/atendon";
    expect(() => parseMigrationConfig({
      NODE_ENV: "production",
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: "postgresql://atendon_app:migration-secret@database:5432/atendon"
    })).toThrow(/usuários postgresql distintos/i);
    expect(() => parseMigrationConfig({
      NODE_ENV: "production",
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: "postgresql://atendon_migration:migration-secret@other-database:5432/atendon"
    })).toThrow(/mesmo servidor e banco/i);

    expect(parseMigrationConfig({
      NODE_ENV: "production",
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: "postgresql://atendon_migration:migration-secret@database:5432/atendon",
      DATABASE_OWNER_ROLE: "atendon_owner"
    })).toEqual({
      databaseUrl: "postgresql://atendon_migration:migration-secret@database:5432/atendon",
      ownerRole: "atendon_owner",
      usedDevelopmentFallback: false
    });
  });

  it("keeps the NOLOGIN owner distinct and rejects unsafe identifiers", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://atendon_app:runtime-secret@database:5432/atendon",
      MIGRATION_DATABASE_URL: "postgresql://atendon_migration:migration-secret@database:5432/atendon"
    };
    expect(() => parseMigrationConfig({ ...base, DATABASE_OWNER_ROLE: "atendon_app" }))
      .toThrow(/role nologin distinta/i);
    expect(() => parseMigrationConfig({ ...base, DATABASE_OWNER_ROLE: "owner;drop role" }))
      .toThrow(/identificador postgresql/i);
  });
});

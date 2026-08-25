import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const roleName = z.string().trim().min(1).max(63)
  .regex(/^[a-z_][a-z0-9_$]*$/, "Use um identificador PostgreSQL simples e minúsculo");

export interface MigrationConfig {
  databaseUrl: string;
  ownerRole?: string;
  usedDevelopmentFallback: boolean;
}

type MigrationEnvironment = Record<string, string | undefined>;

export function resolveRuntimeEnvPath(migrateModuleUrl: string): string {
  return fileURLToPath(new URL("../../../../.env", migrateModuleUrl));
}

export function resolveMigrationEnvPath(
  migrateModuleUrl: string,
  environment: MigrationEnvironment = {}
): string {
  const configuredPath = environment.MIGRATION_ENV_FILE?.trim();
  return configuredPath
    ? resolve(configuredPath)
    : fileURLToPath(new URL("../../../../.env.migration", migrateModuleUrl));
}

export function assertPrivateMigrationEnvFile(path: string, mode: number): void {
  if ((mode & 0o777) !== 0o600) {
    throw new Error(`${path} deve ter permissão 0600`);
  }
}

function databaseIdentity(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} não é uma URL PostgreSQL válida`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${label} deve usar postgres:// ou postgresql://`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const user = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !database || !user) {
    throw new Error(`${label} deve informar host, banco e usuário`);
  }
  return {
    host: parsed.hostname.toLocaleLowerCase("en-US"),
    port: parsed.port || "5432",
    database,
    user,
    password: decodeURIComponent(parsed.password)
  };
}

export function parseMigrationConfig(environment: MigrationEnvironment): MigrationConfig {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnvironment)) {
    throw new Error("NODE_ENV inválido para migration");
  }
  const runtimeUrl = environment.DATABASE_URL?.trim();
  if (!runtimeUrl) throw new Error("DATABASE_URL não está configurada");
  const explicitMigrationUrl = environment.MIGRATION_DATABASE_URL?.trim();
  if (nodeEnvironment === "production" && !explicitMigrationUrl) {
    throw new Error("MIGRATION_DATABASE_URL separada é obrigatória em produção");
  }
  const migrationUrl = explicitMigrationUrl || runtimeUrl;
  const configuredOwnerRole = environment.DATABASE_OWNER_ROLE?.trim();
  const ownerRole = explicitMigrationUrl || nodeEnvironment === "production"
    ? roleName.parse(configuredOwnerRole || "atendon_owner")
    : configuredOwnerRole
      ? roleName.parse(configuredOwnerRole)
      : undefined;
  const runtime = databaseIdentity(runtimeUrl, "DATABASE_URL");
  const migration = databaseIdentity(migrationUrl, "MIGRATION_DATABASE_URL");

  if (
    runtime.host !== migration.host
    || runtime.port !== migration.port
    || runtime.database !== migration.database
  ) {
    throw new Error("MIGRATION_DATABASE_URL deve apontar para o mesmo servidor e banco de DATABASE_URL");
  }
  if (nodeEnvironment === "production") {
    if (runtime.user === migration.user) {
      throw new Error("Runtime e migration devem usar usuários PostgreSQL distintos em produção");
    }
    if (!runtime.password || !migration.password) {
      throw new Error("Runtime e migration exigem senhas PostgreSQL explícitas em produção");
    }
    if (runtime.user === ownerRole || migration.user === ownerRole) {
      throw new Error("DATABASE_OWNER_ROLE deve ser uma role NOLOGIN distinta dos usuários de conexão");
    }
  }

  return {
    databaseUrl: migrationUrl,
    ownerRole,
    usedDevelopmentFallback: !explicitMigrationUrl
  };
}

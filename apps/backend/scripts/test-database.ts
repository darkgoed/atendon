export interface TestDatabaseEnvironment {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  TEST_DATABASE_URL?: string;
}

function requiredDatabaseUrl(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} não está configurada`);
  return trimmed;
}

export function databaseTarget(value: string, name = "URL do banco"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} não é uma URL válida`);
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${name} deve usar o protocolo postgres`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!parsed.hostname || !database) {
    throw new Error(`${name} deve informar host e nome do banco`);
  }

  const hostname = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    ? "loopback"
    : parsed.hostname.toLowerCase();
  return `${hostname}:${parsed.port || "5432"}/${database}`;
}

export function resolveTestDatabaseUrl(environment: TestDatabaseEnvironment): string {
  const databaseUrl = requiredDatabaseUrl(environment.DATABASE_URL, "DATABASE_URL");
  const testDatabaseUrl = environment.TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL é obrigatória para executar testes");
  }

  if (databaseTarget(testDatabaseUrl, "TEST_DATABASE_URL") === databaseTarget(databaseUrl, "DATABASE_URL")) {
    throw new Error("TEST_DATABASE_URL deve apontar para um banco diferente de DATABASE_URL");
  }

  return testDatabaseUrl;
}

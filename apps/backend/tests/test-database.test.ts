import { describe, expect, it } from "vitest";
import { databaseTarget, resolveTestDatabaseUrl } from "../scripts/test-database.js";

describe("test database isolation", () => {
  it("requires TEST_DATABASE_URL in every environment", () => {
    expect(() => resolveTestDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://app:secret@db.internal/atendon"
    })).toThrow("TEST_DATABASE_URL é obrigatória");
  });

  it("requires DATABASE_URL so the test target can be compared safely", () => {
    expect(() => resolveTestDatabaseUrl({
      NODE_ENV: "test",
      TEST_DATABASE_URL: "postgresql://tester:secret@db.internal/atendon_test"
    })).toThrow("DATABASE_URL não está configurada");
  });

  it("rejects the production target even when credentials and query parameters differ", () => {
    expect(() => resolveTestDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@db.internal:5432/atendon?sslmode=require",
      TEST_DATABASE_URL: "postgresql://tester:other@DB.INTERNAL/atendon?application_name=tests"
    })).toThrow("deve apontar para um banco diferente");
  });

  it("treats common loopback aliases as the same database server", () => {
    expect(() => resolveTestDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@localhost/atendon",
      TEST_DATABASE_URL: "postgresql://tester:other@127.0.0.1:5432/atendon"
    })).toThrow("deve apontar para um banco diferente");
  });

  it("selects a distinct TEST_DATABASE_URL", () => {
    const testDatabaseUrl = "postgresql://tester:secret@db.internal:5432/atendon_test";
    expect(resolveTestDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@db.internal/atendon",
      TEST_DATABASE_URL: testDatabaseUrl
    })).toBe(testDatabaseUrl);
  });

  it("selects TEST_DATABASE_URL outside production", () => {
    expect(resolveTestDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://app:secret@localhost/atendon",
      TEST_DATABASE_URL: "postgresql://app:secret@localhost/atendon_test"
    })).toContain("/atendon_test");
  });

  it("describes a target without exposing credentials", () => {
    expect(databaseTarget("postgresql://app:top-secret@DB.INTERNAL/atendon_test?sslmode=require"))
      .toBe("db.internal:5432/atendon_test");
  });
});

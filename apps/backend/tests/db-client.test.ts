import pg from "pg";
import { describe, expect, it } from "vitest";
import { config, parseAppConfig } from "../src/config.js";
import {
  databaseApplicationName,
  databasePoolConfig,
  ObservedDatabasePool
} from "../src/db/client.js";
import {
  inMemoryOperationalMetrics,
  resetOperationalMetricsForTests
} from "../src/modules/operations/observability-metrics.js";

describe("database pool guardrails", () => {
  it("assigns stable process names without using tenant or request data", () => {
    expect(databaseApplicationName("/srv/atendon/src/server.ts")).toBe("atendon-api");
    expect(databaseApplicationName("/srv/atendon/src/worker.ts")).toBe("atendon-worker");
    expect(databaseApplicationName("/srv/atendon/src/db/migrate.ts")).toBe("atendon-migration");
    expect(databaseApplicationName("/srv/atendon/scripts/migrate-test.ts")).toBe("atendon-migration");
  });

  it("maps typed runtime limits to node-postgres pool settings", () => {
    const parsed = parseAppConfig({
      DATABASE_URL: "postgresql://runtime:secret@database:5432/atendon",
      PANEL_SEED_PASSWORD: "local-only",
      DATABASE_CONNECTION_TIMEOUT_MS: "11000",
      DATABASE_IDLE_TIMEOUT_MS: "31000",
      DATABASE_STATEMENT_TIMEOUT_MS: "61000",
      DATABASE_LOCK_TIMEOUT_MS: "16000",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "62000"
    });

    expect(databasePoolConfig(parsed, "atendon-test")).toMatchObject({
      connectionString: parsed.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 11_000,
      idleTimeoutMillis: 31_000,
      statement_timeout: 61_000,
      lock_timeout: 16_000,
      idle_in_transaction_session_timeout: 62_000,
      application_name: "atendon-test"
    });
  });

  it("applies the runtime name and timeouts to a real PostgreSQL session", async () => {
    const pool = new pg.Pool(databasePoolConfig(config, "atendon-timeout-test"));
    try {
      const settings = await pool.query<{
        application_name: string;
        statement_timeout_ms: number;
        lock_timeout_ms: number;
        idle_in_transaction_session_timeout_ms: number;
      }>(`SELECT
        current_setting('application_name') application_name,
        (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::int statement_timeout_ms,
        (extract(epoch FROM current_setting('lock_timeout')::interval)*1000)::int lock_timeout_ms,
        (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000)::int
          idle_in_transaction_session_timeout_ms`);
      expect(settings.rows[0]).toEqual({
        application_name: "atendon-timeout-test",
        statement_timeout_ms: config.DATABASE_STATEMENT_TIMEOUT_MS,
        lock_timeout_ms: config.DATABASE_LOCK_TIMEOUT_MS,
        idle_in_transaction_session_timeout_ms: config.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS
      });
    } finally {
      await pool.end();
    }
  });

  it("fails blocked statements and saturated pool waits within configured limits", async () => {
    const parsed = parseAppConfig({
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
      PANEL_SEED_PASSWORD: process.env.PANEL_SEED_PASSWORD ?? "local-only",
      DATABASE_CONNECTION_TIMEOUT_MS: "75",
      DATABASE_IDLE_TIMEOUT_MS: "30000",
      DATABASE_STATEMENT_TIMEOUT_MS: "75",
      DATABASE_LOCK_TIMEOUT_MS: "75",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "60000"
    });
    const timeoutPool = new pg.Pool({
      ...databasePoolConfig(parsed, "atendon-timeout-behavior-test"),
      max: 1
    });
    try {
      await expect(timeoutPool.query("SELECT pg_sleep(0.25)"))
        .rejects.toMatchObject({ code: "57014" });

      const held = await timeoutPool.connect();
      try {
        await expect(timeoutPool.connect()).rejects.toThrow(/timeout exceeded when trying to connect/i);
      } finally {
        held.release();
      }
    } finally {
      await timeoutPool.end();
    }

    const lockPool = new pg.Pool(databasePoolConfig({
      ...parsed,
      DATABASE_STATEMENT_TIMEOUT_MS: 1_000
    }, "atendon-lock-timeout-test"));
    const holder = await lockPool.connect();
    const contender = await lockPool.connect();
    const lockKey = Math.floor(Math.random() * 1_000_000_000);
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [lockKey]);
      await expect(contender.query("SELECT pg_advisory_lock($1)", [lockKey]))
        .rejects.toMatchObject({ code: "55P03" });
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      holder.release();
      contender.release();
      await lockPool.end();
    }
  });

  it("observes pool wait and transaction duration without query text or tenant labels", async () => {
    resetOperationalMetricsForTests();
    const pool = new ObservedDatabasePool(databasePoolConfig(config, "atendon-observability-test"));
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("/* query:operational.test */ SELECT 1");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const metrics = inMemoryOperationalMetrics(pool);
      expect(metrics.histograms).toEqual(expect.arrayContaining([
        expect.objectContaining({
          metric: "database_pool_wait_ms",
          labels: expect.objectContaining({ process: "test", outcome: "success" })
        }),
        expect.objectContaining({
          metric: "database_transaction_duration_ms",
          labels: expect.objectContaining({ process: "test", outcome: "success" })
        }),
        expect.objectContaining({
          metric: "database_statement_duration_ms",
          labels: expect.objectContaining({ query_class: "operational" })
        })
      ]));
      expect(JSON.stringify(metrics)).not.toContain("SELECT 1");
    } finally {
      await pool.end();
    }
  });

  it("terminates an idle transaction within its explicit conservative limit", async () => {
    const parsed = parseAppConfig({
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
      PANEL_SEED_PASSWORD: process.env.PANEL_SEED_PASSWORD ?? "local-only",
      DATABASE_CONNECTION_TIMEOUT_MS: "1000",
      DATABASE_IDLE_TIMEOUT_MS: "30000",
      DATABASE_STATEMENT_TIMEOUT_MS: "1000",
      DATABASE_LOCK_TIMEOUT_MS: "1000",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "75"
    });
    const pool = new pg.Pool(databasePoolConfig(parsed, "atendon-idle-transaction-test"));
    const client = await pool.connect();
    try {
      const disconnected = new Promise<Error>((resolve) => client.once("error", resolve));
      await client.query("BEGIN");
      const error = await Promise.race([
        disconnected,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("idle transaction was not terminated")), 1_000);
        })
      ]);
      expect(error.message).toMatch(/idle-in-transaction timeout|terminating connection/i);
    } finally {
      client.release(true);
      await pool.end();
    }
  });
});

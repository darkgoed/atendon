import { describe, expect, it } from "vitest";
import {
  beginObservedTransaction,
  databaseOutcome,
  databaseQueryClass,
  endObservedTransaction,
  incrementRealtimeMetric,
  inMemoryOperationalMetrics,
  observeDatabaseHistogram,
  observabilityProcess,
  recordReconcilerMetric,
  recordReconcilerOldestAge,
  resetOperationalMetricsForTests
} from "../src/modules/operations/observability-metrics.js";

const fakePool = {
  totalCount: 10,
  idleCount: 3,
  waitingCount: 2,
  options: { max: 12 }
};

describe("operational metrics", () => {
  it("uses only fixed process, query and error labels", () => {
    expect(observabilityProcess("atendon-api")).toBe("api");
    expect(observabilityProcess("atendon-worker")).toBe("worker");
    expect(observabilityProcess("atendon-migration")).toBe("migration");
    expect(observabilityProcess("tenant-or-request-controlled")).toBe("unknown");
    expect(databaseQueryClass("/* query:operational.outbox_snapshot */ SELECT 1"))
      .toBe("operational");
    expect(databaseQueryClass("SELECT * FROM messages WHERE content='private'"))
      .toBe("unnamed");
    expect(databaseOutcome({ code: "57014" })).toBe("statement_timeout");
    expect(databaseOutcome({ code: "55P03" })).toBe("lock_timeout");
    expect(databaseOutcome({ code: "40P01" })).toBe("deadlock");
    expect(databaseOutcome(new Error("timeout exceeded when trying to connect")))
      .toBe("connection_timeout");
  });

  it("reports bounded p95/p99 histograms, pool use, transaction age and realtime counters", () => {
    resetOperationalMetricsForTests();
    for (let durationMs = 1; durationMs <= 100; durationMs += 1) {
      observeDatabaseHistogram({
        metric: "database_pool_wait_ms",
        process: "api",
        outcome: "success",
        durationMs
      });
    }
    const transaction = beginObservedTransaction("api");
    incrementRealtimeMetric("sse", "accepted");
    incrementRealtimeMetric("sse", "catchup");
    recordReconcilerMetric("evaluation", "examined", 3);
    recordReconcilerMetric("evaluation", "enqueued", 2);
    recordReconcilerMetric("evaluation", "deduplicated");
    recordReconcilerOldestAge("evaluation", 2_500);
    const during = inMemoryOperationalMetrics(fakePool as never);
    expect(during.pool).toEqual({ total: 10, idle: 3, used: 7, waiting: 2, max: 12 });
    expect(during.active_transactions.count).toBe(1);
    expect(during.histograms).toContainEqual(expect.objectContaining({
      metric: "database_pool_wait_ms",
      labels: { process: "api", outcome: "success", query_class: "unnamed" },
      count: 100,
      p95_ms: 95,
      p99_ms: 99,
      window_samples: 100
    }));
    expect(during.realtime).toMatchObject({
      active_sse_connections: 1,
      counters: expect.arrayContaining([
        { labels: { component: "sse", event: "accepted" }, value: 1 },
        { labels: { component: "sse", event: "catchup" }, value: 1 }
      ])
    });
    expect(during.reconcilers).toContainEqual({
      labels: { workflow: "evaluation" },
      oldest_age_ms: 2_500,
      counters: [
        { event: "examined", value: 3 },
        { event: "enqueued", value: 2 },
        { event: "deduplicated", value: 1 },
        { event: "error", value: 0 }
      ]
    });
    incrementRealtimeMetric("sse", "closed");
    endObservedTransaction(transaction, "success");
    const after = inMemoryOperationalMetrics(fakePool as never);
    expect(after.active_transactions.count).toBe(0);
    expect(after.realtime.active_sse_connections).toBe(0);
    expect(after.histograms).toContainEqual(expect.objectContaining({
      metric: "database_transaction_duration_ms",
      labels: { process: "api", outcome: "success", query_class: "unnamed" },
      count: 1
    }));
  });
});

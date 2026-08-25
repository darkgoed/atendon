import type pg from "pg";

const HISTOGRAM_WINDOW_SIZE = 4_096;

export const OBSERVABILITY_PROCESSES = ["api", "worker", "migration", "test", "unknown"] as const;
export type ObservabilityProcess = typeof OBSERVABILITY_PROCESSES[number];
export const DATABASE_OUTCOMES = [
  "success",
  "connection_timeout",
  "statement_timeout",
  "lock_timeout",
  "idle_transaction_timeout",
  "deadlock",
  "error",
  "abandoned"
] as const;
export type DatabaseOutcome = typeof DATABASE_OUTCOMES[number];
export const DATABASE_QUERY_CLASSES = ["operational", "readiness", "realtime", "unnamed"] as const;
export type DatabaseQueryClass = typeof DATABASE_QUERY_CLASSES[number];
export const REALTIME_COMPONENTS = [
  "postgres_listener",
  "redis_publish",
  "redis_publisher",
  "redis_subscriber",
  "sse"
] as const;
export type RealtimeComponent = typeof REALTIME_COMPONENTS[number];
export const REALTIME_EVENTS = [
  "connect",
  "disconnect",
  "publish_error",
  "parse_error",
  "catchup",
  "accepted",
  "closed",
  "rejected"
] as const;
export type RealtimeEvent = typeof REALTIME_EVENTS[number];
export const RECONCILER_WORKFLOWS = ["handoff", "follow_up", "evaluation"] as const;
export type ReconcilerWorkflow = typeof RECONCILER_WORKFLOWS[number];
export const RECONCILER_EVENTS = ["examined", "enqueued", "deduplicated", "error"] as const;
export type ReconcilerEvent = typeof RECONCILER_EVENTS[number];

export type HistogramMetric =
  | "database_pool_wait_ms"
  | "database_statement_duration_ms"
  | "database_transaction_duration_ms";

interface HistogramSeries {
  count: number;
  sum: number;
  values: number[];
}

const histograms = new Map<string, HistogramSeries>();
const counters = new Map<string, number>();
const activeTransactions = new Set<{ process: ObservabilityProcess; startedAt: number }>();
let activeSseConnections = 0;
const reconcilerOldestAgeMs = new Map<ReconcilerWorkflow, number>();

function percentile(sorted: number[], quantile: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function histogramKey(
  metric: HistogramMetric,
  process: ObservabilityProcess,
  outcome: DatabaseOutcome,
  queryClass: DatabaseQueryClass
): string {
  return `${metric}|${process}|${outcome}|${queryClass}`;
}

export function observabilityProcess(applicationName: string): ObservabilityProcess {
  if (applicationName === "atendon-api") return "api";
  if (applicationName === "atendon-worker") return "worker";
  if (applicationName === "atendon-migration") return "migration";
  if (applicationName.startsWith("atendon-") && applicationName.endsWith("-test")) return "test";
  return "unknown";
}

export function databaseQueryClass(text: string | undefined): DatabaseQueryClass {
  if (!text) return "unnamed";
  const match = text.match(/^\s*\/\*\s*query:(operational|readiness|realtime)(?:\.[a-z0-9_.-]+)?\s*\*\//i);
  return match?.[1]?.toLocaleLowerCase("en-US") as DatabaseQueryClass ?? "unnamed";
}

export function databaseOutcome(error?: unknown): DatabaseOutcome {
  if (!error) return "success";
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "57014") return "statement_timeout";
  if (code === "55P03") return "lock_timeout";
  if (code === "25P03") return "idle_transaction_timeout";
  if (code === "40P01") return "deadlock";
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout exceeded when trying to connect/i.test(message)) return "connection_timeout";
  return "error";
}

export function observeDatabaseHistogram(input: {
  metric: HistogramMetric;
  process: ObservabilityProcess;
  outcome: DatabaseOutcome;
  queryClass?: DatabaseQueryClass;
  durationMs: number;
}): void {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  const queryClass = input.queryClass ?? "unnamed";
  const key = histogramKey(input.metric, input.process, input.outcome, queryClass);
  const series = histograms.get(key) ?? { count: 0, sum: 0, values: [] };
  series.count += 1;
  series.sum += input.durationMs;
  series.values.push(input.durationMs);
  if (series.values.length > HISTOGRAM_WINDOW_SIZE) {
    series.values.splice(0, series.values.length - HISTOGRAM_WINDOW_SIZE);
  }
  histograms.set(key, series);
}

export function beginObservedTransaction(process: ObservabilityProcess): {
  process: ObservabilityProcess;
  startedAt: number;
} {
  const transaction = { process, startedAt: Date.now() };
  activeTransactions.add(transaction);
  return transaction;
}

export function endObservedTransaction(
  transaction: { process: ObservabilityProcess; startedAt: number },
  outcome: DatabaseOutcome
): void {
  if (!activeTransactions.delete(transaction)) return;
  observeDatabaseHistogram({
    metric: "database_transaction_duration_ms",
    process: transaction.process,
    outcome,
    durationMs: Math.max(0, Date.now() - transaction.startedAt)
  });
}

export function incrementRealtimeMetric(component: RealtimeComponent, event: RealtimeEvent): void {
  const key = `realtime|${component}|${event}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  if (component === "sse" && event === "accepted") activeSseConnections += 1;
  if (component === "sse" && event === "closed") activeSseConnections = Math.max(0, activeSseConnections - 1);
}

export function recordReconcilerMetric(
  workflow: ReconcilerWorkflow,
  event: ReconcilerEvent,
  value = 1
): void {
  if (!Number.isSafeInteger(value) || value < 0) return;
  const key = `reconciler|${workflow}|${event}`;
  counters.set(key, (counters.get(key) ?? 0) + value);
}

export function recordReconcilerOldestAge(workflow: ReconcilerWorkflow, ageMs: number): void {
  if (!Number.isFinite(ageMs) || ageMs < 0) return;
  reconcilerOldestAgeMs.set(workflow, ageMs);
}

export function resetOperationalMetricsForTests(): void {
  histograms.clear();
  counters.clear();
  activeTransactions.clear();
  activeSseConnections = 0;
  reconcilerOldestAgeMs.clear();
}

export function inMemoryOperationalMetrics(pool: pg.Pool) {
  const now = Date.now();
  return {
    generated_at: new Date(now).toISOString(),
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      used: Math.max(0, pool.totalCount - pool.idleCount),
      waiting: pool.waitingCount,
      max: pool.options.max
    },
    active_transactions: {
      count: activeTransactions.size,
      oldest_age_ms: activeTransactions.size
        ? Math.max(...[...activeTransactions].map((transaction) => now - transaction.startedAt))
        : 0
    },
    histograms: [...histograms.entries()].map(([key, series]) => {
      const [metric, process, outcome, queryClass] = key.split("|") as [
        HistogramMetric,
        ObservabilityProcess,
        DatabaseOutcome,
        DatabaseQueryClass
      ];
      const sorted = [...series.values].sort((left, right) => left - right);
      return {
        metric,
        labels: { process, outcome, query_class: queryClass },
        count: series.count,
        average_ms: series.count ? series.sum / series.count : 0,
        p95_ms: percentile(sorted, 0.95),
        p99_ms: percentile(sorted, 0.99),
        window_samples: sorted.length
      };
    }),
    realtime: {
      active_sse_connections: activeSseConnections,
      counters: [...counters.entries()].map(([key, value]) => {
        const [, component, event] = key.split("|") as [string, RealtimeComponent, RealtimeEvent];
        return { labels: { component, event }, value };
      })
    },
    reconcilers: RECONCILER_WORKFLOWS.map((workflow) => ({
      labels: { workflow },
      oldest_age_ms: reconcilerOldestAgeMs.get(workflow) ?? 0,
      counters: RECONCILER_EVENTS.map((event) => ({
        event,
        value: counters.get(`reconciler|${workflow}|${event}`) ?? 0
      }))
    }))
  };
}

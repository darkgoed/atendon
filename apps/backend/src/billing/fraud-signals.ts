import type { PoolClient } from "pg";

export type FraudSignalType = "PAYMENT_VELOCITY" | "DISTINCT_PAYER" | "REPEATED_CHARGEBACK";
export type FraudSignal = { signalType: FraudSignalType; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; score: number; observedCount: number; windowStartedAt: Date; sourceKey?: string; details?: Record<string, unknown> };

export async function recordFraudSignal(client: PoolClient, tenantId: string, signal: FraudSignal) {
  const r = await client.query(
    `INSERT INTO fraud_signals(tenant_id,signal_type,severity,score,observed_count,window_started_at,source_key,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, signal.signalType, signal.severity, signal.score, signal.observedCount, signal.windowStartedAt, signal.sourceKey ?? null, JSON.stringify(signal.details ?? {})],
  );
  return r.rows[0];
}

export async function queryFraudSignals(client: PoolClient, tenantId: string, limit = 100) {
  return (await client.query("SELECT * FROM fraud_signals WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2", [tenantId, Math.min(Math.max(limit, 1), 500)])).rows;
}

export async function detectPaymentVelocity(client: PoolClient, tenantId: string, windowMinutes = 10, threshold = 5) {
  const r = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM payments WHERE tenant_id=$1 AND created_at >= now()-($2::int * interval '1 minute')", [tenantId, windowMinutes]);
  const count = Number(r.rows[0]?.count ?? 0);
  if (count < threshold) return null;
  return recordFraudSignal(client, tenantId, { signalType: "PAYMENT_VELOCITY", severity: count >= threshold * 2 ? "HIGH" : "MEDIUM", score: Math.min(100, count * 10), observedCount: count, windowStartedAt: new Date(Date.now() - windowMinutes * 60_000), details: { windowMinutes, threshold } });
}

export async function recordDistinctPayerSignal(client: PoolClient, tenantId: string, distinctCount: number, details: Record<string, unknown> = {}) {
  return recordFraudSignal(client, tenantId, { signalType: "DISTINCT_PAYER", severity: distinctCount >= 5 ? "HIGH" : "MEDIUM", score: Math.min(100, distinctCount * 15), observedCount: distinctCount, windowStartedAt: new Date(), details });
}

export async function recordChargebackSignal(client: PoolClient, tenantId: string, repeatedCount: number, details: Record<string, unknown> = {}) {
  return recordFraudSignal(client, tenantId, { signalType: "REPEATED_CHARGEBACK", severity: repeatedCount >= 3 ? "CRITICAL" : "HIGH", score: Math.min(100, repeatedCount * 30), observedCount: repeatedCount, windowStartedAt: new Date(), details });
}

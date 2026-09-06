import type { PoolClient } from "pg";

export type LedgerEntry = {
  direction: "DEBIT" | "CREDIT";
  amountCents: number;
  actorType: string;
  actorId?: string | null;
  reason: string;
  sourceEventId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function appendFinancialLedgerEntry(client: PoolClient, tenantId: string, entry: LedgerEntry) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('financial_ledger:' || $1))", [tenantId]);
  const prior = await client.query<{ balance: string }>(
    "SELECT COALESCE((SELECT balance_after_cents FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1),0)::text AS balance FOR UPDATE",
    [tenantId],
  );
  const before = Number(prior.rows[0]?.balance ?? 0);
  const after = entry.direction === "CREDIT" ? before + entry.amountCents : before - entry.amountCents;
  if (after < 0) throw Object.assign(new Error("insufficient financial balance"), { code: "FINANCIAL_INSUFFICIENT_BALANCE" });
  const result = await client.query(
    `INSERT INTO financial_ledger (tenant_id,direction,amount_cents,balance_before_cents,balance_after_cents,actor_type,actor_id,reason,source_event_id,invoice_id,payment_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())
     ON CONFLICT (tenant_id,source_event_id,correlation_id) WHERE source_event_id IS NOT NULL AND correlation_id IS NOT NULL DO NOTHING RETURNING *`,
    [tenantId, entry.direction, entry.amountCents, before, after, entry.actorType, entry.actorId ?? null, entry.reason, entry.sourceEventId ?? null, entry.invoiceId ?? null, entry.paymentId ?? null, entry.correlationId ?? null, JSON.stringify(entry.metadata ?? {})],
  );
  return result.rows[0] ?? null;
}

export async function grantUsageCredit(client: PoolClient, input: { tenantId: string; usagePeriodId: string; amount: number; reason: string; idempotencyKey: string; grantedByUserId?: string | null; expiresAt?: Date | null }) {
  const result = await client.query(
    `INSERT INTO usage_grants(tenant_id,usage_period_id,amount,reason,idempotency_key,granted_by_user_id,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
    [input.tenantId, input.usagePeriodId, input.amount, input.reason, input.idempotencyKey, input.grantedByUserId ?? null, input.expiresAt ?? null],
  );
  if (!result.rows[0]) return null;
  await client.query("UPDATE usage_periods SET bonus_granted=bonus_granted+$2,updated_at=now() WHERE id=$1", [input.usagePeriodId, input.amount]);
  return result.rows[0];
}

export async function listFinancialLedger(client: PoolClient, tenantId: string, limit = 100) {
  return (await client.query("SELECT * FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2", [tenantId, Math.min(Math.max(limit, 1), 500)])).rows;
}

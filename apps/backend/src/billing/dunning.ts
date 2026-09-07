import { db } from "../db/client.js";
import { withTransaction } from "../db/transaction.js";
import { createChargeForInvoice, type ChargeDeps } from "./charges.js";

export type DunningPolicy = { maxAttempts: number; spacingHours: number; gracePeriodDays: number };
export type DunningResult = { attempted: number; succeeded: number; failed: number; exhausted: number; reactivated: number; errors: string[] };

function policy(): DunningPolicy {
  return {
    maxAttempts: Math.max(1, Number(process.env.DUNNING_MAX_ATTEMPTS ?? 3)),
    spacingHours: Math.max(0, Number(process.env.DUNNING_SPACING_HOURS ?? 24)),
    gracePeriodDays: Math.max(0, Number(process.env.DUNNING_GRACE_PERIOD_DAYS ?? 7)),
  };
}
const tx = withTransaction;

export async function runDunningBatch(limit = 100, chargeDeps: ChargeDeps = {}): Promise<DunningResult> {
  const result: DunningResult = { attempted: 0, succeeded: 0, failed: 0, exhausted: 0, reactivated: 0, errors: [] };
  const p = policy();
  const pool = chargeDeps.db ?? db;
  const candidates = await pool.query<{ id: string }>(`SELECT i.id FROM invoices i WHERE i.status IN ('open','pending') AND i.due_date IS NOT NULL AND i.due_date <= now() AND i.dunning_exhausted_at IS NULL AND NOT EXISTS (SELECT 1 FROM billing_dunning_attempts a WHERE a.invoice_id=i.id AND a.next_attempt_at IS NOT NULL AND a.next_attempt_at > now()) ORDER BY i.due_date, i.id LIMIT $1`, [limit]);
  for (const { id } of candidates.rows) {
    let claim: { tenantId: string; method: string; attempt: number } | null = null;
    try {
      claim = await tx(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dunning:${id}`]);
        const invoice = (await client.query<{ tenant_id: string; subscription_id: string | null }>(`SELECT tenant_id,subscription_id FROM invoices WHERE id=$1 AND status IN ('open','pending') AND due_date <= now() AND dunning_exhausted_at IS NULL FOR UPDATE`, [id])).rows[0];
        if (!invoice) return null;
        const previous = (await client.query<{ n: number }>("SELECT COALESCE(MAX(attempt_number),0)::int n FROM billing_dunning_attempts WHERE invoice_id=$1", [id])).rows[0].n;
        const attempt = previous + 1;
        if (attempt > p.maxAttempts) {
          await client.query("UPDATE invoices SET dunning_exhausted_at=now(), updated_at=now() WHERE id=$1", [id]);
          result.exhausted++;
          return null;
        }
        const method = (await client.query<{ method: string | null }>(`SELECT COALESCE(NULLIF(bp.commercial_config->>'defaultMethod',''), ba_provider.accepted_methods[1], 'pix') method FROM billing_accounts ba LEFT JOIN billing_providers ba_provider ON ba_provider.id=ba.provider_id LEFT JOIN billing_providers bp ON bp.id=ba.provider_id WHERE ba.tenant_id=$1 LIMIT 1`, [invoice.tenant_id])).rows[0]?.method ?? "pix";
        await client.query(`INSERT INTO billing_dunning_attempts(tenant_id,invoice_id,attempt_number,status,next_attempt_at) VALUES($1,$2,$3,'CLAIMED',now()+make_interval(hours=>$4))`, [invoice.tenant_id, id, attempt, p.spacingHours]);
        if (invoice.subscription_id) await client.query(`UPDATE tenant_subscriptions SET status=CASE WHEN status='ACTIVE' THEN 'PAST_DUE' WHEN status='PAST_DUE' THEN 'GRACE_PERIOD' ELSE status END, grace_period_ends_at=COALESCE(grace_period_ends_at,now()+make_interval(days=>$2)),updated_at=now() WHERE id=$1`, [invoice.subscription_id, p.gracePeriodDays]);
        return { tenantId: invoice.tenant_id, method, attempt };
      });
      if (!claim) continue;
      result.attempted++;
      try {
        const charge = await createChargeForInvoice(id, claim.method, chargeDeps);
        const status = charge.status.toLowerCase();
        if (["paid", "approved", "authorized"].includes(status)) {
          await pool.query("UPDATE billing_dunning_attempts SET status='SUCCEEDED',next_attempt_at=now()+make_interval(hours=>$3) WHERE invoice_id=$1 AND attempt_number=$2 AND status='CLAIMED'", [id, claim.attempt, p.spacingHours]);
          result.succeeded++;
        } else if (["pending", "in_process"].includes(status)) {
          await pool.query("UPDATE billing_dunning_attempts SET status='PENDING',next_attempt_at=now()+make_interval(hours=>$3) WHERE invoice_id=$1 AND attempt_number=$2 AND status='CLAIMED'", [id, claim.attempt, p.spacingHours]);
        } else {
          await pool.query("UPDATE billing_dunning_attempts SET status='FAILED',error_code=$3,next_attempt_at=now()+make_interval(hours=>$4) WHERE invoice_id=$1 AND attempt_number=$2 AND status='CLAIMED'", [id, claim.attempt, `provider:${status}`, p.spacingHours]);
          result.failed++;
        }
      } catch (error) {
        await pool.query(`UPDATE billing_dunning_attempts SET status='FAILED',error_code=$3,next_attempt_at=now()+make_interval(hours=>$4) WHERE invoice_id=$1 AND attempt_number=$2 AND status='CLAIMED'`, [id, claim.attempt, error instanceof Error ? error.message : "charge failed", p.spacingHours]);
        const count = Number((await pool.query<{ count: string }>("SELECT count(*) FROM billing_dunning_attempts WHERE invoice_id=$1 AND attempt_number >= $2", [id, p.maxAttempts])).rows[0].count);
        if (count > 0) { await pool.query("UPDATE invoices SET dunning_exhausted_at=now(),updated_at=now() WHERE id=$1", [id]); result.exhausted++; }
        result.failed++;
      }
    } catch (error) { result.errors.push(`invoice:${id}:${error instanceof Error ? error.message : "unknown"}`); }
  }
  const paid = await pool.query<{ tenant_id: string; subscription_id: string }>(`SELECT DISTINCT i.tenant_id,i.subscription_id FROM invoices i WHERE i.subscription_id IS NOT NULL AND i.status IN ('paid','PAID') AND NOT EXISTS (SELECT 1 FROM invoices open WHERE open.subscription_id=i.subscription_id AND open.status IN ('open','pending') AND open.due_date <= now()) LIMIT $1`, [limit]);
  for (const row of paid.rows) {
    const before = (await pool.query<{ tenant_id: string; status: string }>("SELECT tenant_id,status FROM tenant_subscriptions WHERE id=$1 AND status IN ('PAST_DUE','GRACE_PERIOD','SUSPENDED')", [row.subscription_id])).rows[0];
    const changed = before ? await pool.query("UPDATE tenant_subscriptions SET status='ACTIVE',grace_period_ends_at=NULL,suspended_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('PAST_DUE','GRACE_PERIOD','SUSPENDED')", [row.subscription_id]) : { rowCount: 0 };
    if (changed.rowCount) { await pool.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_status,to_status,metadata) VALUES($1,$2,'LIFECYCLE_STATUS_CHANGED',$3,'ACTIVE',$4)`, [before.tenant_id, row.subscription_id, before.status, { reason: "dunning_debt_paid" }]); result.reactivated++; }
  }
  return result;
}

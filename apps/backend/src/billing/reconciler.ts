import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { ensureOpenPeriod } from "./usage-period.js";
import { expireRollover } from "./rollover.js";
import { getBillingSettings } from "./settings.js";
import { reconcileAiTurnFromUsageLogs } from "./ai-consumption.js";
import { createInvoiceForUsagePeriod } from "./invoices.js";
import { createChargeForInvoice, type ChargeDeps } from "./charges.js";

export type BillingReconciliationResult = { periods: number; reconciled: number; expiredReservations: number; rolloverExpired: number; errors: string[] };

export async function runBillingReconciliationBatch(limit = 100, chargeDeps: ChargeDeps = {}): Promise<BillingReconciliationResult> {
  const result: BillingReconciliationResult = { periods: 0, reconciled: 0, expiredReservations: 0, rolloverExpired: 0, errors: [] };
  const tenants = await db.query<{ tenant_id: string }>(`
    SELECT tenant_id FROM (
      SELECT ts.tenant_id
      FROM usage_periods u
      JOIN tenant_subscriptions ts ON ts.tenant_id = u.tenant_id
      WHERE u.status = 'OPEN' AND u.end_at <= now()
      UNION
      SELECT ts.tenant_id
      FROM rollover_ledger l
      JOIN tenant_subscriptions ts ON ts.tenant_id = l.tenant_id
      WHERE l.expires_at <= now()
        AND l.generated_amount > l.consumed_amount + l.expired_amount
    ) candidates
    ORDER BY tenant_id
    LIMIT $1`, [limit]);
  for (const { tenant_id } of tenants.rows) {
    try {
      const closed = await withTenantTransaction(db, tenant_id, async (client) => {
        await client.query(`SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE`, [tenant_id]);
        const before = await client.query<{ id: string }>(`SELECT id FROM usage_periods WHERE tenant_id=$1 AND status IN ('CLOSED','INVOICED') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.metadata->>'usage_period_id'=usage_periods.id::text AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id AND p.external_id IS NOT NULL))`, [tenant_id]);
        await ensureOpenPeriod(client, tenant_id); result.periods++; result.rolloverExpired += await expireRollover(client, tenant_id); return before.rows.map(x => x.id);
      });
      for (const periodId of closed) {
        try {
          const invoice = await createInvoiceForUsagePeriod(db, tenant_id, periodId);
          await db.query("UPDATE invoices SET provider_id=(SELECT provider_id FROM billing_accounts WHERE tenant_id=$1 AND provider_id IS NOT NULL LIMIT 1) WHERE id=$2 AND provider_id IS NULL", [tenant_id, invoice.id]);
          const provider = await db.query<{ auto_charge: boolean | null; default_method: string | null; accepted_methods: string[] | null }>(
            `SELECT COALESCE((commercial_config->>'autoCharge')::boolean,false) auto_charge,
                    NULLIF(commercial_config->>'defaultMethod','') default_method,
                    accepted_methods
               FROM billing_providers
              WHERE id=COALESCE((SELECT provider_id FROM invoices WHERE id=$1),
                (SELECT id FROM billing_providers WHERE environment='production' AND status='CONNECTED' AND enabled=true LIMIT 1))
                AND environment='production' AND status='CONNECTED' AND enabled=true`, [invoice.id]);
          const p = provider.rows[0];
          const method = p?.default_method;
          if (p?.auto_charge === true && method && Array.isArray(p.accepted_methods) && p.accepted_methods.includes(method)) {
            try { await createChargeForInvoice(invoice.id, method, chargeDeps); }
            catch (error) { result.errors.push(`charge:${invoice.id}:${error instanceof Error && error.message === "Não foi possível criar a cobrança; tente novamente" ? error.message : "charge failed"}`); }
          }
        } catch (error) { result.errors.push(`invoice:${tenant_id}:${periodId}:${error instanceof Error ? error.message : "unknown"}`); }
      }
    } catch (error) { result.errors.push(`period:${tenant_id}:${error instanceof Error ? error.message : "unknown"}`); }
  }
  const ledgerRows = await db.query<{ tenant_id: string; logical_turn_id: string | null; purpose: "inbound_reply" | "follow_up"; id: string }>(`SELECT tenant_id, logical_turn_id, purpose, id FROM ai_usage_ledger WHERE reconciled=false ORDER BY created_at LIMIT $1`, [limit]);
  for (const row of ledgerRows.rows) {
    try {
      if (row.logical_turn_id) {
        const logs = await db.query(`SELECT 1 FROM usage_logs WHERE tenant_id=$1 AND request_id=$2::uuid LIMIT 1`, [row.tenant_id, row.logical_turn_id]);
        if (logs.rowCount) { await reconcileAiTurnFromUsageLogs(row.tenant_id, row.purpose, row.logical_turn_id); result.reconciled++; continue; }
      }
      await withTenantTransaction(db, row.tenant_id, async (client) => {
        const settings = await getBillingSettings(client);
        const expired = await client.query<{ id: string; usage_period_id: string; billable_amount_brl_cents: string }>(`SELECT id, usage_period_id, billable_amount_brl_cents FROM ai_usage_ledger WHERE id=$1 AND reconciled=false AND created_at <= now() - make_interval(mins => $2) FOR UPDATE`, [row.id, settings.reservation_ttl_minutes]);
        const item = expired.rows[0]; if (!item) return;
        await client.query(`UPDATE usage_periods SET reserved_cents=GREATEST(0,reserved_cents-$2), updated_at=now() WHERE id=$1`, [item.usage_period_id, item.billable_amount_brl_cents]);
        await client.query(`UPDATE ai_usage_ledger SET reconciled=true, reconciled_at=now(), pricing_snapshot=COALESCE(pricing_snapshot,'{}'::jsonb) || $2::jsonb WHERE id=$1 AND reconciled=false`, [item.id, JSON.stringify({ reconciliation: "expired_without_usage_logs" })]);
        result.expiredReservations++;
      });
    } catch (error) { result.errors.push(`ledger:${row.id}:${error instanceof Error ? error.message : "unknown"}`); }
  }
  return result;
}

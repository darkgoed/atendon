import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { ensureOpenPeriod } from "./usage-period.js";
import { expireRollover } from "./rollover.js";
import { getBillingSettings } from "./settings.js";
import { reconcileAiTurnFromUsageLogs } from "./ai-consumption.js";
import { createInvoiceForUsagePeriod } from "./invoices.js";
import { createChargeForInvoice, type ChargeDeps } from "./charges.js";
import { CHARGEABLE_SUBSCRIPTION_STATUSES } from "./types.js";

export type SubscriptionLifecycleResult = { suspended: number; errors: string[] };

/** Suspende apenas inadimplência cuja carência já venceu; nunca reativa nem corta ACTIVE em dia. */
export async function runSubscriptionLifecycleBatch(limit = 100): Promise<SubscriptionLifecycleResult> {
  const result: SubscriptionLifecycleResult = { suspended: 0, errors: [] };
  const candidates = await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_subscriptions WHERE (status IN ('PAST_DUE','GRACE_PERIOD') AND grace_period_ends_at IS NOT NULL AND grace_period_ends_at <= now()) OR (status='TRIALING' AND trial_ends_at IS NOT NULL AND trial_ends_at <= now()) ORDER BY tenant_id LIMIT $1`, [limit]);
  for (const { tenant_id } of candidates.rows) {
    try {
      await withTenantTransaction(db, tenant_id, async (client) => {
        const locked = await client.query<{ id: string; status: string; paid: boolean }>(`SELECT s.id,s.status,EXISTS (SELECT 1 FROM invoices i JOIN payments p ON p.invoice_id=i.id WHERE i.subscription_id=s.id AND i.status IN ('paid','PAID') AND p.status IN ('paid','PAID')) AS paid FROM tenant_subscriptions s WHERE s.tenant_id=$1 AND ((s.status IN ('PAST_DUE','GRACE_PERIOD') AND s.grace_period_ends_at IS NOT NULL AND s.grace_period_ends_at <= now()) OR (s.status='TRIALING' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now())) FOR UPDATE`, [tenant_id]);
        for (const sub of locked.rows) {
          if (sub.status === 'TRIALING' && sub.paid) {
            await client.query(`UPDATE tenant_subscriptions SET status='ACTIVE',grace_period_ends_at=NULL,updated_at=now() WHERE id=$1 AND status='TRIALING'`, [sub.id]);
            await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_status,to_status,metadata) VALUES($1,$2,'LIFECYCLE_STATUS_CHANGED','TRIALING','ACTIVE',$3)`, [tenant_id, sub.id, { reason: "trial_converted_paid" }]);
            continue;
          }
          if (sub.status === 'TRIALING') {
            await client.query(`UPDATE tenant_subscriptions SET status='PAST_DUE',grace_period_ends_at=now() + (COALESCE((SELECT grace_period_days FROM plans WHERE id=tenant_subscriptions.plan_id),7) * interval '1 day'),updated_at=now() WHERE id=$1 AND status='TRIALING'`, [sub.id]);
            await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_status,to_status,metadata) VALUES($1,$2,'LIFECYCLE_STATUS_CHANGED','TRIALING','PAST_DUE',$3)`, [tenant_id, sub.id, { reason: "trial_expired" }]);
            continue;
          }
          await client.query(`UPDATE tenant_subscriptions SET status='SUSPENDED', suspended_at=now(), updated_at=now() WHERE id=$1`, [sub.id]);
          await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_status,to_status,metadata) VALUES($1,$2,'LIFECYCLE_STATUS_CHANGED',$3,'SUSPENDED',$4)`, [tenant_id, sub.id, sub.status, { reason: "grace_period_expired" }]);
          result.suspended++;
        }
      });
    } catch (error) { result.errors.push(`subscription:${tenant_id}:${error instanceof Error ? error.message : "unknown"}`); }
  }
  return result;
}

export type BillingReconciliationResult = { periods: number; reconciled: number; expiredReservations: number; rolloverExpired: number; errors: string[] };

export async function runBillingReconciliationBatch(limit = 100, chargeDeps: ChargeDeps = {}): Promise<BillingReconciliationResult> {
  const result: BillingReconciliationResult = { periods: 0, reconciled: 0, expiredReservations: 0, rolloverExpired: 0, errors: [] };
  const tenants = await db.query<{ tenant_id: string }>(`
    SELECT tenant_id FROM (
      SELECT ts.tenant_id
      FROM usage_periods u
      JOIN tenant_subscriptions ts ON ts.tenant_id = u.tenant_id
      WHERE u.status = 'OPEN' AND u.end_at <= now() AND ts.status = ANY($1)
      UNION
      SELECT ts.tenant_id
      FROM rollover_ledger l
      JOIN tenant_subscriptions ts ON ts.tenant_id = l.tenant_id
      WHERE l.expires_at <= now()
        AND l.generated_amount > l.consumed_amount + l.expired_amount
        AND ts.status = ANY($1)
    ) candidates
    ORDER BY tenant_id
    LIMIT $2`, [CHARGEABLE_SUBSCRIPTION_STATUSES, limit]);
  for (const { tenant_id } of tenants.rows) {
    try {
      const closed = await withTenantTransaction(db, tenant_id, async (client) => {
        await client.query(`SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE`, [tenant_id]);
        // ensureOpenPeriod PRIMEIRO: é ele quem fecha o período vencido. Lendo a
        // lista antes, o período recém-fechado nunca aparecia — e no ciclo seguinte
        // o tenant já não era candidato, então a fatura de renovação nunca nascia.
        await ensureOpenPeriod(client, tenant_id); result.periods++; result.rolloverExpired += await expireRollover(client, tenant_id);
        const pending = await client.query<{ id: string }>(`SELECT id FROM usage_periods WHERE tenant_id=$1 AND status IN ('CLOSED','INVOICED') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.metadata->>'usage_period_id'=usage_periods.id::text AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id AND p.external_id IS NOT NULL))`, [tenant_id]);
        return pending.rows.map(x => x.id);
      });
      for (const periodId of closed) {
        try {
          const invoice = await createInvoiceForUsagePeriod(db, tenant_id, periodId);
          // Período sem valor a cobrar não gera fatura; nada a faturar aqui.
          if (!invoice) continue;
          await db.query("UPDATE invoices SET provider_id=(SELECT provider_id FROM billing_accounts WHERE tenant_id=$1 AND provider_id IS NOT NULL LIMIT 1) WHERE id=$2 AND provider_id IS NULL", [tenant_id, invoice.id]);
          const provider = await db.query<{ auto_charge: boolean | null; default_method: string | null; accepted_methods: string[] | null }>(
            `SELECT COALESCE((commercial_config->>'autoCharge')::boolean,false) auto_charge,
                    NULLIF(commercial_config->>'defaultMethod','') default_method,
                    accepted_methods
               FROM billing_providers
              WHERE id=COALESCE((SELECT provider_id FROM invoices WHERE id=$1),
                (SELECT id FROM billing_providers WHERE environment='production' AND status='CONNECTED' AND enabled=true AND credentials_encrypted IS NOT NULL ORDER BY connected_at NULLS LAST,code,id LIMIT 1))
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

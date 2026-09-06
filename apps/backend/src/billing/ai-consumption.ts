import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { buildAiTurnIdempotencyKey } from "./ai-metering.js";
import { ensureOpenPeriod } from "./usage-period.js";
import { estimateInteractionCents, getActivePricingRule, priceInteraction, type AiCostInput } from "./pricing.js";
import { evaluateAlerts } from "./alerts.js";
import { appendFinancialLedgerEntry, grantUsageCredit } from "./ledger.js";
import { detectPaymentVelocity } from "./fraud-signals.js";

type AiPurpose = "inbound_reply" | "follow_up";
export type ConsumeResult = {
  allowed: boolean;
  reason?: "AI_DISABLED" | "QUOTA_EXCEEDED" | "CREDIT_CAP_REACHED" | "BILLING_UNAVAILABLE";
  consumptionType?: "INCLUDED" | "ROLLOVER" | "BONUS" | "OVERAGE";
  ledgerId?: string;
  usagePeriodId?: string;
  estimatedCents?: number;
};

const n = (value: unknown): number => Number(value ?? 0);

export async function consumeAiInteraction(
  tenantId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
  metadata?: Record<string, unknown>,
): Promise<ConsumeResult> {
  try {
    return await withTenantTransaction(db, tenantId, async (client) => {
      const subscription = await client.query<{ id: string; plan_id: string; ai_enabled: boolean }>(
        `SELECT ts.id, ts.plan_id, COALESCE(p.ai_enabled, true) AS ai_enabled
           FROM tenant_subscriptions ts JOIN plans p ON p.id=ts.plan_id
          WHERE ts.tenant_id=$1 FOR UPDATE`, [tenantId],
      );
      const sub = subscription.rows[0];
      if (!sub) return { allowed: true };
      if (!sub.ai_enabled) return { allowed: false, reason: "AI_DISABLED" };

      const period = await ensureOpenPeriod(client, tenantId);
      if (!period) return { allowed: true };
      // Serialize reservations on the period row; the subscription lock alone does
      // not protect a period created/read by concurrent transactions.
      //
      // Relê os acumuladores DEPOIS do lock: `period` foi carregado por
      // ensureOpenPeriod antes de a linha ser travada, então usar os valores
      // dele para decidir o teto deixaria N transações concorrentes lendo o
      // mesmo saldo antigo e todas aprovarem a reserva (estouro do hard cap).
      const locked = await client.query<{ overage_amount_brl_cents: string; reserved_cents: string; included_usage: string }>(
        "SELECT overage_amount_brl_cents, reserved_cents, included_usage FROM usage_periods WHERE id=$1 FOR UPDATE",
        [period.id]
      );
      const current = locked.rows[0] ?? period;
      const interactionKey = buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId);
      const existing = await client.query<{ id: string; usage_period_id: string; consumption_type: ConsumeResult["consumptionType"] }>(
        `SELECT id, usage_period_id, consumption_type FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2`, [tenantId, interactionKey],
      );
      if (existing.rows[0]) return { allowed: true, consumptionType: existing.rows[0].consumption_type, ledgerId: existing.rows[0].id, usagePeriodId: existing.rows[0].usage_period_id };

      let type: ConsumeResult["consumptionType"];
      let sourceId: string | undefined;
      const rollover = await client.query<{ id: string; available: string }>(
        `SELECT id, (generated_amount-consumed_amount-expired_amount) AS available
           FROM rollover_ledger WHERE tenant_id=$1 AND expires_at > now() AND generated_amount-consumed_amount-expired_amount > 0
          ORDER BY expires_at ASC LIMIT 1 FOR UPDATE`, [tenantId],
      );
      if (rollover.rows[0]) { type = "ROLLOVER"; sourceId = rollover.rows[0].id; }
      else {
        const bonus = await client.query<{ id: string; available: string }>(
          `SELECT id, (amount-consumed_amount) AS available FROM usage_grants
            WHERE tenant_id=$1 AND kind='BONUS' AND (expires_at IS NULL OR expires_at > now()) AND amount-consumed_amount > 0
            ORDER BY expires_at ASC NULLS LAST, created_at ASC LIMIT 1 FOR UPDATE`, [tenantId],
        );
        if (bonus.rows[0]) { type = "BONUS"; sourceId = bonus.rows[0].id; }
        else if (period.included_limit === null || n(period.included_limit) > n(current.included_usage)) type = "INCLUDED";
        else type = undefined;
      }

      let estimatedCents = 0;
      if (!type) {
        const settings = await client.query<{ enabled: boolean; limit_type: string; monthly_spending_limit_cents: string | null; confirmed_unlimited_at: Date | null }>(
          `SELECT enabled, limit_type, monthly_spending_limit_cents, confirmed_unlimited_at FROM tenant_usage_credit_settings WHERE tenant_id=$1`, [tenantId],
        );
        const credit = settings.rows[0];
        if (!credit?.enabled) return { allowed: false, reason: "QUOTA_EXCEEDED" };
        if (credit.limit_type === "FIXED") {
          estimatedCents = await estimateInteractionCents(tenantId, client);
          if (n(current.overage_amount_brl_cents) + n(current.reserved_cents) + estimatedCents > n(credit.monthly_spending_limit_cents)) return { allowed: false, reason: "CREDIT_CAP_REACHED" };
        } else if (credit.limit_type !== "UNLIMITED" || !credit.confirmed_unlimited_at) return { allowed: false, reason: "QUOTA_EXCEEDED" };
        type = "OVERAGE";
      }

      const rule = await getActivePricingRule(client);
      const ledger = await client.query<{ id: string }>(
        `INSERT INTO ai_usage_ledger (tenant_id, subscription_id, usage_period_id, interaction_key, logical_turn_id, purpose, consumption_type, billable_amount_brl_cents, pricing_strategy, pricing_snapshot, reconciled)
         VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [tenantId, sub.id, period.id, interactionKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalTurnId) ? logicalTurnId : null, purpose, type, type === "OVERAGE" ? estimatedCents : 0, rule.strategy, JSON.stringify({ ...rule.config, version: rule.version, metadata }), false],
      );
      const column = type === "INCLUDED" ? "included_usage" : type === "ROLLOVER" ? "rollover_usage" : type === "BONUS" ? "bonus_usage" : "overage_usage";
      await client.query(`UPDATE usage_periods SET ${column}=${column}+1, reserved_cents=reserved_cents+$2, updated_at=now() WHERE id=$1`, [period.id, type === "OVERAGE" ? estimatedCents : 0]);
      if (type === "OVERAGE" && estimatedCents > 0) {
        await appendFinancialLedgerEntry(client, tenantId, {
          direction: "CREDIT",
          amountCents: estimatedCents,
          actorType: "AI_RESERVATION",
          reason: "AI usage reservation",
          sourceEventId: interactionKey,
          correlationId: period.id,
          metadata: { purpose, logicalTurnId, consumptionType: type },
        });
        await detectPaymentVelocity(client, tenantId);
      }
      if (type === "ROLLOVER") await client.query("UPDATE rollover_ledger SET consumed_amount=consumed_amount+1 WHERE id=$1", [sourceId]);
      if (type === "BONUS") await client.query("UPDATE usage_grants SET consumed_amount=consumed_amount+1 WHERE id=$1", [sourceId]);
      await client.query("SAVEPOINT billing_alerts");
      try { await evaluateAlerts(client, tenantId); await client.query("RELEASE SAVEPOINT billing_alerts"); }
      catch (error) { await client.query("ROLLBACK TO SAVEPOINT billing_alerts"); console.error(`[billing] alert evaluation failed for tenant ${tenantId}`, error); }
      return { allowed: true, consumptionType: type, ledgerId: ledger.rows[0].id, usagePeriodId: period.id, ...(type === "OVERAGE" ? { estimatedCents } : {}) };
    });
  } catch (error) {
    // Never expose provider/SQL details: they may contain credentials or query data.
    const operationalCode = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code).slice(0, 32)
      : "unknown";
    console.error(`[billing] AI reservation unavailable tenant=${tenantId} error_code=${operationalCode}`);
    // The transaction rolls back on error, so no durable reservation exists.
    // A subscribed tenant must not receive free AI when accounting is unhealthy.
    return { allowed: false, reason: "BILLING_UNAVAILABLE" };
  }
}

export async function grantAiUsageBonus(input: { tenantId: string; amount: number; reason: string; idempotencyKey: string; grantedByUserId?: string | null; expiresAt?: Date | null }) {
  return withTenantTransaction(db, input.tenantId, async (client) => {
    const period = await ensureOpenPeriod(client, input.tenantId);
    if (!period) return null;
    const grant = await grantUsageCredit(client, { ...input, usagePeriodId: period.id });
    if (grant) {
      await appendFinancialLedgerEntry(client, input.tenantId, {
        direction: "CREDIT",
        amountCents: input.amount,
        actorType: "BONUS_GRANT",
        actorId: input.grantedByUserId,
        reason: input.reason,
        sourceEventId: input.idempotencyKey,
        correlationId: period.id,
        metadata: { usageGrantId: grant.id },
      });
    }
    return grant;
  });
}

export async function reconcileAiInteraction(tenantId: string, purpose: AiPurpose, logicalTurnId: string, actual: AiCostInput): Promise<void> {
  try {
    await withTenantTransaction(db, tenantId, async (client) => {
      await client.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      const key = buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId);
      const priced = await priceInteraction(actual, client);
      const updated = await client.query<{ id: string; usage_period_id: string; consumption_type: string; reserved: string }>(
        // A reserva estimada tem de ser lida ANTES do UPDATE: em Postgres, RETURNING
        // devolve os valores NOVOS da linha, entao `billable_amount_brl_cents` no
        // RETURNING seria o valor REAL recem-gravado, nao a reserva. Subtrair esse
        // valor de reserved_cents liberaria a quantia errada e o spending cap
        // (§17) passaria a derivar. A CTE `before` guarda o valor anterior.
        `WITH before AS (
           SELECT id, billable_amount_brl_cents AS reserved
             FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2 AND reconciled=false
         ), upd AS (
           UPDATE ai_usage_ledger l SET model=$3,input_tokens=$4,output_tokens=$5,cached_tokens=$6,input_price_per_million_micros=$7,output_price_per_million_micros=$8,provider_cost_usd_micros=$9,provider_cost_brl_cents=$10,billable_amount_brl_cents=$11,pricing_strategy=$12,pricing_snapshot=$13,usd_brl_rate_micros=$14,reconciled=true,reconciled_at=now()
             FROM before b WHERE l.id=b.id
             RETURNING l.id, l.usage_period_id, l.consumption_type
         )
         SELECT upd.id, upd.usage_period_id, upd.consumption_type, before.reserved
           FROM upd JOIN before ON before.id=upd.id`,
        [tenantId, key, actual.model, actual.inputTokens, actual.outputTokens, actual.cachedTokens, priced.inputPricePerMillionMicros, priced.outputPricePerMillionMicros, priced.providerCostUsdMicros, priced.providerCostBrlCents, priced.billableAmountBrlCents, priced.pricingStrategy, JSON.stringify(priced.pricingSnapshot), priced.usdBrlRateMicros],
      );
      if (!updated.rows[0]) return;
      const row = updated.rows[0];
      await client.query(
        `UPDATE usage_periods SET provider_cost_usd_micros=provider_cost_usd_micros+$2,
          overage_amount_brl_cents=CASE WHEN $3='OVERAGE' THEN overage_amount_brl_cents+$4 ELSE overage_amount_brl_cents END,
          reserved_cents=CASE WHEN $3='OVERAGE' THEN GREATEST(0,reserved_cents-$5) ELSE reserved_cents END, updated_at=now() WHERE id=$1`,
        [row.usage_period_id, priced.providerCostUsdMicros, row.consumption_type, priced.billableAmountBrlCents, n(row.reserved)],
      );
      await client.query("SAVEPOINT billing_alerts");
      try { await evaluateAlerts(client, tenantId); await client.query("RELEASE SAVEPOINT billing_alerts"); }
      catch (error) { await client.query("ROLLBACK TO SAVEPOINT billing_alerts"); console.error(`[billing] alert evaluation failed for tenant ${tenantId}`, error); }
    });
  } catch (error) { console.error(`[billing] failed to reconcile AI interaction for tenant ${tenantId}`, error); }
}


export async function reconcileAiTurnFromUsageLogs(
  tenantId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalTurnId)) return;
  try {
    const result = await db.query<{ model: string | null; input_tokens: string; output_tokens: string; cached_input_tokens: string; cost_usd: string }>(
      `SELECT (SELECT ul.ai_model FROM usage_logs ul WHERE ul.tenant_id=$1 AND ul.request_id=$2::uuid ORDER BY ul.cost_usd DESC NULLS LAST, ul.created_at DESC LIMIT 1) AS model,
         COALESCE(SUM(input_tokens), 0)::text AS input_tokens, COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
         COALESCE(SUM(cached_input_tokens), 0)::text AS cached_input_tokens, COALESCE(SUM(cost_usd), 0)::text AS cost_usd
       FROM usage_logs WHERE tenant_id=$1 AND request_id=$2::uuid`, [tenantId, logicalTurnId]);
    const row = result.rows[0];
    if (!row || (Number(row.input_tokens) === 0 && Number(row.output_tokens) === 0 && Number(row.cached_input_tokens) === 0 && Number(row.cost_usd) === 0 && row.model === null)) return;
    await reconcileAiInteraction(tenantId, purpose, logicalTurnId, { model: row.model, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), cachedTokens: Number(row.cached_input_tokens), providerCostUsd: Number(row.cost_usd) });
  } catch (error) { console.error(`[billing] failed to reconcile AI turn from usage logs for tenant ${tenantId}`, error); }
}

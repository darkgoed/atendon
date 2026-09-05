import { db } from "../db/client.js";

export type RootBillingMetricsFilters = {
  tenantId?: string;
  planId?: string;
  start?: Date | string;
  end?: Date | string;
};

export type RootBillingMetric = {
  tenantId: string;
  planId: string | null;
  month: string;
  includedGranted: number;
  includedUsed: number;
  rolloverGenerated: number;
  rolloverUsed: number;
  rolloverExpired: number;
  bonusGranted: number;
  bonusUsed: number;
  overageInteractions: number;
  overageRevenueCents: number;
  providerCostUsdMicros: number;
  providerCostBrlCents: number;
};

type MetricRow = Omit<RootBillingMetric, "includedGranted" | "includedUsed" | "rolloverGenerated" | "rolloverUsed" | "rolloverExpired" | "bonusGranted" | "bonusUsed" | "overageInteractions" | "overageRevenueCents" | "providerCostUsdMicros" | "providerCostBrlCents"> & Record<string, string | number | null>;

/** Returns one SQL-aggregated row per tenant, plan, and calendar month. */
export async function getRootBillingMetrics(filters: RootBillingMetricsFilters = {}): Promise<RootBillingMetric[]> {
  const values: unknown[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const predicates: string[] = [];
  if (filters.tenantId) predicates.push(`p.tenant_id = ${param(filters.tenantId)}::uuid`);
  if (filters.planId) predicates.push(`s.plan_id = ${param(filters.planId)}::uuid`);
  if (filters.start) predicates.push(`p.start_at >= ${param(filters.start)}::timestamptz`);
  if (filters.end) predicates.push(`p.start_at < ${param(filters.end)}::timestamptz`);
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";

  const result = await db.query<MetricRow>(
    `WITH period_base AS (
       SELECT p.id, p.tenant_id, s.plan_id, date_trunc('month', p.start_at) AS month,
              p.included_limit, p.included_usage, p.bonus_granted, p.bonus_usage
       FROM usage_periods p
       LEFT JOIN tenant_subscriptions s ON s.id = p.subscription_id
       ${where}
     ), ledger_by_period AS (
       SELECT usage_period_id,
              COUNT(*) FILTER (WHERE consumption_type = 'OVERAGE') AS overage_interactions,
              COALESCE(SUM(billable_amount_brl_cents) FILTER (WHERE consumption_type = 'OVERAGE'), 0) AS overage_revenue_cents,
              COALESCE(SUM(provider_cost_usd_micros) FILTER (WHERE reconciled), 0) AS provider_cost_usd_micros,
              COALESCE(SUM(provider_cost_brl_cents) FILTER (WHERE reconciled), 0) AS provider_cost_brl_cents
       FROM ai_usage_ledger GROUP BY usage_period_id
     ), rollover_by_period AS (
       SELECT usage_period_id, COALESCE(SUM(generated_amount),0) AS rollover_generated,
              COALESCE(SUM(consumed_amount),0) AS rollover_used, COALESCE(SUM(expired_amount),0) AS rollover_expired
       FROM rollover_ledger GROUP BY usage_period_id
     )
     SELECT b.tenant_id AS "tenantId", b.plan_id AS "planId", to_char(b.month, 'YYYY-MM') AS month,
            COALESCE(SUM(b.included_limit),0) AS "includedGranted",
            COALESCE(SUM(b.included_usage),0) AS "includedUsed",
            COALESCE(SUM(r.rollover_generated),0) AS "rolloverGenerated",
            COALESCE(SUM(r.rollover_used),0) AS "rolloverUsed",
            COALESCE(SUM(r.rollover_expired),0) AS "rolloverExpired",
            COALESCE(SUM(b.bonus_granted),0) AS "bonusGranted",
            COALESCE(SUM(b.bonus_usage),0) AS "bonusUsed",
            COALESCE(SUM(l.overage_interactions),0) AS "overageInteractions",
            COALESCE(SUM(l.overage_revenue_cents),0) AS "overageRevenueCents",
            COALESCE(SUM(l.provider_cost_usd_micros),0) AS "providerCostUsdMicros",
            COALESCE(SUM(l.provider_cost_brl_cents),0) AS "providerCostBrlCents"
     FROM period_base b
     LEFT JOIN ledger_by_period l ON l.usage_period_id = b.id
     LEFT JOIN rollover_by_period r ON r.usage_period_id = b.id
     GROUP BY b.tenant_id, b.plan_id, b.month
     ORDER BY b.tenant_id, b.plan_id, b.month`, values
  );

  return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (["tenantId", "planId", "month"].includes(key)) return [key, value];
    return [key, Number(value ?? 0)];
  })) as RootBillingMetric);
}

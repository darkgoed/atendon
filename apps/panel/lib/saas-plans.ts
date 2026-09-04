export type PlanFeatureRow = { feature_key: string; enabled: boolean };
export type PlanLimitRow = { limit_key: string; limit_value: string | null };
export type Plan = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  monthly_price_cents: string | number;
  setup_price_cents?: string | number;
  billing_period_months?: number;
  trial_days?: number;
  grace_period_days?: number;
  status: string;
  is_internal: boolean;
  features: PlanFeatureRow[];
  limits: PlanLimitRow[];
};
export type FeatureCatalogItem = { feature_key: string; label: string; category: string; is_future: boolean };
export type LimitCatalogItem = { limit_key: string; label: string; unit: string; period: string; is_enforced: boolean };
export type Catalog = { feature_catalog: FeatureCatalogItem[]; limit_catalog: LimitCatalogItem[] };

export function normalizePlan(plan: Plan) {
  return {
    ...plan,
    monthlyPriceCents: Number(plan.monthly_price_cents),
    setupPriceCents: Number(plan.setup_price_cents ?? 0),
    billingPeriodMonths: plan.billing_period_months ?? 1,
    trialDays: plan.trial_days ?? 0,
    gracePeriodDays: plan.grace_period_days ?? 0,
    description: plan.description ?? "",
    features: Object.fromEntries(plan.features.map((item) => [item.feature_key, item.enabled])),
    limits: Object.fromEntries(plan.limits.map((item) => [item.limit_key, item.limit_value === null ? null : Number(item.limit_value)])),
  };
}

export type UsageMetric = { used: number; limit: number | null };
export function formatUsage(metric: UsageMetric): string {
  return `${metric.used} / ${metric.limit === null ? "Ilimitado" : metric.limit}`;
}

export function reaisToCents(value: string | number) {
  return Math.round(Number(value) * 100);
}

export function duplicatePlanPayload(code: string, name: string) {
  const trimmedCode = code.trim();
  const trimmedName = name.trim();
  return trimmedName ? { code: trimmedCode, name: trimmedName } : { code: trimmedCode };
}

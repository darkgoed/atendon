import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { getBillingSettings } from "./settings.js";

export type AiCostInput = { model: string | null; inputTokens: number; outputTokens: number; cachedTokens: number; providerCostUsd?: number | null };
export type PricedInteraction = {
  providerCostUsdMicros: number; providerCostBrlCents: number; billableAmountBrlCents: number;
  pricingStrategy: string; pricingSnapshot: Record<string, unknown>; usdBrlRateMicros: number;
  inputPricePerMillionMicros: number | null; outputPricePerMillionMicros: number | null;
};
type PricingRule = { id: string; version: number; strategy: string; markup_bps: number | null; fixed_price_per_interaction_cents: number | null; config: Record<string, unknown>; active: boolean; created_by_user_id: string | null; created_at: Date };
let ruleCache: { value: PricingRule; expiresAt: number } | undefined;
const TTL_MS = 30_000;
export function invalidateActivePricingRuleCache(): void { ruleCache = undefined; }
export { invalidateActivePricingRuleCache as invalidatePricingRuleCache };

export async function getActivePricingRule(client?: PoolClient): Promise<PricingRule> {
  if (ruleCache && ruleCache.expiresAt > Date.now()) return ruleCache.value;
  const result = await (client ?? db).query("SELECT * FROM ai_pricing_rules WHERE active = true LIMIT 1");
  if (!result.rows[0]) {
    return { id: "fallback", version: 0, strategy: "COST_PLUS_MARKUP", markup_bps: 0, fixed_price_per_interaction_cents: null, config: { fallback: "no_active_rule" }, active: false, created_by_user_id: null, created_at: new Date(0) };
  }
  const row = result.rows[0] as Record<string, unknown>;
  const value: PricingRule = { id: String(row.id), version: Number(row.version), strategy: String(row.strategy), markup_bps: row.markup_bps == null ? null : Number(row.markup_bps), fixed_price_per_interaction_cents: row.fixed_price_per_interaction_cents == null ? null : Number(row.fixed_price_per_interaction_cents), config: (row.config ?? {}) as Record<string, unknown>, active: Boolean(row.active), created_by_user_id: row.created_by_user_id as string | null, created_at: row.created_at as Date };
  ruleCache = { value, expiresAt: Date.now() + TTL_MS }; return value;
}

export async function priceInteraction(input: AiCostInput, client?: PoolClient): Promise<PricedInteraction> {
  const connection = client ?? db;
  const settings = await getBillingSettings(client);
  const rule = await getActivePricingRule(client);
  let inputPrice: number | null = null, outputPrice: number | null = null, cachedPrice: number | null = null;
  let providerMicros: number;
  const snapshot: Record<string, unknown> = {
    version: rule.version,
    strategy: rule.strategy,
    markupBps: rule.markup_bps,
    fixedPricePerInteractionCents: rule.fixed_price_per_interaction_cents,
    usdBrlRateMicros: settings.usd_brl_rate_micros,
    fallback: rule.config.fallback,
  };
  if (input.providerCostUsd != null) providerMicros = Math.max(0, Math.round(input.providerCostUsd * 1_000_000));
  else {
    const prices = input.model ? await connection.query("SELECT input_price_per_million_micros, output_price_per_million_micros, cached_input_price_per_million_micros FROM ai_model_prices WHERE model=$1 AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now()) ORDER BY effective_from DESC LIMIT 1", [input.model]) : { rows: [] };
    if (!prices.rows[0]) { providerMicros = 0; snapshot.fallback = "unknown_model"; }
    else { inputPrice = Number(prices.rows[0].input_price_per_million_micros); outputPrice = Number(prices.rows[0].output_price_per_million_micros); cachedPrice = prices.rows[0].cached_input_price_per_million_micros == null ? null : Number(prices.rows[0].cached_input_price_per_million_micros); providerMicros = Math.max(0, Math.round(((Math.max(0, input.inputTokens - input.cachedTokens) * inputPrice) + (Math.max(0, input.cachedTokens) * (cachedPrice ?? inputPrice)) + (Math.max(0, input.outputTokens) * outputPrice)) / 1_000_000)); }
  }
  snapshot.inputPricePerMillionMicros = inputPrice; snapshot.outputPricePerMillionMicros = outputPrice; snapshot.cachedInputPricePerMillionMicros = cachedPrice;
  const providerBrlCents = Math.max(0, Math.ceil(providerMicros * settings.usd_brl_rate_micros / 10_000_000_000));
  let billable = providerBrlCents;
  if (rule.strategy === "COST_PLUS_MARKUP") billable = Math.ceil(providerBrlCents * (10_000 + (rule.markup_bps ?? 0)) / 10_000);
  else if (rule.strategy === "FIXED_PER_INTERACTION") billable = Math.max(0, rule.fixed_price_per_interaction_cents ?? 0);
  else { snapshot.customFallback = true; billable = Math.ceil(providerBrlCents * (10_000 + (rule.markup_bps ?? 0)) / 10_000); }
  return { providerCostUsdMicros: providerMicros, providerCostBrlCents: providerBrlCents, billableAmountBrlCents: Math.max(0, Math.ceil(billable)), pricingStrategy: rule.strategy, pricingSnapshot: snapshot, usdBrlRateMicros: settings.usd_brl_rate_micros, inputPricePerMillionMicros: inputPrice, outputPricePerMillionMicros: outputPrice };
}

export async function estimateInteractionCents(tenantId: string, client?: PoolClient): Promise<number> {
  const settings = await getBillingSettings(client);
  const result = await (client ?? db).query("SELECT AVG(billable_amount_brl_cents) AS average, COUNT(*) AS count FROM (SELECT billable_amount_brl_cents FROM ai_usage_ledger WHERE tenant_id = $1 AND billable_amount_brl_cents > 0 ORDER BY created_at DESC LIMIT 20) recent", [tenantId]);
  const average = Number(result.rows[0]?.average ?? 0);
  return Math.max(1, average > 0 && Number(result.rows[0]?.count ?? 0) >= 3 ? Math.ceil(average) : settings.min_overage_estimate_cents);
}

import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { getBillingSettings } from "./settings.js";

/** provider: provedor REAL que atendeu a chamada (ex.: OpenRouter `provider`); null = desconhecido → preço genérico do modelo. */
export type AiCostInput = { model: string | null; provider?: string | null; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number; providerCostUsd?: number | null };
export type PricedInteraction = {
  providerCostUsdMicros: number; providerCostBrlCents: number; billableAmountBrlCents: number;
  pricingStrategy: string; pricingSnapshot: Record<string, unknown>; usdBrlRateMicros: number;
  inputPricePerMillionMicros: number | null; outputPricePerMillionMicros: number | null;
  /** Tokens normalizados: custo do provedor reescalonado para o preço de referência. */
  normalizedCredits: number; creditReferencePricePerMillionMicros: number;
};
type PricingRule = { id: string; version: number; strategy: string; markup_bps: number | null; fixed_price_per_interaction_cents: number | null; config: Record<string, unknown>; active: boolean; created_by_user_id: string | null; created_at: Date };
let ruleCache: { value: PricingRule; expiresAt: number } | undefined;
const TTL_MS = 30_000;
/** Nome canônico do provider (mesma regra do CHECK da 0194): lower(trim), vazio = null. */
export function normalizeAiProvider(provider: string | null | undefined): string | null {
  const value = provider?.trim().toLowerCase();
  return value ? value : null;
}
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

// Preço de referência de 1 crédito: um token ao preço de input de referência.
// $0.60/M = 600000 micros — âncora do pacote extra de 50M tokens por R$157
// (≈ $0.59/M a ~5.3 BRL/USD). Ajustável por regra ativa (config JSON).
export const DEFAULT_CREDIT_REFERENCE_PRICE_PER_MILLION_MICROS = 600_000;
// Reserva conservadora por turno enquanto o modelo real ainda não é conhecido
// (chamadores reservam antes do provedor). Configurável pela regra ativa.
export const DEFAULT_TURN_RESERVATION_CREDITS = 25_000;

const positiveNumber = (raw: unknown): number | null => {
  const parsed = typeof raw === "number" ? raw : raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function getCreditReferencePricePerMillionMicros(rule: PricingRule): number {
  return positiveNumber((rule.config ?? {}).credit_reference_input_price_per_million_micros) ?? DEFAULT_CREDIT_REFERENCE_PRICE_PER_MILLION_MICROS;
}

/** Custo do provedor (micros USD) reescalonado para tokens de referência (ceil = conservador). */
export function normalizeCreditsFromProviderMicros(providerMicros: number, referencePricePerMillionMicros: number): number {
  if (!(providerMicros > 0) || !(referencePricePerMillionMicros > 0)) return 0;
  return Math.ceil((providerMicros * 1_000_000) / referencePricePerMillionMicros);
}

/** Estimativa de reserva por turno em créditos (teto duro conservador pré-provedor). */
export async function estimateTurnCredits(client?: PoolClient): Promise<number> {
  const rule = await getActivePricingRule(client);
  const configured = positiveNumber((rule.config ?? {}).credit_reservation_credits);
  return Math.ceil(configured ?? DEFAULT_TURN_RESERVATION_CREDITS);
}

export async function priceInteraction(input: AiCostInput, client?: PoolClient): Promise<PricedInteraction> {
  const connection = client ?? db;
  const settings = await getBillingSettings(client);
  const rule = await getActivePricingRule(client);
  let inputPrice: number | null = null, outputPrice: number | null = null, cachedPrice: number | null = null;
  let providerMicros: number, rawProviderMicros: number;
  const cacheWriteTokens = Math.max(0, Math.round(input.cacheWriteTokens ?? 0));
  const snapshot: Record<string, unknown> = {
    version: rule.version,
    strategy: rule.strategy,
    markupBps: rule.markup_bps,
    fixedPricePerInteractionCents: rule.fixed_price_per_interaction_cents,
    usdBrlRateMicros: settings.usd_brl_rate_micros,
    fallback: rule.config.fallback,
  };
  if (input.providerCostUsd != null && input.providerCostUsd > 0) {
    // Custo informado (>0) pelo provedor vence a precificação por tabela.
    snapshot.costSource = "provider_reported";
    rawProviderMicros = Math.max(0, input.providerCostUsd * 1_000_000);
    providerMicros = Math.round(rawProviderMicros);
  } else {
    // Custo omitido ou zero (ex.: OpenRouter sem `usage.cost`) NÃO é dado real:
    // precifica pela tabela do modelo — modelo configurado 0/0 segue grátis;
    // sem preço configurado cai no preço de referência (nunca bypass grátis).
    // Preço por PAR (provider, model): o específico do provider vence; sem ele
    // (ou provider desconhecido) vale o preço genérico do modelo (provider NULL).
    const provider = normalizeAiProvider(input.provider);
    const prices = input.model ? await connection.query("SELECT provider, input_price_per_million_micros, output_price_per_million_micros, cached_input_price_per_million_micros FROM ai_model_prices WHERE model=$1 AND (provider=$2 OR provider IS NULL) AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now()) ORDER BY (provider IS NOT NULL) DESC, effective_from DESC LIMIT 1", [input.model, provider]) : { rows: [] };
    snapshot.provider = provider;
    if (!prices.rows[0]) {
      inputPrice = getCreditReferencePricePerMillionMicros(rule);
      outputPrice = inputPrice; cachedPrice = inputPrice;
      snapshot.fallback = "unknown_model_reference_price";
      snapshot.costSource = "reference_fallback";
    }
    else { inputPrice = Number(prices.rows[0].input_price_per_million_micros); outputPrice = Number(prices.rows[0].output_price_per_million_micros); cachedPrice = prices.rows[0].cached_input_price_per_million_micros == null ? null : Number(prices.rows[0].cached_input_price_per_million_micros); snapshot.costSource = "model_price_table"; snapshot.priceProvider = prices.rows[0].provider ?? null; }
    const cachedRead = Math.max(0, input.cachedTokens);
    const fresh = Math.max(0, input.inputTokens - cachedRead - cacheWriteTokens);
    // Cache-write não tem coluna de preço em ai_model_prices: precificado ao
    // preço de input cheio (dentro do prompt total informado pelo provedor).
    // rawProviderMicros mantém a fração sub-micro: arredondar antes de
    // normalizar zerava créditos de chamadas pequenas em modelos baratos.
    rawProviderMicros = Math.max(0, ((fresh * inputPrice) + (cachedRead * (cachedPrice ?? inputPrice)) + (cacheWriteTokens * inputPrice) + (Math.max(0, input.outputTokens) * outputPrice)) / 1_000_000);
    providerMicros = Math.round(rawProviderMicros);
    snapshot.cacheWriteInputTokens = cacheWriteTokens;
    snapshot.cacheWritePricePerMillionMicros = inputPrice;
  }
  snapshot.inputPricePerMillionMicros = inputPrice; snapshot.outputPricePerMillionMicros = outputPrice; snapshot.cachedInputPricePerMillionMicros = cachedPrice;
  const providerBrlCents = Math.max(0, Math.ceil(providerMicros * settings.usd_brl_rate_micros / 10_000_000_000));
  let billable = providerBrlCents;
  if (rule.strategy === "COST_PLUS_MARKUP") billable = Math.ceil(providerBrlCents * (10_000 + (rule.markup_bps ?? 0)) / 10_000);
  else if (rule.strategy === "FIXED_PER_INTERACTION") billable = Math.max(0, rule.fixed_price_per_interaction_cents ?? 0);
  else { snapshot.customFallback = true; billable = Math.ceil(providerBrlCents * (10_000 + (rule.markup_bps ?? 0)) / 10_000); }
  const creditReferencePricePerMillionMicros = getCreditReferencePricePerMillionMicros(rule);
  const normalizedCredits = normalizeCreditsFromProviderMicros(rawProviderMicros, creditReferencePricePerMillionMicros);
  snapshot.creditReferencePricePerMillionMicros = creditReferencePricePerMillionMicros;
  snapshot.normalizedCredits = normalizedCredits;
  return { providerCostUsdMicros: providerMicros, providerCostBrlCents: providerBrlCents, billableAmountBrlCents: Math.max(0, Math.ceil(billable)), pricingStrategy: rule.strategy, pricingSnapshot: snapshot, usdBrlRateMicros: settings.usd_brl_rate_micros, inputPricePerMillionMicros: inputPrice, outputPricePerMillionMicros: outputPrice, normalizedCredits, creditReferencePricePerMillionMicros };
}

export async function estimateInteractionCents(tenantId: string, client?: PoolClient): Promise<number> {
  const settings = await getBillingSettings(client);
  const result = await (client ?? db).query("SELECT AVG(billable_amount_brl_cents) AS average, COUNT(*) AS count FROM (SELECT billable_amount_brl_cents FROM ai_usage_ledger WHERE tenant_id = $1 AND billable_amount_brl_cents > 0 ORDER BY created_at DESC LIMIT 20) recent", [tenantId]);
  const average = Number(result.rows[0]?.average ?? 0);
  return Math.max(1, average > 0 && Number(result.rows[0]?.count ?? 0) >= 3 ? Math.ceil(average) : settings.min_overage_estimate_cents);
}

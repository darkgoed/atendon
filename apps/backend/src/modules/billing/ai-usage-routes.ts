// Relatório funcional de consumo/custo de IA.
// Fontes: usage_logs (0102 — por CHAMADA do provedor) e ai_usage_ledger (por
// TURNO lógico). Um turno tem N chamadas (request_id = ledger.logical_turn_id),
// então o custo BRL/créditos do ledger é agregado POR TURNO antes de qualquer
// junção — juntar ledger direto nas chamadas duplicaria o custo.
// Custo efetivo da chamada: proveniência por cost_reported (0192) — REPORTADO
// pelo provedor mesmo quando 0 (zero real do payload); senão estimativa de
// preço (0191, micros→USD, 'model_price_estimate'); senão 0 ('unknown').
// Escopo: tenant vem SEMPRE do token (rota de workspace) ou é filtro opcional
// explícito do ROOT; nunca um tenantId arbitrário da query na rota de tenant.
// Resposta sem PII: só ids, modelos, tokens e valores.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.js";
import { requireRoot, requireWorkspace } from "../../auth/session.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const uuid = z.string().uuid();
const MAX_WINDOW_DAYS = 92;

const usageQuery = z.object({
  // `period=current`: janela = ciclo de cobrança ABERTO do tenant (instantes
  // exatos de usage_periods, sem truncar para dia UTC — o dia de renovação e o
  // fuso ficam corretos por construção). Sem período aberto → from/to.
  period: z.literal("current").optional(),
  from: day.optional(),
  to: day.optional(),
  groupBy: z.enum(["model", "provider", "agent", "day"]).default("model"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const rootUsageQuery = usageQuery.omit({ period: true }).extend({
  from: day,
  to: day,
  groupBy: z.enum(["tenant", "model", "provider", "agent"]).default("tenant"),
  tenantId: uuid.optional(),
});

/** [início inclusivo, fim exclusivo) da janela; valida formato, ordem e tamanho. */
function windowBounds(from: string, to: string): [Date, Date] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw Object.assign(new Error("Janela de datas inválida"), { statusCode: 400 });
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw Object.assign(new Error(`Janela máxima de ${MAX_WINDOW_DAYS} dias`), { statusCode: 400 });
  }
  return [start, end];
}

const num = (value: unknown): number => Number(value ?? 0);

// ZodError não tem statusCode: sem conversão própria viraria 500 no host.
const parseOr400 = <S extends z.ZodTypeAny>(schema: S, query: unknown): z.infer<S> => {
  const r = schema.safeParse(query);
  if (!r.success) throw Object.assign(new Error(r.error.issues[0]?.message ?? "Payload inválido"), { statusCode: 400 });
  return r.data;
};

// Custo efetivo POR CHAMADA: reportado quando existe; senão estimativa de
// preço (0191, micros→USD); senão 0. Mesma expressão em agregação e chamada.
const effectiveCostExpr = `CASE WHEN ul.cost_reported THEN COALESCE(ul.cost_usd, 0)
                                WHEN ul.priced_cost_usd_micros IS NOT NULL THEN ul.priced_cost_usd_micros / 1000000.0
                                ELSE 0 END`;

// Agregados POR CHAMADA (usage_logs). `key` é a coluna de agrupamento.
const callAgg = `count(*)::int AS calls,
  COALESCE(SUM(ul.input_tokens),0)::bigint AS input_tokens,
  COALESCE(SUM(ul.output_tokens),0)::bigint AS output_tokens,
  COALESCE(SUM(ul.cached_input_tokens),0)::bigint AS cached_input_tokens,
  COALESCE(SUM(ul.cache_write_input_tokens),0)::bigint AS cache_write_input_tokens,
  COALESCE(SUM(ul.reasoning_tokens),0)::bigint AS reasoning_tokens,
  COALESCE(SUM(${effectiveCostExpr}),0)::text AS cost_usd`;

// Sub-junção do ledger POR TURNO: agrega N linhas do ledger do turno em uma
// linha 1:1; sem match os agregados vêm NULL e a chamada fica sem `turn`.
const ledgerByTurn = `
  LEFT JOIN LATERAL (
    SELECT SUM(l.provider_cost_usd_micros) AS provider_cost_usd_micros,
           SUM(l.provider_cost_brl_cents) AS provider_cost_brl_cents,
           SUM(l.billable_amount_brl_cents) AS billable_amount_brl_cents,
           SUM(l.normalized_credits) AS normalized_credits,
           BOOL_AND(l.reconciled) AS reconciled
      FROM ai_usage_ledger l
     WHERE l.tenant_id = ul.tenant_id AND l.logical_turn_id = ul.request_id
  ) t ON ul.request_id IS NOT NULL`;

const callsSelect = `
  SELECT ul.id, ul.created_at, ul.ai_model AS model, ul.provider, ul.input_tokens, ul.output_tokens,
         ul.cached_input_tokens, ul.cache_write_input_tokens, ul.reasoning_tokens,
         ${effectiveCostExpr}::text AS cost_usd,
         CASE WHEN ul.cost_reported THEN 'provider'
              WHEN ul.priced_cost_usd_micros IS NOT NULL THEN 'model_price_estimate'
              ELSE 'unknown' END AS cost_source,
         ul.request_id, ul.conversation_id, ul.message_id,
         ul.call_reason, m.agent_config_version_id,
         t.provider_cost_usd_micros, t.provider_cost_brl_cents, t.billable_amount_brl_cents,
         t.normalized_credits, t.reconciled
    FROM usage_logs ul
    LEFT JOIN messages m ON m.id = ul.message_id
    ${ledgerByTurn}`;

type UsageQuery = z.infer<typeof usageQuery>;
type RootUsageQuery = z.infer<typeof rootUsageQuery>;

type BucketRow = { key: string; tenant_name: string | null; calls: number; input_tokens: string; output_tokens: string; cached_input_tokens: string; cache_write_input_tokens: string; reasoning_tokens: string; cost_usd: string };
type CallRow = { id: string; created_at: Date; model: string; provider: string | null; input_tokens: string; output_tokens: string; cached_input_tokens: string; cache_write_input_tokens: string; reasoning_tokens: string; cost_usd: string; cost_source: string; request_id: string | null; conversation_id: string | null; message_id: string | null; call_reason: string | null; agent_config_version_id: string | null; provider_cost_usd_micros: string | null; provider_cost_brl_cents: string | null; billable_amount_brl_cents: string | null; normalized_credits: string | null; reconciled: boolean | null };
type CallSummaryRow = { calls: number; input_tokens: string; output_tokens: string; cached_input_tokens: string; cache_write_input_tokens: string; reasoning_tokens: string; cost_usd: string };
type TurnSummaryRow = { turns: number; reconciled_turns: number; provider_cost_usd_micros: string; provider_cost_brl_cents: string; billable_amount_brl_cents: string; normalized_credits: string };

const bucketJson = (row: BucketRow, includeTenantName: boolean) => ({
  key: row.key,
  ...(includeTenantName ? { tenantName: row.tenant_name } : {}),
  calls: row.calls,
  inputTokens: num(row.input_tokens),
  outputTokens: num(row.output_tokens),
  cachedInputTokens: num(row.cached_input_tokens),
  cacheWriteInputTokens: num(row.cache_write_input_tokens),
  reasoningTokens: num(row.reasoning_tokens),
  costUsd: num(row.cost_usd),
});

const callJson = (row: CallRow) => ({
  id: row.id,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  model: row.model,
  provider: row.provider,
  inputTokens: num(row.input_tokens),
  outputTokens: num(row.output_tokens),
  cachedInputTokens: num(row.cached_input_tokens),
  cacheWriteInputTokens: num(row.cache_write_input_tokens),
  reasoningTokens: num(row.reasoning_tokens),
  costUsd: num(row.cost_usd),
  costSource: row.cost_source,
  requestId: row.request_id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  callReason: row.call_reason,
  agentConfigVersionId: row.agent_config_version_id,
  // Custo/crédito do TURNO ao qual a chamada pertence (repetido entre as N
  // chamadas do mesmo turno de propósito; os totais nunca somam por chamada).
  turn: row.request_id && row.reconciled !== null ? {
    providerCostUsdMicros: num(row.provider_cost_usd_micros),
    providerCostBrlCents: num(row.provider_cost_brl_cents),
    billableBrlCents: num(row.billable_amount_brl_cents),
    normalizedCredits: num(row.normalized_credits),
    reconciled: row.reconciled === true,
  } : null,
});

/**
 * Monta e executa o relatório. `tenantScope` fixa o tenant (rota de workspace);
 * `rootTenantFilter` é o filtro OPCIONAL do ROOT (null = todos os tenants).
 * Todas as queries de dados recebem escopo de tenant explícito quando existir.
 */
type ReportWindow = { start: Date; end: Date; from: string; to: string; source: "billing_period" | "dates"; timezone?: string };

function dateWindow(from: string | undefined, to: string | undefined): ReportWindow {
  if (!from || !to) throw Object.assign(new Error("Informe from e to (ou period=current)"), { statusCode: 400 });
  const [start, end] = windowBounds(from, to);
  return { start, end, from, to, source: "dates" };
}

/**
 * Ciclo aberto E vigente do tenant; o ledger/cota usam exatamente este
 * intervalo. Período vencido ainda não rotacionado pelo reconciler (troca de
 * ciclo em curso) não é "o ciclo atual" → o chamador cai no fallback de datas.
 */
async function currentPeriodWindow(tenantId: string): Promise<ReportWindow | null> {
  const r = await db.query<{ start_at: Date; end_at: Date; timezone: string }>(
    `SELECT u.start_at, u.end_at, t.timezone FROM usage_periods u JOIN tenants t ON t.id=u.tenant_id
      WHERE u.tenant_id=$1 AND u.status='OPEN' AND u.start_at <= now() AND u.end_at > now() LIMIT 1`, [tenantId]);
  const row = r.rows[0];
  if (!row) return null;
  // Fuso do workspace só para EXIBIR as datas; a janela são os instantes exatos.
  return { start: row.start_at, end: row.end_at, from: row.start_at.toISOString(), to: row.end_at.toISOString(), source: "billing_period", timezone: row.timezone };
}

async function buildReport(tenantScope: string | null, rootTenantFilter: string | null, q: UsageQuery | RootUsageQuery, window: ReportWindow) {
  const { start, end } = window;
  const limit = q.limit;
  const offset = q.offset;

  // tenantId como parâmetro posicional: null = ROOT sem filtro (todos).
  const tenantParam = tenantScope ?? rootTenantFilter;
  const tenantPredicate = tenantScope ? "ul.tenant_id = $1" : "($1::uuid IS NULL OR ul.tenant_id = $1)";
  const params = [tenantParam, start, end];

  const calls = await db.query<CallSummaryRow>(
    `SELECT ${callAgg.replace(/ul\./g, "")} FROM usage_logs ul
      WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3`, params,
  );
  const turns = await db.query<TurnSummaryRow>(
    `SELECT count(*)::int AS turns,
            count(*) FILTER (WHERE l.reconciled)::int AS reconciled_turns,
            COALESCE(SUM(l.provider_cost_usd_micros),0)::bigint AS provider_cost_usd_micros,
            COALESCE(SUM(l.provider_cost_brl_cents),0)::bigint AS provider_cost_brl_cents,
            COALESCE(SUM(l.billable_amount_brl_cents),0)::bigint AS billable_amount_brl_cents,
            COALESCE(SUM(l.normalized_credits),0)::bigint AS normalized_credits
       FROM ai_usage_ledger l
      WHERE ${tenantScope ? "l.tenant_id = $1" : "($1::uuid IS NULL OR l.tenant_id = $1)"}
        AND l.logical_turn_id IN (
          SELECT request_id FROM usage_logs ul
           WHERE ${tenantPredicate} AND created_at >= $2 AND created_at < $3 AND request_id IS NOT NULL)`,
    params,
  );

  let bucketSql: string;
  if (q.groupBy === "day") {
    bucketSql = `SELECT to_char(ul.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS key, NULL::text AS tenant_name, ${callAgg}
                   FROM usage_logs ul WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
                  GROUP BY 1 ORDER BY key ASC LIMIT $4`;
  } else if (q.groupBy === "agent") {
    // Proveniência histórica: agent_config_version_id da MENSAGEM que gerou a
    // chamada (não o agente atual do tenant). Sem proveniência = 'unknown'.
    bucketSql = `SELECT COALESCE(m.agent_config_version_id::text,'unknown') AS key, NULL::text AS tenant_name, ${callAgg}
                   FROM usage_logs ul LEFT JOIN messages m ON m.id = ul.message_id
                  WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
                  GROUP BY 1 ORDER BY 9 DESC LIMIT $4`;
  } else if (q.groupBy === "tenant") {
    bucketSql = `SELECT ul.tenant_id AS key, tn.name AS tenant_name, ${callAgg}
                   FROM usage_logs ul JOIN tenants tn ON tn.id = ul.tenant_id
                  WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
                  GROUP BY 1, 2 ORDER BY 9 DESC LIMIT $4`;
  } else if (q.groupBy === "provider") {
    // Provider real da chamada (0194); histórico sem registro = 'unknown'.
    bucketSql = `SELECT COALESCE(ul.provider,'unknown') AS key, NULL::text AS tenant_name, ${callAgg}
                   FROM usage_logs ul WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
                  GROUP BY 1 ORDER BY 9 DESC LIMIT $4`;
  } else {
    bucketSql = `SELECT ul.ai_model AS key, NULL::text AS tenant_name, ${callAgg}
                   FROM usage_logs ul WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
                  GROUP BY 1 ORDER BY 9 DESC LIMIT $4`;
  }
  const buckets = await db.query<BucketRow>(bucketSql, [...params, limit]);

  const callRows = await db.query<CallRow>(
    `${callsSelect}
      WHERE ${tenantPredicate} AND ul.created_at >= $2 AND ul.created_at < $3
      ORDER BY ul.created_at DESC, ul.id DESC
      LIMIT $4 OFFSET $5`,
    [...params, limit + 1, offset],
  );
  const hasMore = callRows.rows.length > limit;

  const c = calls.rows[0];
  const t = turns.rows[0];
  return {
    summary: {
      // billing_period: from/to são instantes ISO [início, fim) do ciclo;
      // dates: dias YYYY-MM-DD inclusivos informados pelo chamador.
      window: { from: window.from, to: window.to, source: window.source, ...(window.timezone ? { timezone: window.timezone } : {}) },
      calls: {
        count: c.calls,
        inputTokens: num(c.input_tokens),
        outputTokens: num(c.output_tokens),
        cachedInputTokens: num(c.cached_input_tokens),
        cacheWriteInputTokens: num(c.cache_write_input_tokens),
        reasoningTokens: num(c.reasoning_tokens),
        costUsd: num(c.cost_usd),
      },
      // Valores por TURNO (ledger): nunca multiplicados pelo nº de chamadas.
      turns: {
        count: t.turns,
        reconciledTurns: t.reconciled_turns,
        providerCostUsdMicros: num(t.provider_cost_usd_micros),
        providerCostBrlCents: num(t.provider_cost_brl_cents),
        billableBrlCents: num(t.billable_amount_brl_cents),
        normalizedCredits: num(t.normalized_credits),
      },
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    },
    buckets: buckets.rows.map((row) => bucketJson(row, q.groupBy === "tenant")),
    calls: (hasMore ? callRows.rows.slice(0, limit) : callRows.rows).map(callJson),
  };
}

export async function registerAiUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/billing/ai-usage", async (request) => {
    const session = await requireWorkspace(request);
    const q = parseOr400(usageQuery, request.query);
    const window = (q.period === "current" ? await currentPeriodWindow(session.tenantId) : null) ?? dateWindow(q.from, q.to);
    return buildReport(session.tenantId, null, q, window);
  });

  app.get("/root/billing/ai-usage", async (request) => {
    await requireRoot(request);
    const q = parseOr400(rootUsageQuery, request.query);
    return buildReport(null, q.tenantId ?? null, q, dateWindow(q.from, q.to));
  });
}

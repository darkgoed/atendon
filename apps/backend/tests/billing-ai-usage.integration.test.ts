// Integração real (Postgres de teste): relatório de consumo/custo de IA,
// tenant-scoped e ROOT, com autorização, isolamento A/B, dados cached/reasoning,
// turno com múltiplas chamadas, custo BRL do ledger sem duplicação e custo
// efetivo da chamada com proveniência cost_reported (0192): reportado mesmo 0.
// Plugin registrado DIRETAMENTE num Fastify standalone (NUNCA em buildApp():
// app.ts/routes.ts registram registerBillingRoutes — rota duplicada quebraria).
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { registerAiUsageRoutes } from "../src/modules/billing/ai-usage-routes.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(registerAiUsageRoutes);
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof ZodError) return reply.status(400).send({ error: error.issues[0]?.message ?? "Payload inválido" });
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.ready();

type Row = { id: string };
let tenantA = "", tenantB = "", adminA = "", rootUser = "", periodA = "";
let agentVersionA = "";
let cookieAdminA = "";
let cookieRoot = "";

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, values)).rows;
}

/** Insere uma chamada de provedor em usage_logs (0102) e devolve o id. */
async function usageLog(values: { tenantId: string; model: string; input: number; output: number; reasoning?: number; cached?: number; cacheWrite?: number; costUsd: string; costReported?: boolean; pricedCostUsdMicros?: number | null; requestId?: string | null; messageId?: string | null; createdAt: string; callReason?: string }): Promise<string> {
  return (await q<Row>(
    `INSERT INTO usage_logs(tenant_id, ai_model, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, cache_write_input_tokens, cost_usd, cost_reported, priced_cost_usd_micros, request_id, message_id, call_reason, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12::uuid,$13,$14::timestamptz) RETURNING id`,
    [values.tenantId, values.model, values.input, values.output, values.reasoning ?? 0, values.cached ?? 0, values.cacheWrite ?? 0, values.costUsd, values.costReported ?? true, values.pricedCostUsdMicros ?? null, values.requestId ?? null, values.messageId ?? null, values.callReason ?? "inbound_reply", values.createdAt],
  ))[0].id;
}

/** Insere a linha do ledger do TURNO (1 por logical_turn_id). */
async function ledgerRow(values: { tenantId: string; periodId: string; turnId: string | null; purpose: string; reconciled: boolean; providerCostUsdMicros: number; providerCostBrlCents: number; billableBrlCents: number; normalizedCredits: number; model?: string | null; createdAt: string }): Promise<string> {
  return (await q<Row>(
    `INSERT INTO ai_usage_ledger(tenant_id, usage_period_id, interaction_key, logical_turn_id, purpose, consumption_type, model, pricing_strategy, provider_cost_usd_micros, provider_cost_brl_cents, billable_amount_brl_cents, normalized_credits, reconciled, created_at)
     VALUES($1,$2,$3,$4::uuid,$5,'INCLUDED',$6,'COST_PLUS_MARKUP',$7,$8,$9,$10,$11,$12::timestamptz) RETURNING id`,
    [values.tenantId, values.periodId, `it-${randomUUID()}`, values.turnId, values.purpose, values.model ?? null, values.providerCostUsdMicros, values.providerCostBrlCents, values.billableBrlCents, values.normalizedCredits, values.reconciled, values.createdAt],
  ))[0].id;
}

beforeAll(async () => {
  const suffix = randomUUID();
  tenantA = (await q<Row>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`AIUsage A ${suffix}`, `aiusage-a-${suffix}`]))[0].id;
  tenantB = (await q<Row>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`AIUsage B ${suffix}`, `aiusage-b-${suffix}`]))[0].id;
  const roleClient = await pool.connect();
  try { await ensureWorkspaceDefaultRoles(roleClient, tenantA); } finally { roleClient.release(); }
  adminA = (await q<Row>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`aiusage-admin-${suffix}@test.local`]))[0].id;
  rootUser = (await q<Row>("INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id", [`aiusage-root-${suffix}@test.local`]))[0].id;
  await q("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [tenantA, adminA]);

  cookieAdminA = `atendon_session=${await createSessionToken({ userId: adminA, tenantId: tenantA, email: `aiusage-admin-${suffix}@test.local`, isRoot: false, rootWorkspaceAccess: false, mustChangePassword: false })}`;
  cookieRoot = `atendon_session=${await createSessionToken({ userId: rootUser, email: `aiusage-root-${suffix}@test.local`, isRoot: true })}`;

  periodA = (await q<Row>("INSERT INTO usage_periods(tenant_id,sequence,start_at,end_at) VALUES($1,1,now()-interval '1 month',now()+interval '1 month') RETURNING id", [tenantA]))[0].id;
  const periodB = (await q<Row>("INSERT INTO usage_periods(tenant_id,sequence,start_at,end_at) VALUES($1,1,now()-interval '1 month',now()+interval '1 month') RETURNING id", [tenantB]))[0].id;

  // Proveniência de agente histórico (tenant A): a VERSION 1 'active' é criada
  // pelo trigger bootstrap_agent_config_version (0049) — reutilizar por SELECT.
  const agentConfigA = (await q<Row>("INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'p','claude-x') RETURNING id", [tenantA]))[0].id;
  agentVersionA = (await q<Row>("SELECT active_version_id AS id FROM agent_configs WHERE id=$1", [agentConfigA]))[0].id;
  const sessionA = (await q<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA]))[0].id;
  const convA = (await q<Row>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,created_at,last_message_at) VALUES($1,$2,'5511900000001','Contato',now(),now()) RETURNING id",
    [tenantA, sessionA],
  ))[0].id;
  const messageA = (await q<Row>(
    "INSERT INTO messages(conversation_id,sender,content,agent_config_version_id,created_at) VALUES($1,'agent','olá',$2,now()) RETURNING id",
    [convA, agentVersionA],
  ))[0].id;

  // Linha do tempo (UTC): D0 = ontem, D1 = hoje.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const D0 = day(-1);
  const D1 = day(0);

  // Turno T1 (D1, claude-x): DUAS chamadas — cached+reasoning e cache_write.
  const turn1 = randomUUID();
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 100, output: 50, cached: 30, reasoning: 20, costUsd: "0.002000", requestId: turn1, createdAt: `${D1}T09:00:00Z` });
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 80, output: 40, cacheWrite: 10, costUsd: "0.001000", requestId: turn1, createdAt: `${D1}T09:05:00Z` });
  await ledgerRow({ tenantId: tenantA, periodId: periodA, turnId: turn1, purpose: "inbound_reply", reconciled: true, providerCostUsdMicros: 3000, providerCostBrlCents: 16, billableBrlCents: 25, normalizedCredits: 450, model: "claude-x", createdAt: `${D1}T08:59:00Z` });

  // Turno T2 (D0, gemini-y): uma chamada, reserva NÃO reconciliada (custos 0).
  const turn2 = randomUUID();
  await usageLog({ tenantId: tenantA, model: "gemini-y", input: 200, output: 100, reasoning: 5, costUsd: "0.004000", requestId: turn2, createdAt: `${D0}T12:00:00Z` });
  await ledgerRow({ tenantId: tenantA, periodId: periodA, turnId: turn2, purpose: "follow_up", reconciled: false, providerCostUsdMicros: 0, providerCostBrlCents: 0, billableBrlCents: 0, normalizedCredits: 0, createdAt: `${D0}T11:59:00Z` });

  // Turno T3 (D1, claude-x): chamada COM proveniência de agente e SEM request_id/ledger.
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 10, output: 5, costUsd: "0.000500", requestId: null, messageId: messageA, createdAt: `${D1}T10:00:00Z` });

  // Turno T4 (D1, claude-x, SEM ledger): proveniência do custo (0192) —
  // cost_reported=false com priced vira estimativa; cost_reported=true com 0
  // é 'provider' (zero REAL informado); cost_reported=false sem priced é 'unknown'.
  const turn4 = randomUUID();
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 1000, output: 500, costUsd: "0", costReported: false, pricedCostUsdMicros: 700, requestId: turn4, createdAt: `${D1}T09:20:00Z` });
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 2000, output: 1000, costUsd: "0.003000", requestId: turn4, createdAt: `${D1}T09:25:00Z` });
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 500, output: 250, costUsd: "0", costReported: false, requestId: null, createdAt: `${D1}T09:30:00Z` });
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 1500, output: 750, costUsd: "0", requestId: null, createdAt: `${D1}T09:35:00Z` });

  // Fora da janela (não pode aparecer em nada).
  await usageLog({ tenantId: tenantA, model: "claude-x", input: 999, output: 999, costUsd: "9.990000", requestId: null, createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });

  // Tenant B: um turno reconciliado.
  const turnB = randomUUID();
  await usageLog({ tenantId: tenantB, model: "gpt-z", input: 500, output: 250, costUsd: "0.010000", requestId: turnB, createdAt: `${D1}T11:00:00Z` });
  await ledgerRow({ tenantId: tenantB, periodId: periodB, turnId: turnB, purpose: "inbound_reply", reconciled: true, providerCostUsdMicros: 10000, providerCostBrlCents: 55, billableBrlCents: 90, normalizedCredits: 1500, model: "gpt-z", createdAt: `${D1}T10:59:00Z` });
}, 120_000);

afterAll(async () => {
  await q("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[tenantA, tenantB]]);
  await q("DELETE FROM users WHERE id = ANY($1::uuid[])", [[adminA, rootUser]]);
  await app.close();
  await pool.end();
});

const tenantUrl = (extra = "") => `/billing/ai-usage?from=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}${extra}`;
const rootUrl = (extra = "") => `/root/billing/ai-usage?from=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}${extra}`;

describe("Relatório de consumo/custo de IA (usage_logs + ai_usage_ledger)", () => {
  it("401 sem sessão e 403 para não-ROOT no relatório ROOT", async () => {
    expect((await app.inject({ url: tenantUrl() })).statusCode).toBe(401);
    expect((await app.inject({ url: rootUrl() })).statusCode).toBe(401);
    expect((await app.inject({ url: rootUrl(), headers: { cookie: cookieAdminA } })).statusCode).toBe(403);
  });

  it("valida datas, janela, groupBy e limit", async () => {
    const h = { headers: { cookie: cookieAdminA } };
    expect((await app.inject({ url: "/billing/ai-usage?from=ontem&to=hj" , ...h })).statusCode).toBe(400);
    expect((await app.inject({ url: tenantUrl("&groupBy=tenant"), ...h })).statusCode).toBe(400);
    expect((await app.inject({ url: tenantUrl("&limit=201"), ...h })).statusCode).toBe(400);
    expect((await app.inject({ url: tenantUrl("&limit=0"), ...h })).statusCode).toBe(400);
    expect((await app.inject({ url: tenantUrl("&tenantId=nao-e-uuid"), ...h })).statusCode).toBe(200); // ignorado
    // Janela > 92 dias: 400.
    const far = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    expect((await app.inject({ url: `/billing/ai-usage?from=${far}&to=${new Date().toISOString().slice(0, 10)}`, ...h })).statusCode).toBe(400);
    // from depois de to: 400.
    expect((await app.inject({ url: `/billing/ai-usage?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`, ...h })).statusCode).toBe(400);
  });

  it("agregados do tenant: contagens, tokens cached/reasoning e custo efetivo", async () => {
    const r = await app.inject({ url: tenantUrl(), headers: { cookie: cookieAdminA } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    // 8 chamadas na janela (2 do T1 + T2 + T3 + 4 do T4); a de 40 dias fica fora.
    expect(body.summary.calls.count).toBe(8);
    expect(body.summary.calls.inputTokens).toBe(100 + 80 + 200 + 10 + 1000 + 2000 + 500 + 1500);
    expect(body.summary.calls.outputTokens).toBe(50 + 40 + 100 + 5 + 500 + 1000 + 250 + 750);
    expect(body.summary.calls.cachedInputTokens).toBe(30);
    expect(body.summary.calls.cacheWriteInputTokens).toBe(10);
    expect(body.summary.calls.reasoningTokens).toBe(25);
    // 0.003 (T1) + 0.004 (T2) + 0.0005 (T3) + 0.0007 (T4 priced) + 0.003 (T4 reportado) + 0 (unknown).
    expect(body.summary.calls.costUsd).toBeCloseTo(0.0112, 6);
    // T1 e T2 têm UMA linha de ledger cada: BRL não duplica (T4 sem ledger).
    expect(body.summary.turns.count).toBe(2);
    expect(body.summary.turns.reconciledTurns).toBe(1);
    expect(body.summary.turns.providerCostUsdMicros).toBe(3000);
    expect(body.summary.turns.providerCostBrlCents).toBe(16);
    expect(body.summary.turns.billableBrlCents).toBe(25);
    expect(body.summary.turns.normalizedCredits).toBe(450);
  });

  it("quebra por modelo, agente histórico (proveniência da mensagem) e dia", async () => {
    const h = { headers: { cookie: cookieAdminA } };
    const models = (await app.inject({ url: tenantUrl("&groupBy=model"), ...h })).json().buckets;
    const claude = models.find((b: { key: string }) => b.key === "claude-x");
    const gemini = models.find((b: { key: string }) => b.key === "gemini-y");
    expect(claude.calls).toBe(7);
    expect(gemini.calls).toBe(1);
    // 0.003 (T1) + 0.0005 (T3) + 0.0007 (T4 priced) + 0.003 (T4 reportado) + 0 (unknown).
    expect(claude.costUsd).toBeCloseTo(0.0072, 6);
    expect(gemini.costUsd).toBeCloseTo(0.004, 6);

    const agents = (await app.inject({ url: tenantUrl("&groupBy=agent"), ...h })).json().buckets;
    const known = agents.find((b: { key: string }) => b.key === agentVersionA);
    const unknown = agents.find((b: { key: string }) => b.key === "unknown");
    expect(known.calls).toBe(1);
    expect(unknown.calls).toBe(7);
    // Chave é a VERSÃO histórica (id), nunca o nome atual do agente.
    expect(Object.keys(known)).not.toContain("name");

    const days = (await app.inject({ url: tenantUrl("&groupBy=day"), ...h })).json().buckets;
    const byDay = (key: string) => days.find((b: { key: string }) => b.key === key)?.calls ?? 0;
    expect(byDay(new Date().toISOString().slice(0, 10))).toBe(7);
    expect(byDay(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))).toBe(1);
  });

  it("histórico de chamadas: custo efetivo + fonte por chamada, billing do turno repetido sem somar", async () => {
    const r = await app.inject({ url: tenantUrl("&limit=50"), headers: { cookie: cookieAdminA } });
    const calls = r.json().calls;
    expect(calls).toHaveLength(8);
    // Mais recente primeiro: T3 (10:00) antes das demais do D1.
    expect(calls[0].agentConfigVersionId).toBe(agentVersionA);
    expect(calls[0].turn).toBeNull(); // turno sem ledger
    // 0191: fallback de preço, custo reportado e unknown.
    const priced = calls.find((c: { inputTokens: number }) => c.inputTokens === 1000);
    expect(priced.costUsd).toBeCloseTo(0.0007, 6);
    expect(priced.costSource).toBe("model_price_estimate");
    const reported = calls.find((c: { inputTokens: number }) => c.inputTokens === 2000);
    expect(reported.costUsd).toBeCloseTo(0.003, 6);
    expect(reported.costSource).toBe("provider");
    const unknown = calls.find((c: { inputTokens: number }) => c.inputTokens === 500);
    expect(unknown.costUsd).toBe(0);
    expect(unknown.costSource).toBe("unknown");
    // Zero EXPLICITAMENTE reportado pelo provedor é 'provider', não unknown (0192).
    const reportedZero = calls.find((c: { inputTokens: number }) => c.inputTokens === 1500);
    expect(reportedZero.costUsd).toBe(0);
    expect(reportedZero.costSource).toBe("provider");
    const t1calls = calls.filter((c: { inputTokens: number }) => c.inputTokens === 100 || c.inputTokens === 80);
    expect(t1calls).toHaveLength(2);
    for (const call of t1calls) {
      expect(call.turn).toMatchObject({ providerCostUsdMicros: 3000, providerCostBrlCents: 16, billableBrlCents: 25, normalizedCredits: 450, reconciled: true });
    }
    // requestId e ids presentes; nenhum campo de conteúdo/PII.
    expect(calls.every((c: Record<string, unknown>) => !("content" in c))).toBe(true);
  });

  it("pagina o histórico com hasMore/nextOffset", async () => {
    const page1 = (await app.inject({ url: tenantUrl("&limit=2"), headers: { cookie: cookieAdminA } })).json();
    expect(page1.calls).toHaveLength(2);
    expect(page1.summary.pagination).toMatchObject({ limit: 2, offset: 0, hasMore: true, nextOffset: 2 });
    const page2 = (await app.inject({ url: tenantUrl("&limit=2&offset=6"), headers: { cookie: cookieAdminA } })).json();
    expect(page2.calls).toHaveLength(2);
    expect(page2.summary.pagination.hasMore).toBe(false);
  });

  it("janela sem registros: resumo zerado", async () => {
    const r = await app.inject({ url: "/billing/ai-usage?from=2020-01-01&to=2020-01-03", headers: { cookie: cookieAdminA } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      summary: {
        calls: { count: 0, costUsd: 0 },
        turns: { count: 0, providerCostUsdMicros: 0, billableBrlCents: 0 },
        pagination: { hasMore: false, nextOffset: null },
      },
      buckets: [],
      calls: [],
    });
  });

  it("isola tenants: admin de A nunca vê dados de B, mesmo passando tenantId de B", async () => {
    const r = (await app.inject({ url: tenantUrl(`&tenantId=${tenantB}`), headers: { cookie: cookieAdminA } })).json();
    expect(r.summary.calls.count).toBe(8);
    expect(r.calls.every((c: { model: string }) => c.model !== "gpt-z")).toBe(true);
  });

  it("ROOT vê todos os tenants, filtra por tenantId e quebra por tenant/modelo", async () => {
    const all = (await app.inject({ url: rootUrl(), headers: { cookie: cookieRoot } })).json();
    expect(all.summary.calls.count).toBe(9);
    // A (0.0112) + B (0.01).
    expect(all.summary.calls.costUsd).toBeCloseTo(0.0212, 6);
    expect(all.summary.turns.count).toBe(3);
    expect(all.summary.turns.billableBrlCents).toBe(25 + 90); // T1 + turno B, uma vez cada
    expect(all.summary.turns.normalizedCredits).toBe(450 + 1500);
    const tenantBuckets = all.buckets;
    const bucketA = tenantBuckets.find((b: { key: string }) => b.key === tenantA);
    const bucketB = tenantBuckets.find((b: { key: string }) => b.key === tenantB);
    expect(bucketA.tenantName).toMatch(/AIUsage A /);
    expect(bucketA.calls).toBe(8);
    expect(bucketA.costUsd).toBeCloseTo(0.0112, 6);
    expect(bucketB.calls).toBe(1);
    expect(bucketB.costUsd).toBeCloseTo(0.01, 6);

    const onlyA = (await app.inject({ url: rootUrl(`&tenantId=${tenantA}`), headers: { cookie: cookieRoot } })).json();
    expect(onlyA.summary.calls.count).toBe(8);
    expect(onlyA.calls.every((c: { model: string }) => c.model !== "gpt-z")).toBe(true);

    const byModel = (await app.inject({ url: rootUrl("&groupBy=model"), headers: { cookie: cookieRoot } })).json().buckets;
    expect(byModel.find((b: { key: string }) => b.key === "gpt-z").calls).toBe(1);

    // tenantId inválido no ROOT é rejeitado (não vira "todos").
    expect((await app.inject({ url: rootUrl("&tenantId=xyz"), headers: { cookie: cookieRoot } })).statusCode).toBe(400);
  });
});

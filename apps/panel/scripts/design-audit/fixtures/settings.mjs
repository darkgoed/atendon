import { IDS, member, session, workspace } from "./session.mjs";

const longLabel = "Operação comercial São Paulo · WhatsApp principal · Atendimento estendido";
const secondLongLabel = "Pós-venda e suporte · WhatsApp secundário · Equipe especializada";
const connectionId = "qa-connection-0001";
const secondConnectionId = "qa-connection-0002";
const memberId = member.id;
const category = { id: "qa-category-0001", tenant: workspace.id, nome: "Demonstração e implantação de solução empresarial", ativa: true };
const partner = { id: "qa-partner-0001", tenant: workspace.id, nome: "Parceiro estratégico de tecnologia e implementação", ordem_prioridade: 1, link_proposta: "https://example.test/proposta-qa", ativo: true };
const unit = { id: "qa-unit-0001", tenant: workspace.id, nome: "Unidade São Paulo · Atendimento e demonstrações", horario_abertura: "08:00:00", horario_fechamento: "18:00:00", dias_funcionamento: [1, 2, 3, 4, 5], duracao_slot_min: 30, capacidade_simultanea: 2 };
const attendants = [{ member_id: memberId, user_id: member.user_id, email: member.email, funcao: "Especialista de atendimento e implantação", selected: true, availability_status: "available", availability_changed_at: "2026-08-20T12:00:00.000Z", availability_changed_by_email: member.email, cor_agenda: "#168aad", active_appointments: 1, last_assigned_at: "2026-08-20T12:00:00.000Z", is_current: true }];
const agent = { id: "qa-agent-config-0001", active_version_id: "qa-agent-version-0002", session_id: null, system_prompt: "Atenda com clareza, confirme o contexto e conduza o cliente até o próximo passo sem inventar informações.", ai_model: "openai/gpt-4o-mini", openrouter_provider: "openai", model_params: { temperature: 0.4, max_tokens: 512, reasoning_effort: "medium" }, is_active: true, has_openrouter_api_key: false, media_fallback_audio: "audio-fallback", media_fallback_image: "image-fallback", media_fallback_document: "document-fallback", enabled_tools: ["schedule_appointment", "search_leads"] };
const client = { id: "qa-post-sale-client-0001", name: "Marina QA · Cliente de implantação empresarial", phone_e164: "5511999990001", email: "marina@example.test", notes: "Acompanhar implantação e treinamento da equipe.", responsible_member_id: memberId, responsible_name: member.name, responsible_email: member.email, next_action: "Confirmar treinamento de implantação", next_action_at: "2026-08-21T12:00:00.000Z", next_action_queue: "upcoming", origin: "manual", lead_id: IDS.lead, conversation_id: IDS.conversation, archived_at: null, version: 1, created_at: "2026-08-20T12:00:00.000Z", updated_at: "2026-08-20T12:00:00.000Z", checklist_total: 2, checklist_completed: 1, checklist_accepted: 1, progress_percent: 50, state: "in_progress" };
const checklist = [
  { id: "qa-check-0001", item_id: "qa-template-0001", description: "Confirmar cadastro e dados da empresa", position: 0, is_active: true, item_archived_at: null, item_version: 1, result: "aceito", note: "Cadastro validado pelo cliente.", version: 1, updated_at: "2026-08-20T12:00:00.000Z", updated_by_name: member.name },
  { id: "qa-check-0002", item_id: "qa-template-0002", description: "Agendar treinamento de implantação para a equipe", position: 1, is_active: true, item_archived_at: null, item_version: 1, result: "pendente", note: null, version: 1, updated_at: "2026-08-20T12:00:00.000Z", updated_by_name: null }
];
const templateItems = checklist.map((item) => ({ id: item.item_id, description: item.description, position: item.position, is_active: item.is_active, archived_at: null, version: item.item_version, client_count: 1, answered_count: item.result === "pendente" ? 0 : 1 }));
const debt = { id: "qa-debt-0001", store: "Unidade São Paulo", customer_name: "Cliente QA · Conta empresarial", phone_raw: "5511988880001", phone_e164: "5511988880001", reference_date: "2026-08-01", amount_open: 19900, amount_recovered: 0, status: "open", contact_method: "whatsapp", payment_method: "pix", reason: "Parcela de implantação", promise_date: "2026-08-30", notes: "Retornar após treinamento.", days_without_contact: 3, alert: "Contato pendente", created_at: "2026-08-20T12:00:00.000Z" };

const connections = [
  { id: connectionId, label: longLabel, channel: "whatsapp", is_primary: true, status: "connected", phone_number: "+55 11 99999-0001", qr_code: null, last_connected_at: "2026-08-20T12:00:00.000Z", disconnected_reason: null, created_at: "2026-08-01T12:00:00.000Z" },
  { id: secondConnectionId, label: secondLongLabel, channel: "whatsapp", is_primary: false, status: "qr_pending", phone_number: null, qr_code: "data:image/png;base64,QA", last_connected_at: null, disconnected_reason: null, created_at: "2026-08-02T12:00:00.000Z" }
];

// /uso e /configuracoes/uso: cada GET na forma devolvida por billing/routes.ts, billing/alerts.ts
// (getUsageDashboard), billing/credit-packs.ts e billing/ai-usage-routes.ts (buildReport).
// Coerência: totalAvailable = franquia + acumulado + bônus; o pacote comprado no ciclo já está no
// bônus (concedido e consumido iguais ao saldo de pacotes); summary.calls = soma dos buckets;
// normalizedCredits do ledger = total usado. O roteador do harness só enxerga o pathname, então
// groupBy=model e groupBy=agent recebem o mesmo relatório (o "Por agente" fica fechado na tela).
const PACK = { sku: "AI_CREDITS_50M", credits: 50_000_000, priceCents: 15_700, currency: "BRL" };
const packConsumed = 3_000_000;
const cycle = { start: "2026-08-01T03:00:00.000Z", end: "2026-09-01T03:00:00.000Z" };
const usageDashboard = (() => {
  const base = { includedLimit: 100_000_000, includedUsage: 42_500_000, rolloverGranted: 12_000_000, rolloverUsage: 0, bonusGranted: PACK.credits, bonusUsage: packConsumed };
  const totalAvailable = base.includedLimit + base.rolloverGranted + base.bonusGranted;
  const totalUsed = base.includedUsage + base.rolloverUsage + base.bonusUsage;
  return { planName: "Profissional", ...base, totalAvailable, totalUsed, usedPercentBps: Math.floor((totalUsed * 10000) / totalAvailable), usageUnit: "CREDIT", periodStart: cycle.start, periodEnd: cycle.end, daysUntilRenewal: Math.max(0, Math.ceil((Date.parse(cycle.end) - Date.parse("2026-08-20T12:00:00.000Z")) / 86_400_000)), creditEnabled: true, creditLimitCents: 10_000, creditUsedCents: 0, balanceLabel: "Creditos de IA (tokens normalizados)", usageLabel: "Tokens normalizados consumidos" };
})();
const packGrant = { id: "qa-grant-0001", amount: PACK.credits, consumedAmount: packConsumed, remaining: PACK.credits - packConsumed, active: true, expiresAt: null, createdAt: "2026-08-10T12:00:00.000Z", invoiceId: "qa-invoice-0002", purchaseStatus: "GRANTED" };
const creditBalance = { availableCredits: packGrant.remaining, grantedCredits: PACK.credits, consumedCredits: packConsumed, grants: [packGrant] };
const creditPurchases = { sku: PACK, purchases: [{ id: "qa-purchase-0001", tenant_id: workspace.id, idempotency_key: "0f5d3c1e-7a4b-4c39-9d2a-5b6e8f1a2c3d", sku: PACK.sku, credits: String(PACK.credits), price_cents: String(PACK.priceCents), currency: PACK.currency, invoice_id: "qa-invoice-0002", grant_id: packGrant.id, status: "GRANTED", granted_at: "2026-08-10T12:05:00.000Z", revoked_credits: "0", revoked_at: null, created_at: "2026-08-10T12:00:00.000Z", updated_at: "2026-08-10T12:05:00.000Z", invoice_status: "paid" }], page: 1, limit: 25 };
const pixAutomatic = { mandate: { id: "qa-mandate-0001", status: "APPROVED", firstDueOn: "2026-09-01", pixCopiaECola: null }, sku: PACK };
const invoiceLine = (id, invoiceId, kind, description, cents, createdAt) => ({ id, invoice_id: invoiceId, kind, description, quantity: 1, unit_amount_cents: cents, amount_cents: cents, usage_period_id: null, metadata: {}, created_at: createdAt });
const billingHistory = [
  { id: "qa-invoice-0002", tenant_id: workspace.id, subscription_id: null, amount_cents: String(PACK.priceCents), currency: "BRL", status: "paid", kind: "credit_package", period_start: "2026-08-10T12:00:00.000Z", period_end: "2026-08-10T12:00:00.000Z", monthly: false, line_items: [invoiceLine("qa-line-0002", "qa-invoice-0002", "ADDON", "Pacote de 50.000.000 créditos de IA", PACK.priceCents, "2026-08-10T12:00:00.000Z")], provider_code: null },
  { id: "qa-invoice-0001", tenant_id: workspace.id, subscription_id: "qa-subscription-0001", amount_cents: "19900", currency: "BRL", status: "paid", kind: "subscription", period_start: "2026-07-01T03:00:00.000Z", period_end: cycle.start, monthly: true, line_items: [invoiceLine("qa-line-0001", "qa-invoice-0001", "PLAN", "Plano contratado", 19_900, "2026-07-01T03:00:00.000Z")], provider_code: null }
];
const aiBuckets = [
  { key: "openai/gpt-4o-mini", calls: 1012, inputTokens: 14_000_000, outputTokens: 1_700_000, cachedInputTokens: 7_600_000, cacheWriteInputTokens: 480_000, reasoningTokens: 0, costUsd: 9.35 },
  { key: "google/gemini-2.5-flash", calls: 272, inputTokens: 4_400_000, outputTokens: 450_000, cachedInputTokens: 2_200_000, cacheWriteInputTokens: 140_000, reasoningTokens: 410_000, costUsd: 28.07 }
];
const bucketTotal = (field) => aiBuckets.reduce((total, bucket) => total + bucket[field], 0);
const aiCall = (n, model, provider, minutesAgo) => ({ id: `qa-call-000${n}`, createdAt: new Date(Date.parse("2026-08-20T12:00:00.000Z") - minutesAgo * 60_000).toISOString(), model, provider, inputTokens: 18_200, outputTokens: 1_450, cachedInputTokens: 9_000, cacheWriteInputTokens: 0, reasoningTokens: 0, costUsd: 0.0123, costSource: "provider", requestId: `qa-turn-000${n}`, conversationId: IDS.conversation, messageId: `qa-message-000${n}`, callReason: null, agentConfigVersionId: "qa-agent-version-0002", turn: { providerCostUsdMicros: 12_300, providerCostBrlCents: 7, billableBrlCents: 12, normalizedCredits: 71_000, reconciled: true } });
const aiUsageReport = {
  summary: {
    window: { from: cycle.start, to: cycle.end, source: "billing_period", timezone: "America/Sao_Paulo" },
    calls: { count: bucketTotal("calls"), inputTokens: bucketTotal("inputTokens"), outputTokens: bucketTotal("outputTokens"), cachedInputTokens: bucketTotal("cachedInputTokens"), cacheWriteInputTokens: bucketTotal("cacheWriteInputTokens"), reasoningTokens: bucketTotal("reasoningTokens"), costUsd: Math.round(bucketTotal("costUsd") * 100) / 100 },
    turns: { count: 640, reconciledTurns: 640, providerCostUsdMicros: 37_420_000, providerCostBrlCents: 20_600, billableBrlCents: 35_400, normalizedCredits: usageDashboard.totalUsed },
    pagination: { limit: 50, offset: 0, hasMore: false, nextOffset: null }
  },
  buckets: aiBuckets,
  calls: [aiCall(3, "openai/gpt-4o-mini", "openai", 2), aiCall(2, "google/gemini-2.5-flash", "google", 14), aiCall(1, "openai/gpt-4o-mini", "openai", 31)]
};

const settingsResponse = (path) => {
  if (path === "/organization/teams") return { teams: [{ id: "qa-team-0001", name: "Atendimento QA", created_at: "2026-08-20T12:00:00.000Z", updated_at: "2026-08-20T12:00:00.000Z", member_count: 1, active_member_count: 1 }] };
  if (path === "/me/messaging-capabilities") return { sessions: connections.map(({ id, label, phone_number, status }) => ({ session_id: id, label, phone_number, status, capabilities: { reactions: false, forward_media: false, interactive: false } })) };
  if (path === "/scheduling/config/categorias") return { categorias: [category] };
  if (path === "/scheduling/config/parceiros") return { parceiros: [partner] };
  if (path === "/scheduling/config/unidades") return { unidades: [unit] };
  if (path === "/scheduling/config/notifications") return { notifications: { enabled: true, session_id: connectionId, group_jid: "120363000000000000@g.us", group_name: "Agenda · Reuniões e confirmações" } };
  if (path === "/scheduling/config/notification-groups") return { groups: [{ id: "120363000000000000@g.us", subject: "Agenda · Reuniões e confirmações" }] };
  if (path === "/scheduling/config/attendants") return { attendants, member_ids: [memberId], redistribuidos: 0, redistribuidos_leads: 0, redistribuidos_conversas: 0, redistribuidos_reunioes: 0 };
  if (path === "/scheduling/config/atendon-meet") return { settings: { enabled: false, available: true } };
  if (path === "/scheduling/config/google-meet") return { settings: { enabled: true, organizer_email: "qa@example.test", creation_moment: "appointment_confirmed", closer_member_ids: [memberId], oauth_email: "qa@example.test", oauth_connected_at: "2026-08-20T12:00:00.000Z", oauth_connected: true, oauth_available: true }, closers: [{ member_id: memberId, user_id: member.user_id, email: member.email, funcao: member.funcao ?? "Especialista" }] };
  if (path === "/workspaces/current/timezone") return { workspace: { id: workspace.id, name: workspace.name, timezone: "America/Sao_Paulo", business_hours_start: "08:00:00", business_hours_end: "18:00:00" } };
  if (path === "/me/notification-preferences") return { preferences: { enabled: true, sound_enabled: true, visual_enabled: true }, muted_conversations: [{ id: IDS.conversation, contact_name: "Marina QA", contact_phone: "+55 11 99999-0001", muted_at: "2026-08-20T12:00:00.000Z" }] };
  if (path === "/signature") return { signature: { enabled: true, format: "name_colon", name_style: "full" } };
  if (path === "/connections") return { connections, limits: { used: 2, max: 3 } };
  if (path === "/connection/failed-messages") return { recovery: { available: 1, ambiguous: 0, has_connected_session: true, legacy_unrecoverable: 0, oldest_at: "2026-08-20T12:00:00.000Z" } };
  if (path === "/agent") return { agent, scope: "shared", available_tools: ["schedule_appointment", "search_leads", "lookup_contact"] };
  if (path === "/humanizer") return { humanizer: { composing: { enabled: true, minDelayMs: 900, maxDelayMs: 2600, resendIntervalMs: 5000 }, messageSplit: { enabled: true, maxWordsPerBubble: 35, pauseBetweenBubblesMs: { min: 500, max: 1200 } }, typing: { enabled: true }, jitter: { enabled: true, minMs: 200, maxMs: 800 } } };
  if (path === "/ai-follow-ups/settings") return { settings: { enabled: true, delaysMinutes: [120, 1440, 4320], delivery: [{ type: "text" }, { type: "text" }, { type: "text" }], maxCount: 3, intervalMinutes: 120 } };
  if (path === "/ai-follow-ups/media") return { media: [{ id: "qa-media-0001", name: "Case de implantação empresarial", description: "Imagem enviada após o cliente confirmar a próxima etapa.", mime_type: "image/png", file_name: "case-implantacao.png", size_bytes: 24576 }] };
  if (path === "/ai-stickers") return { stickers: [] };
  if (path === "/alerts") return { alerts: [{ id: "qa-alert-0001", message: "Conexão verificada para a operação comercial.", kind: "operational", metadata: {}, created_at: "2026-08-20T12:00:00.000Z", notified_at: "2026-08-20T12:00:00.000Z", read_at: null, can_acknowledge: true }], unread: 1, total: 1, offset: 0, limit: 50, receipt_mode: "member" };
  if (path === "/post-sales/clients") return { summary: { active: 1, archived: 0, not_started: 0, in_progress: 1, complete: 0, overdue: 0, today: 0, upcoming: 1 }, clients: [client], next_cursor: null };
  if (path.startsWith("/post-sales/clients/")) return { client, checklist };
  if (path === "/post-sales/options") return { members: [member] };
  if (path === "/post-sales/debts/options") return { stores: ["Unidade São Paulo"], statuses: ["open", "paid"] };
  if (path === "/post-sales/debts") return { summary: { total: 1, paid: 0, amount_open_total: 19900, amount_recovered_total: 0 }, debts: [debt] };
  if (path === "/post-sales/checklist-template/items") return { items: templateItems };
  if (path === "/billing/my-plan") return { tenantId: workspace.id, plan: { code: "professional", name: "Profissional" }, status: "active", features: { AI_FOLLOWUP: true, POST_SALES: true, HUMANIZER: true }, limits: { MAX_WHATSAPP_CONNECTIONS: 3 }, usage: { ai_followups: 2, whatsapp_connections: 2 } };
  if (path === "/billing/usage-dashboard") return { dashboard: usageDashboard };
  if (path === "/billing/usage-credit") return { setting: { enabled: true, limit_type: "FIXED", monthly_spending_limit_cents: 10000, confirmed_unlimited_at: null }, allowed: { suggested: 10000, min: 1000, max: 100000, allowCustom: true, allowUnlimited: false } };
  if (path === "/billing/history") return { history: billingHistory };
  if (path === "/billing/ai-credit-packs/balance") return { balance: creditBalance };
  if (path === "/billing/ai-credit-packs/pix-automatic") return pixAutomatic;
  if (path === "/billing/ai-credit-packs") return creditPurchases;
  if (path === "/billing/ai-usage") return aiUsageReport;
};

export function settingsFixture(path) {
  return settingsResponse(path);
}

export { client, connections, checklist, agent };

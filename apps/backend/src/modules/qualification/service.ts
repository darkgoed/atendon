import { promises as dnsPromises } from "node:dns";
import type { Pool, PoolClient } from "pg";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { zonedParts } from "../../timezone.js";
import type { InteractivePayload, MessageGateway, MessageReferral } from "../messages/types.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import {
  assertPublicWebhookUrl, conditionValueHidden, evaluateCondition, flowDefinitionSchema, interactiveChoices, interactivePayload,
  nextStepId, remainingQuestions, renderFinalMessage, renderInteractivePreview, renderQuestion,
  renderTemplate, totalQuestions, type FlowDefinition, type FlowStep, type FlowVars
} from "./flow.js";
import { classifyBoolean, matchAnswer, matchAnswerCandidates, normalizeText } from "./normalizer.js";
import { ensureCaseAssignment } from "../assignments/service.js";
import { isWhatsAppSendRejectedError } from "../whatsapp/errors.js";
import { enqueueQualificationWait, type QualificationWaitJob } from "../../queue/qualification-wait-queue.js";

export interface QualificationInbound {
  tenantId: string;
  sessionId: string;
  contactPhone: string;
  contactJid?: string;
  contactName?: string;
  text: string;
  externalId: string;
  referral?: MessageReferral;
}

export type AiOptionClassifier = (question: string, options: string[], answer: string) => Promise<string | null>;
export interface QualificationOutcome { reply: string | null; outboxId?: string }

type QualificationStatus = "em_andamento" | "pausado" | "concluido";
type TriggerType = "ctwa" | "session" | "keyword";
type OutboxKind = "question" | "clarification" | "confirmation" | "final" | "message" | "interactive";
type ExecutionStatus = "entered" | "completed" | "failed" | "waiting" | "skipped";

interface StateRow {
  id: string;
  lead_id: string;
  flow_id: string;
  current_step: string;
  status: QualificationStatus;
  answers: Record<string, string>;
  pending_value: string | null;
  ask_pending: boolean;
  last_inbound_external_id: string | null;
  definition_snapshot: unknown;
  wait_until: Date | null;
  wait_session_id: string | null;
  conversation_id: string | null;
  assigned_user_id: string | null;
  lead_name: string | null;
  flow_allowed_role_ids: unknown;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  qualification_id: string | null;
  step_id: string | null;
  session_id: string;
  contact_phone: string;
  contact_jid: string | null;
  message: string;
  inbound_external_id: string;
  message_kind: string;
  interactive_payload: Record<string, unknown> | null;
}

/** Contexto de execução do fluxo (uma conversa/lead processando um passo a passo). */
interface WalkContext {
  tenantId: string;
  qualificationId: string;
  leadId: string;
  flowId: string;
  conversationId: string | null;
  sessionId: string;
  contactPhone: string;
  contactJid?: string | null;
  externalId: string;
  timezone: string | null;
}

interface WalkMessage { stepId: string; kind: OutboxKind; text: string; interactive?: Record<string, unknown> }

interface WalkWebhook { stepId: string; url: string; method: "GET" | "POST" | "PUT"; body: string | null }

interface WalkOutput {
  restStep: string;
  status: QualificationStatus;
  waitUntil: Date | null;
  messages: WalkMessage[];
  webhooks: WalkWebhook[];
  historyEntries: Record<string, unknown>[];
  concludo: { resultado: string; classificacao: string | null } | null;
  stoppedReason: "input" | "wait" | "final" | "cap" | "cycle" | "missing_step" | null;
}

interface LogContext { tenantId: string; flowId: string; leadId: string; conversationId: string | null }

export function leadQualificationMapper(row: Record<string, unknown>) {
  if (!row.q_status) return null;
  return {
    status: row.q_status,
    etapa_atual: row.q_current_step,
    origem_qualificacao: row.q_attribution && typeof row.q_attribution === "object"
      ? (row.q_attribution as Record<string, unknown>).channel ?? "facebook"
      : "facebook",
    gatilho: row.q_trigger_type ?? null,
    atribuicao: row.q_attribution ?? {},
    faturamento: row.q_faturamento ?? null,
    investimento: row.q_investimento ?? null,
    instagram: row.q_instagram ?? null,
    resultado_final: row.q_resultado_final ?? null,
    classificacao: row.q_classificacao ?? null,
    progresso: { respondidas: row.q_answered_count, total: row.q_total_questions },
    ...(row.q_answers !== undefined ? { respostas: row.q_answers } : {}),
    ...(row.q_history !== undefined ? { historico: row.q_history } : {})
  };
}

function confirmationPrompt(value: string): string {
  return `Só pra confirmar: posso registrar "${value}"? (Sim ou Não)`;
}

function clarifyPrompt(step: FlowStep, candidates: string[] = [], vars: FlowVars = {}): string {
  if (candidates.length > 1) return `Sua resposta parece indicar mais de uma opção (${candidates.join(" ou ")}). Qual delas você quer escolher?\n${renderQuestion(step, vars)}`;
  if (step.field === "instagram") return "Não consegui validar esse Instagram. Envie @usuario, um link do Instagram ou responda “não possui”.";
  if (step.kind === "boolean") return `Não consegui entender 🙈 Consegue me responder com Sim ou Não? ${renderQuestion(step, vars)}`;
  return `Não consegui identificar direitinho 🙈 ${renderQuestion(step, vars)}`;
}

function parseDefinition(tenantId: string, raw: unknown): FlowDefinition | null {
  const parsed = flowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ tenantId, issues: parsed.error.issues }, "Definição de fluxo de qualificação inválida");
    return null;
  }
  return parsed.data;
}

function matchTrigger(definition: FlowDefinition, input: QualificationInbound): TriggerType | null {
  if (definition.triggers.ctwa && input.referral) return "ctwa";
  if (definition.triggers.session_ids.includes(input.sessionId)) return "session";
  // lição 5 do legado: gatilho por palavra-chave é MATCH EXATO do texto normalizado
  // (minúsculas + sem acento + trim). Substring nunca dispara ("quero orcamento" ≠ "orcamento").
  const text = normalizeText(input.text);
  if (definition.triggers.keywords.some((keyword) => text === normalizeText(keyword))) return "keyword";
  return null;
}

function tenantDate(timezone: string | null | undefined, now = new Date()): string {
  const parts = zonedParts(now, timezone || "America/Sao_Paulo");
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

/** Variáveis para interpolação {{...}}: respostas anteriores por campo + contato + data. */
function flowVars(answers: Record<string, string>, contact: { name?: string | null; phone: string }, timezone: string | null | undefined): FlowVars {
  return { ...answers, nome: contact.name ?? "", telefone: contact.phone, data: tenantDate(timezone) };
}

/**
 * Gating de execução por papel (SPEC v7 C1-c): allowed_role_ids vazio = sem
 * restrição; com restrição, o responsável atual do lead (assigned_member_id)
 * precisa ter um dos papéis. Lead sem responsável = bloqueado (fail-closed,
 * sempre logado como skipped no flow_execution_log).
 */
async function flowRoleAllowed(
  database: Pick<Pool, "query">,
  tenantId: string,
  leadId: string,
  allowedRoleIds: unknown
): Promise<boolean> {
  const roles = Array.isArray(allowedRoleIds) ? allowedRoleIds as string[] : [];
  if (!roles.length) return true;
  // Fail-closed: com restrição, o responsável atual do lead PRECISA ter um dos
  // papéis. Lead sem responsável (ou com responsável órfão/papel removido) =
  // bloqueado — o executor grava skipped e o turno de IA assume.
  const result = await database.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM scheduling_leads l
       JOIN workspace_members m ON m.id=l.assigned_member_id AND m.workspace_id=l.tenant_id
       JOIN workspace_roles r ON r.id=m.role_id
       WHERE l.id=$1 AND l.tenant_id=$2 AND r.id=ANY($3::uuid[])
     ) AS allowed
     LIMIT 1`,
    [leadId, tenantId, roles]
  );
  return Boolean(result.rows[0]?.allowed);
}

function attribution(input: QualificationInbound, tenantProduct: string): Record<string, unknown> {
  return {
    provider: "meta",
    channel: "facebook",
    product: tenantProduct,
    ...(input.referral ? {
      source_type: input.referral.sourceType,
      source_id: input.referral.sourceId,
      source_url: input.referral.sourceUrl,
      headline: input.referral.headline,
      body: input.referral.body,
      media_type: input.referral.mediaType,
      thumbnail_url: input.referral.thumbnailUrl,
      ctwa_clid: input.referral.ctwaClid
    } : {})
  };
}

async function pauseQualificationByConversation(client: PoolClient, tenantId: string, conversationId: string, reason: string): Promise<void> {
  const paused = await client.query<{ lead_id: string }>(
    `UPDATE lead_qualifications q SET status='pausado',updated_at=now()
     FROM conversations c
     WHERE c.id=$2 AND c.tenant_id=$1 AND c.lead_id=q.lead_id AND c.tenant_id=q.tenant_id AND q.status='em_andamento'
     RETURNING q.lead_id`, [tenantId, conversationId]
  );
  if (paused.rows[0]) await client.query(
    "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_pausado',$3)",
    [paused.rows[0].lead_id, tenantId, { motivo: reason }]
  );
}

async function logExecution(
  client: PoolClient,
  ctx: LogContext,
  node: { id: string; kind: string },
  status: ExecutionStatus,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO flow_execution_log(tenant_id,flow_id,conversation_id,lead_id,node_id,kind,status,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, ctx.flowId, ctx.conversationId, ctx.leadId, node.id, node.kind, status, detail]
  );
}

async function logExecutionBestEffort(ctx: LogContext, node: { id: string; kind: string }, status: ExecutionStatus, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO flow_execution_log(tenant_id,flow_id,conversation_id,lead_id,node_id,kind,status,detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, ctx.flowId, ctx.conversationId, ctx.leadId, node.id, node.kind, status, detail]
    );
  } catch (error) {
    logger.warn({ error, tenantId: ctx.tenantId, flowId: ctx.flowId, nodeId: node.id }, "flow_execution_log insert failed");
  }
}

/** Retenção: mantém 90 dias de histórico (1 statement; job diário no worker). */
export async function purgeFlowExecutionLogs(): Promise<number> {
  const result = await db.query("DELETE FROM flow_execution_log WHERE created_at < now() - interval '90 days'");
  return result.rowCount ?? 0;
}

/**
 * Marca como enviada a mensagem do robô que voltou inline ao pipeline inbound
 * (primeira do caminho, entregue por process-message). Sem isso a outbox
 * reenviaria a mesma mensagem quando o pump rodar.
 */
export async function markQualificationOutboxSent(outboxId: string, externalId: string): Promise<void> {
  await db.query(
    "UPDATE qualification_message_outbox SET status='sent',external_message_id=$2,sent_at=now(),claimed_at=NULL WHERE id=$1 AND status='pending'",
    [outboxId, externalId]
  );
}

/** Esperas vencidas para o reconciliador do worker (rede de segurança do BullMQ). */
export async function listDueFlowWaits(limit = 100): Promise<QualificationWaitJob[]> {
  const result = await db.query<{ id: string; tenant_id: string }>(
    `SELECT id,tenant_id FROM lead_qualifications
     WHERE status='em_andamento' AND wait_until IS NOT NULL AND wait_until<=now() + interval '5 seconds'
     ORDER BY wait_until LIMIT $1`, [limit]
  );
  return result.rows.map((row) => ({ tenantId: row.tenant_id, qualificationId: row.id }));
}

// SSRF residual (fix auditoria): cópia local de isInternalIPv4 (flow.ts não a
// exporta e está fora do escopo) + coberta IPv6 para endereços resolvidos.
function isInternalIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

function isInternalResolvedAddress(entry: { address: string; family: number }): boolean {
  const ip = entry.address.toLowerCase().split("%")[0]; // zone index (fe80::1%eth0)
  if (entry.family !== 6) return isInternalIPv4(ip);
  // Mesmas regras de isInternalHost (flow.ts) para IPv6: ::/::1, mapeado
  // ::ffff: (qualquer forma), ULA fc00::/7 e link-local fe80::/10 — fail-closed.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isInternalIPv4(mapped[1]);
  return ip === "::" || ip === "::1" || /^::ffff:/i.test(ip) || /^f[cd]/.test(ip) || /^fe80/.test(ip);
}

export async function fireFlowWebhooks(
  webhooks: WalkWebhook[],
  ctx: WalkContext
): Promise<Array<{ stepId: string; status: ExecutionStatus; detail: Record<string, unknown> }>> {
  const results: Array<{ stepId: string; status: ExecutionStatus; detail: Record<string, unknown> }> = [];
  for (const hook of webhooks) {
    let status: ExecutionStatus = "completed";
    let detail: Record<string, unknown> = { url: hook.url, method: hook.method };
    try {
      // Snapshot de fluxo pode ter sido criado antes da denylist: reforca o
      // bloqueio em runtime (falha = log "failed", sem fetch).
      assertPublicWebhookUrl(hook.url);
      // SSRF residual (DNS rebinding/TOFU): host público no snapshot pode
      // resolver para IP interno. Resolve antes do fetch e rejeita se QUALQUER
      // endereço cair em faixa interna — o fetch nem começa.
      const resolved = await dnsPromises.lookup(new URL(hook.url).hostname, { all: true });
      if (resolved.some(isInternalResolvedAddress)) throw new Error("Webhook bloqueado: host resolve para IP interno");
      const response = await fetch(hook.url, {
        method: hook.method,
        headers: hook.body ? { "content-type": "application/json" } : undefined,
        body: hook.body ?? undefined,
        // 3xx nunca é seguido: o destino do redirect não passou pelo mesmo
        // bloqueio e poderia apontar para host interno.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000)
      });
      detail = { ...detail, http_status: response.status };
      if (response.status >= 300 && response.status < 400) {
        status = "failed";
        detail = { ...detail, motivo: "redirect" };
      } else if (!response.ok) {
        status = "failed";
      }
    } catch (error) {
      status = "failed";
      detail = { ...detail, erro: error instanceof Error ? error.message : String(error) };
    }
    results.push({ stepId: hook.stepId, status, detail });
    await logExecutionBestEffort(ctx, { id: hook.stepId, kind: "action" }, status, detail);
    if (status === "failed") {
      logger.warn({ tenantId: ctx.tenantId, flowId: ctx.flowId, stepId: hook.stepId, detail }, "Qualification flow webhook failed");
    }
  }
  return results;
}

export interface FlowSimulateTraceItem { node_id: string; kind: string; result: string; next: string | null }

/**
 * Dry-run em memória (lição 2: grafo em memória, zero N+1 e zero efeito colateral).
 * Consome o texto de entrada na primeira etapa que pede input e segue o fluxo
 * determinístico até parar em uma pergunta/espera/final.
 */
export function simulateFlow(definition: FlowDefinition, text: string, maxSteps = 50): FlowSimulateTraceItem[] {
  const trace: FlowSimulateTraceItem[] = [];
  const vars: FlowVars = {};
  const visited = new Set<string>();
  let stepId: string | undefined = definition.start;
  let inputPending = text.trim();
  for (let index = 0; index < maxSteps && stepId; index++) {
    const step: FlowStep | undefined = definition.steps[stepId];
    if (!step) {
      trace.push({ node_id: stepId, kind: "desconhecida", result: "etapa inexistente", next: null });
      return trace;
    }
    if (visited.has(stepId)) {
      trace.push({ node_id: stepId, kind: step.kind, result: "ciclo detectado — execução interrompida", next: null });
      return trace;
    }
    visited.add(stepId);
    switch (step.kind) {
      case "final":
        trace.push({ node_id: stepId, kind: step.kind, result: renderFinalMessage(step, vars), next: null });
        return trace;
      case "finalize":
        trace.push({ node_id: stepId, kind: step.kind, result: `encerra o fluxo (${step.end_reason ?? "sem motivo"})`, next: null });
        return trace;
      case "branch":
      case "condition": {
        const outcome = evaluateCondition(step, vars) ? "yes" : "no";
        trace.push({ node_id: stepId, kind: step.kind, result: `${step.variable_name ?? "?"} ${step.operator ?? "?"} ${conditionValueHidden(step.operator) ? "(sem valor)" : step.value ?? ""} → ${outcome}`, next: step.transitions?.[outcome] ?? null });
        if (!step.transitions?.[outcome]) {
          trace.push({ node_id: stepId, kind: step.kind, result: `saída "${outcome}" sem destino`, next: null });
          return trace;
        }
        stepId = step.transitions[outcome] as string;
        continue;
      }
      case "interactive":
        trace.push({ node_id: stepId, kind: step.kind, result: renderInteractivePreview(step, vars), next: null });
        return trace;
      case "message":
        trace.push({ node_id: stepId, kind: step.kind, result: renderTemplate(step.message ?? "", vars), next: step.next ?? null });
        stepId = step.next;
        continue;
      case "delay":
        trace.push({ node_id: stepId, kind: step.kind, result: `espera ${step.wait_minutes} min`, next: step.next ?? null });
        stepId = step.next;
        continue;
      case "wait_for_reply":
        if (inputPending) {
          if (step.variable_name) vars[step.variable_name] = inputPending.slice(0, 200);
          trace.push({
            node_id: stepId, kind: step.kind,
            result: step.variable_name ? `resposta registrada em ${step.variable_name}` : "resposta recebida",
            next: step.next ?? null
          });
          inputPending = "";
          stepId = step.next;
          continue;
        }
        trace.push({ node_id: stepId, kind: step.kind, result: `aguardando resposta (timeout ${step.timeout_minutes} min)`, next: null });
        return trace;
      case "action":
        trace.push({ node_id: stepId, kind: step.kind, result: describeAction(step), next: step.next ?? null });
        stepId = step.next;
        continue;
      default:
        if (inputPending) {
          const value = matchAnswer(step, inputPending);
          if (value) {
            if (step.field) vars[step.field] = value;
            trace.push({ node_id: stepId, kind: step.kind, result: `resposta aceita: ${value}`, next: nextStepId(step, value) ?? null });
            inputPending = "";
            stepId = nextStepId(step, value);
            continue;
          }
        }
        trace.push({ node_id: stepId, kind: step.kind, result: "aguardando resposta", next: null });
        return trace;
    }
  }
  trace.push({ node_id: stepId ?? "?", kind: "desconhecida", result: `limite de ${maxSteps} etapas atingido`, next: null });
  return trace;
}

function describeAction(step: FlowStep): string {
  switch (step.action_type) {
    case "tag_add": return `adicionar ${(step.tag_ids ?? []).length} tag(s)`;
    case "tag_remove": return `remover ${(step.tag_ids ?? []).length} tag(s)`;
    case "stage_move": return "mover lead de estágio";
    case "assign_agent": return "atribuir responsável";
    case "webhook": return `webhook ${step.method ?? "POST"} ${step.webhook_url ?? ""}`;
    default: return "ação desconhecida";
  }
}

export class QualificationService {
  async handleInbound(input: QualificationInbound, aiClassify?: AiOptionClassifier): Promise<QualificationOutcome | null> {
    const channel = await db.query<{ channel: string; timezone: string | null }>(
      `SELECT s.channel,t.timezone FROM whatsapp_sessions s JOIN tenants t ON t.id=s.tenant_id
       WHERE s.id=$1 AND s.tenant_id=$2 AND s.archived_at IS NULL`, [input.sessionId, input.tenantId]
    );
    if (channel.rows[0]?.channel !== "whatsapp") return null;
    const timezone = channel.rows[0].timezone;
    const snapshot = await db.query<StateRow>(
      `SELECT q.id,q.lead_id,q.flow_id,q.current_step,q.status,q.answers,q.pending_value,q.ask_pending,
              q.last_inbound_external_id,q.definition_snapshot,q.wait_until,q.wait_session_id,
              c.id conversation_id,c.assigned_user_id,l.name lead_name,
              f.allowed_role_ids flow_allowed_role_ids
       FROM scheduling_leads l
       JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id
       JOIN qualification_flows f ON f.id=q.flow_id AND f.tenant_id=q.tenant_id
       JOIN conversations c ON c.lead_id=l.id AND c.tenant_id=l.tenant_id
       WHERE l.tenant_id=$1 AND l.phone=$2 AND c.session_id=$3`,
      [input.tenantId, input.contactPhone, input.sessionId]
    );
    const state = snapshot.rows[0];
    if (!state) return this.startFlow(input, timezone);
    if (state.status === "concluido") return null;
    if (state.status === "pausado") {
      // Pausado: com humano dono da conversa o fluxo fica calado ({reply:null});
      // sem humano responsável, cai no turno de IA (return null).
      return state.assigned_user_id ? { reply: null } : null;
    }
    if (state.last_inbound_external_id === input.externalId) return this.pendingForInbound(input.tenantId, state.id, input.externalId);

    const definition = parseDefinition(input.tenantId, state.definition_snapshot);
    if (!definition) return null;
    const step = definition.steps[state.current_step];
    if (!step || step.kind === "final") return null;

    // C1-c: gating de execução por papel do responsável do lead. Bloqueado =
    // robô calado (turno de IA assume) + log skipped role_not_allowed.
    if (!(await flowRoleAllowed(db, input.tenantId, state.lead_id, state.flow_allowed_role_ids))) {
      await logExecutionBestEffort(
        { tenantId: input.tenantId, flowId: state.flow_id, leadId: state.lead_id, conversationId: state.conversation_id },
        { id: state.current_step, kind: step.kind },
        "skipped",
        { motivo: "role_not_allowed" }
      );
      return null;
    }

    if (state.wait_until && step.kind === "wait_for_reply") {
      return this.consumeWaitReply(input, state, definition, step, timezone);
    }
    if (state.wait_until) {
      // Em delay o fluxo é determinístico: mensagem do contato não antecipa a retomada.
      return { reply: null };
    }

    const vars = flowVars(state.answers, { name: state.lead_name, phone: input.contactPhone }, timezone);
    if (state.ask_pending) {
      return this.applyPrompt(input, state, { pendingValue: state.pending_value, askPending: false }, renderQuestion(step, vars), "question");
    }
    if (state.pending_value) {
      const confirmation = classifyBoolean(input.text);
      if (confirmation === "SIM") return this.acceptAnswer(input, state, definition, step, state.pending_value, input.text, timezone);
      if (confirmation === "NÃO") return this.applyPrompt(input, state, { pendingValue: null, askPending: false }, `Sem problemas! ${renderQuestion(step, vars)}`, "question");
      return this.applyPrompt(input, state, { pendingValue: state.pending_value, askPending: false }, confirmationPrompt(state.pending_value), "confirmation");
    }

    // Nó interactive: a resposta do contato casa com as escolhas (botões/linhas)
    // por um passo virtual options=interactiveChoices(step) — roteamento segue
    // via transitions[value] ?? next; o passo REAL mantém kind/log/renderização.
    const isInteractive = step.kind === "interactive";
    const matchStep: FlowStep = isInteractive ? { ...step, kind: "options", options: interactiveChoices(step) } : step;
    const candidates = matchAnswerCandidates(matchStep, input.text);
    const value = candidates.length > 1 ? null : matchAnswer(matchStep, input.text);
    if (value) return this.acceptAnswer(input, state, definition, matchStep, value, input.text, timezone, step.kind);

    // IA só classifica perguntas com opções estruturadas — NÃO escolhas de nó
    // interactive (a escolha é do toque no botão/linha, não heurística de texto).
    if (candidates.length <= 1 && aiClassify && step.kind !== "text" && step.kind !== "interactive" && step.options?.length) {
      const candidate = await aiClassify(step.question ?? "", step.options.map((option) => option.value), input.text).catch(() => null);
      const valid = candidate ? step.options.find((option) => normalizeText(option.value) === normalizeText(candidate)) : undefined;
      if (valid) return this.applyPrompt(input, state, { pendingValue: valid.value, askPending: false }, confirmationPrompt(valid.value), "confirmation");
    }
    return this.applyPrompt(input, state, { pendingValue: null, askPending: false }, clarifyPrompt(step, candidates, vars), "clarification");
  }

  async pauseForConversation(tenantId: string, conversationId: string, reason: string): Promise<boolean> {
    const found = await withTransaction(async (client) => {
      const conversation = await client.query<{ contact_phone: string }>(
        `UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
         WHERE tenant_id=$1 AND id=$2 RETURNING contact_phone`, [tenantId, conversationId]
      );
      if (!conversation.rows[0]) return false;
      await pauseQualificationByConversation(client, tenantId, conversationId, reason);
      return true;
    });
    logger.info({ tenantId, conversationId, reason }, "Qualification paused for human conversation action");
    return found;
  }

  async setFlowAction(tenantId: string, leadId: string, action: "pause" | "resume" | "restart") {
    return withTransaction(async (client) => {
      const current = await client.query<{ id: string; status: QualificationStatus; current_step: string; definition_snapshot: unknown; phone: string }>(
        `SELECT q.id,q.status,q.current_step,q.definition_snapshot,l.phone FROM lead_qualifications q
         JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id
         WHERE q.tenant_id=$1 AND q.lead_id=$2 FOR UPDATE OF q`, [tenantId, leadId]
      );
      const row = current.rows[0];
      if (!row) throw httpError(404, "Lead não possui formulário de qualificação");
      const definition = parseDefinition(tenantId, row.definition_snapshot);
      if (!definition) throw httpError(500, "Snapshot do fluxo de qualificação inválido");
      const event = (type: string, details: Record<string, unknown> = {}) => client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,$3,$4)", [leadId, tenantId, type, details]
      );

      if (action === "pause") {
        if (row.status !== "em_andamento") throw httpError(409, "Formulário não está em andamento");
        await client.query("UPDATE lead_qualifications SET status='pausado',updated_at=now() WHERE id=$1", [row.id]);
        await client.query("UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL WHERE tenant_id=$1 AND lead_id=$2 AND session_id IN (SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp')", [tenantId, leadId]);
        await event("formulario_pausado", { motivo: "manual" });
        return { status: "pausado", etapa_atual: row.current_step };
      }
      if (action === "resume") {
        if (row.status !== "pausado") throw httpError(409, "Formulário não está pausado");
        await client.query("UPDATE lead_qualifications SET status='em_andamento',ask_pending=true,updated_at=now() WHERE id=$1", [row.id]);
        await client.query("UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL WHERE tenant_id=$1 AND lead_id=$2 AND session_id IN (SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp')", [tenantId, leadId]);
        await event("formulario_retomado");
        return { status: "em_andamento", etapa_atual: row.current_step, pergunta_atual: renderQuestion(definition.steps[row.current_step]) };
      }
      await client.query(
        `UPDATE lead_qualifications SET status='em_andamento',current_step=$2,answers='{}',history='[]',pending_value=NULL,
         ask_pending=true,wait_until=NULL,faturamento=NULL,investimento=NULL,instagram=NULL,resultado_final=NULL,classificacao=NULL,
         answered_count=0,total_questions=$3,last_inbound_external_id=NULL,updated_at=now() WHERE id=$1`,
        [row.id, definition.start, totalQuestions(definition)]
      );
      await client.query("UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL WHERE tenant_id=$1 AND lead_id=$2 AND session_id IN (SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp')", [tenantId, leadId]);
      await event("formulario_reiniciado");
      return { status: "em_andamento", etapa_atual: definition.start, pergunta_atual: renderQuestion(definition.steps[definition.start]) };
    });
  }

  /**
   * Retomada de uma espera vencida (delay/wait_for_reply). Chamada pelo worker
   * BullMQ e pelo reconciliador; revalida o estado sob lock de linha (lição do
   * legado: nunca confiar no job sozinho — o estado pode ter mudado ao acordar).
   */
  async processDueWait(data: QualificationWaitJob): Promise<{ processed: boolean; reason?: string }> {
    type DueWaitResult = {
      processed: boolean; reason?: string;
      outcome?: QualificationOutcome; walk?: WalkOutput; ctx?: WalkContext; vars?: FlowVars;
    };
    const result = await withTransaction<DueWaitResult>(async (client) => {
      const snapshot = await client.query<{
        id: string; tenant_id: string; lead_id: string; flow_id: string; current_step: string; status: QualificationStatus;
        wait_until: Date | null; wait_session_id: string | null; answers: Record<string, string>; definition_snapshot: unknown;
        lead_phone: string; lead_name: string | null; conversation_id: string | null; contact_phone: string | null; contact_jid: string | null;
        timezone: string | null; flow_allowed_role_ids: unknown;
      }>(
        `SELECT q.id,q.tenant_id,q.lead_id,q.flow_id,q.current_step,q.status,q.wait_until,q.wait_session_id,q.answers,q.definition_snapshot,
                l.phone lead_phone,l.name lead_name,c.id conversation_id,c.contact_phone,c.contact_jid,t.timezone,
                f.allowed_role_ids flow_allowed_role_ids
         FROM lead_qualifications q
         JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id AND l.deleted_at IS NULL
         JOIN qualification_flows f ON f.id=q.flow_id AND f.tenant_id=q.tenant_id
         LEFT JOIN conversations c ON c.tenant_id=q.tenant_id AND c.lead_id=q.lead_id AND c.session_id=q.wait_session_id
         JOIN tenants t ON t.id=q.tenant_id
         WHERE q.id=$1 AND q.tenant_id=$2 FOR UPDATE OF q`, [data.qualificationId, data.tenantId]
      );
      const state = snapshot.rows[0];
      if (!state) {
        // Snapshot vazio porque o lead foi para a lixeira (0171): a espera
        // nunca retoma. Cancela a qualificação em estado terminal para o
        // reconciliador não reprocessar a cada tick; o filtro l.deleted_at
        // IS NULL acima garante o mesmo gate para o agendamento da retomada.
        const orphaned = await client.query<{ flow_id: string; lead_id: string; current_step: string }>(
          `SELECT q.flow_id,q.lead_id,q.current_step
           FROM lead_qualifications q
           JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id AND l.deleted_at IS NOT NULL
           WHERE q.id=$1 AND q.tenant_id=$2`,
          [data.qualificationId, data.tenantId]
        );
        if (!orphaned.rows[0]) return { processed: false, reason: "state_missing" };
        await client.query(
          "UPDATE lead_qualifications SET status='concluido',wait_until=NULL,wait_session_id=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2",
          [data.qualificationId, data.tenantId]
        );
        await logExecutionBestEffort(
          { tenantId: data.tenantId, flowId: orphaned.rows[0].flow_id, leadId: orphaned.rows[0].lead_id, conversationId: null },
          { id: orphaned.rows[0].current_step, kind: "wait" },
          "skipped",
          { motivo: "lead_deleted" }
        );
        return { processed: false, reason: "lead_deleted" };
      }
      if (state.status !== "em_andamento" || !state.wait_until) return { processed: false, reason: "not_waiting" };
      if (state.wait_until.getTime() > Date.now() + 5_000) return { processed: false, reason: "not_due" };

      const definition = parseDefinition(state.tenant_id, state.definition_snapshot);
      if (!definition) {
        await client.query("UPDATE lead_qualifications SET wait_until=NULL,updated_at=now() WHERE id=$1", [state.id]);
        return { processed: false, reason: "definition_invalid" };
      }
      const step = definition.steps[state.current_step];
      if (!step || (step.kind !== "delay" && step.kind !== "wait_for_reply")) {
        await client.query("UPDATE lead_qualifications SET wait_until=NULL,updated_at=now() WHERE id=$1", [state.id]);
        return { processed: false, reason: "not_a_wait_step" };
      }
      const target = step.kind === "delay" ? step.next : step.on_timeout;
      const ctx = this.waitContext(state, `flow:${state.id}:${state.current_step}`);
      if (!target || !definition.steps[target]) {
        await client.query("UPDATE lead_qualifications SET wait_until=NULL,updated_at=now() WHERE id=$1", [state.id]);
        await logExecution(client, ctx, { id: state.current_step, kind: step.kind }, "failed", { motivo: "destino_da_espera_inexistente" });
        return { processed: false, reason: "missing_target" };
      }
      // C1-c: papel do responsável saiu da allowlist desde o agendamento — a
      // espera é cancelada (sem reprocessamento infinito do reconciliador) e
      // o nó fica registrado como skipped; a retomada futura é por inbound.
      if (!(await flowRoleAllowed(client, state.tenant_id, state.lead_id, state.flow_allowed_role_ids))) {
        await client.query("UPDATE lead_qualifications SET wait_until=NULL,updated_at=now() WHERE id=$1", [state.id]);
        await logExecution(client, ctx, { id: state.current_step, kind: step.kind }, "skipped", { motivo: "role_not_allowed" });
        return { processed: false, reason: "role_not_allowed" };
      }

      await logExecution(client, ctx, { id: state.current_step, kind: step.kind }, "completed", { motivo: "timeout" });
      const vars = flowVars(state.answers ?? {}, { name: state.lead_name, phone: state.lead_phone }, state.timezone);
      const walk = await this.walkFlow(client, ctx, definition, vars, target);
      await this.persistWalkState(client, ctx, { qualificationId: state.id, answers: state.answers ?? {} }, walk, state.wait_session_id, null, definition);
      const outcome = await this.queueWalkMessages(client, ctx, state.id, walk.messages);
      return { processed: true, outcome, walk, ctx, vars };
    });
    const { processed, reason, walk, ctx } = result;
    if (processed && walk?.webhooks.length && ctx) {
      void fireFlowWebhooks(walk.webhooks, ctx).catch((error) => logger.warn({ error }, "Qualification flow webhook dispatch failed"));
    }
    this.scheduleWalkResume(processed ? walk ?? null : null, processed ? ctx ?? null : null);
    return { processed, reason };
  }

  async listPendingOutbox(limit = 100): Promise<OutboxRow[]> {
    const result = await db.query<OutboxRow>(
      `SELECT id,tenant_id,qualification_id,step_id,session_id,contact_phone,contact_jid,message,inbound_external_id,message_kind,interactive_payload
       FROM qualification_message_outbox
       WHERE status='pending' AND next_attempt_at<=now() AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes')
         AND EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.id=qualification_message_outbox.session_id
           AND s.tenant_id=qualification_message_outbox.tenant_id AND s.channel='whatsapp' AND s.archived_at IS NULL)
       ORDER BY created_at LIMIT $1`, [limit]
    );
    return result.rows;
  }

  async deliverOutbox(row: OutboxRow, gateway: MessageGateway): Promise<string> {
    const claimed = await db.query<OutboxRow>(
      `UPDATE qualification_message_outbox SET claimed_at=now()
       WHERE id=$1 AND status='pending' AND next_attempt_at<=now()
         AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes')
         AND EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.id=qualification_message_outbox.session_id
           AND s.tenant_id=qualification_message_outbox.tenant_id AND s.channel='whatsapp' AND s.archived_at IS NULL)
       RETURNING id,tenant_id,qualification_id,step_id,session_id,contact_phone,contact_jid,message,inbound_external_id,message_kind,interactive_payload`, [row.id]
    );
    if (!claimed.rows[0]) return "";
    const current = claimed.rows[0];
    const interactive = current.message_kind === "interactive" && current.interactive_payload
      ? current.interactive_payload as unknown as InteractivePayload
      : null;
    try {
      let sent: { externalId: string };
      let interactiveDetail: Record<string, unknown> = {};
      if (interactive) {
        // C1-h: mensagem interativa sai por sendInteractive. Sem o método no
        // gateway = capability indisponível → degradação segura: falha
        // definitiva (sem retry infinito) + log do executor; UI esconde o nó.
        if (!gateway.sendInteractive) {
          await db.query(
            "UPDATE qualification_message_outbox SET status='failed',last_error=$2,claimed_at=NULL WHERE id=$1 AND status='pending'",
            [current.id, "capability_indisponivel"]
          );
          await this.logInteractiveDelivery(current, "failed", { motivo: "capability_indisponivel" });
          return "";
        }
        sent = await gateway.sendInteractive(current.session_id, current.contact_jid ?? current.contact_phone, interactive);
        interactiveDetail = { payload_kind: interactive.kind };
      } else {
        sent = await gateway.sendText(current.session_id, current.contact_jid ?? current.contact_phone, current.message);
      }
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE qualification_message_outbox SET status='sent',external_message_id=$2,sent_at=now(),last_error=NULL,claimed_at=NULL
           WHERE id=$1 AND status='pending'`, [current.id, sent.externalId]
        );
        const outboundKey=`${current.tenant_id}:${current.session_id}:${sent.externalId}`;
        await client.query(
          `INSERT INTO messages(conversation_id,sender,content,ai_model_used,external_message_id,provider_message_key)
           SELECT c.id,'agent',$4,'qualification-flow',$5,$6 FROM conversations c
           WHERE c.tenant_id=$1 AND c.session_id=$2 AND c.contact_phone=$3
           ON CONFLICT(provider_message_key) DO UPDATE SET sender='agent',content=EXCLUDED.content,ai_model_used='qualification-flow'`,
          [current.tenant_id,current.session_id,current.contact_phone,current.message,sent.externalId,outboundKey]
        );
        await client.query(
          `UPDATE messages SET processed_at=now() WHERE sender='contact' AND provider_message_key=$1`,
          [`${current.tenant_id}:${current.session_id}:${current.inbound_external_id}`]
        );
      });
      if (interactive) await this.logInteractiveDelivery(current, "completed", interactiveDetail);
      return sent.externalId;
    } catch (error) {
      if (interactive) await this.logInteractiveDelivery(current, "failed", { erro: error instanceof Error ? error.message : String(error) });
      await db.query(
        `UPDATE qualification_message_outbox SET attempts=attempts+1,last_error=$2,claimed_at=NULL,
         status=CASE WHEN $3::boolean THEN 'pending' ELSE 'failed' END,
         next_attempt_at=CASE WHEN $3::boolean THEN now() + make_interval(secs => LEAST(300, power(2,LEAST(attempts,8))::int)) ELSE next_attempt_at END
         WHERE id=$1 AND status='pending'`, [current.id, error instanceof Error ? error.message : String(error), isWhatsAppSendRejectedError(error)]
      );
      throw error;
    }
  }

  async deliverOutboxById(id: string, gateway: MessageGateway): Promise<string | null> {
    const result = await db.query<OutboxRow>(
      "SELECT id,tenant_id,qualification_id,step_id,session_id,contact_phone,contact_jid,message,inbound_external_id,message_kind,interactive_payload FROM qualification_message_outbox WHERE id=$1 AND status='pending'",
      [id]
    );
    return result.rows[0] ? this.deliverOutbox(result.rows[0], gateway) : null;
  }

  /**
   * Log do executor (flow_execution_log) para a entrega da mensagem interativa.
   * Best-effort: a outbox não depende desta linha; conversa resolvida não fica
   * disponível aqui (row não a carrega) — lead/fluxo vêm da qualificação.
   */
  private async logInteractiveDelivery(row: OutboxRow, status: ExecutionStatus, detail: Record<string, unknown>): Promise<void> {
    if (!row.qualification_id) return;
    try {
      const state = await db.query<{ lead_id: string; flow_id: string }>(
        "SELECT lead_id,flow_id FROM lead_qualifications WHERE id=$1 AND tenant_id=$2", [row.qualification_id, row.tenant_id]
      );
      if (!state.rows[0]) return;
      await logExecutionBestEffort(
        { tenantId: row.tenant_id, flowId: state.rows[0].flow_id, leadId: state.rows[0].lead_id, conversationId: null },
        { id: row.step_id ?? "interactive", kind: "interactive" },
        status,
        detail
      );
    } catch {
      // Log é diagnóstico; nunca bloqueia a entrega.
    }
  }

  private async pendingForInbound(tenantId: string, qualificationId: string, externalId: string): Promise<QualificationOutcome> {
    const pending = await db.query<{ id: string; message: string }>(
      `SELECT id,message FROM qualification_message_outbox
       WHERE tenant_id=$1 AND qualification_id=$2 AND inbound_external_id=$3 AND status='pending'
         AND message_kind <> 'interactive'
       ORDER BY created_at DESC LIMIT 1`, [tenantId, qualificationId, externalId]
    );
    return pending.rows[0] ? { reply: pending.rows[0].message, outboxId: pending.rows[0].id } : { reply: null };
  }

  private async startFlow(input: QualificationInbound, timezone: string | null): Promise<QualificationOutcome | null> {
    const flowRow = await db.query<{ id: string; definition: unknown; allowed_role_ids: unknown }>(
      "SELECT id,definition,allowed_role_ids FROM qualification_flows WHERE tenant_id=$1 AND active ORDER BY updated_at DESC LIMIT 1", [input.tenantId]
    );
    if (!flowRow.rows[0]) return null;
    const definition = parseDefinition(input.tenantId, flowRow.rows[0].definition);
    if (!definition) return null;
    const trigger = matchTrigger(definition, input);
    if (!trigger) return null;
    const result = await withTransaction(async (client) => {
      const existingLead = await client.query<{ id: string; conversation_id: string }>(
        `SELECT l.id,c.id conversation_id FROM scheduling_leads l
         JOIN conversations c ON c.lead_id=l.id AND c.tenant_id=l.tenant_id
         WHERE l.tenant_id=$1 AND c.session_id=$3
           AND regexp_replace(l.phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
         ORDER BY l.created_at,l.id LIMIT 1 FOR UPDATE OF l`,
        [input.tenantId, input.contactPhone, input.sessionId]
      );
      const lead = existingLead.rows[0]
        ? await client.query<{ id: string; created: boolean }>(
            `UPDATE scheduling_leads
             SET name=COALESCE(name,$3),updated_at=now()
             WHERE tenant_id=$1 AND id=$2
             RETURNING id,false created`,
            [input.tenantId, existingLead.rows[0].id, input.contactName ?? null]
          )
        : await client.query<{ id: string; created: boolean }>(
            `INSERT INTO scheduling_leads(tenant_id,phone,name,source)
             VALUES($1,$2,$3,$4)
             RETURNING id,true created`,
            [input.tenantId, input.contactPhone, input.contactName ?? null, definition.origem]
          );
      const leadId = lead.rows[0].id;
      await ensureCaseAssignment(client, {
        tenantId: input.tenantId,
        selector: { leadId },
        reason: "lead_criado"
      });
      // C1-c: gating por papel — o fluxo NEM COMEÇA quando o responsável do
      // lead não está em allowed_role_ids (vazio = sem restrição). Log skipped
      // e turno de IA assume (outcome null).
      if (!(await flowRoleAllowed(client, input.tenantId, leadId, flowRow.rows[0].allowed_role_ids))) {
        await logExecutionBestEffort(
          { tenantId: input.tenantId, flowId: flowRow.rows[0].id, leadId, conversationId: existingLead.rows[0]?.conversation_id ?? null },
          { id: definition.start, kind: "gate" },
          "skipped",
          { motivo: "role_not_allowed" }
        );
        return { outcome: null as QualificationOutcome | null, walk: null, ctx: null, vars: null };
      }
      const tenant = await client.query<{ product: string }>(
        "SELECT COALESCE(NULLIF(slug,''), NULLIF(name,''), id::text) AS product FROM tenants WHERE id=$1",
        [input.tenantId]
      );
      const assigned = attribution(input, tenant.rows[0]?.product ?? input.tenantId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO lead_qualifications
          (tenant_id,lead_id,flow_id,current_step,total_questions,last_inbound_external_id,definition_snapshot,trigger_type,attribution)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,lead_id) DO NOTHING RETURNING id`,
        [input.tenantId, leadId, flowRow.rows[0].id, definition.start, totalQuestions(definition), input.externalId, definition, trigger, assigned]
      );
      if (!inserted.rows[0]) return { outcome: { reply: null } as QualificationOutcome, walk: null, ctx: null, vars: null };
      if (lead.rows[0].created) await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,new_status,details) VALUES($1,$2,'lead_criado','novo',$3)",
        [leadId, input.tenantId, { origem: definition.origem }]
      );
      await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_iniciado',$3)",
        [leadId, input.tenantId, { fluxo: flowRow.rows[0].id, gatilho: trigger, atribuicao: assigned }]
      );
      const ctx: WalkContext = {
        tenantId: input.tenantId,
        qualificationId: inserted.rows[0].id,
        leadId,
        flowId: flowRow.rows[0].id,
        conversationId: existingLead.rows[0]?.conversation_id ?? null,
        sessionId: input.sessionId,
        contactPhone: input.contactPhone,
        contactJid: input.contactJid ?? null,
        externalId: input.externalId,
        timezone
      };
      const vars = flowVars({}, { name: input.contactName, phone: input.contactPhone }, timezone);
      const walk = await this.walkFlow(client, ctx, definition, vars, definition.start, [], definition.intro ?? null);
      if (walk.restStep !== definition.start || walk.waitUntil) {
        await client.query(
          "UPDATE lead_qualifications SET current_step=$3,wait_until=$4,wait_session_id=CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE $5::uuid END,updated_at=now() WHERE id=$1 AND tenant_id=$2",
          [inserted.rows[0].id, input.tenantId, walk.restStep, walk.waitUntil, input.sessionId]
        );
      }
      const outcome = await this.queueWalkMessages(client, ctx, inserted.rows[0].id, walk.messages);
      return { outcome, walk, ctx, vars };
    });
    const { outcome, walk, ctx } = result;
    if (walk?.webhooks.length && ctx) {
      void fireFlowWebhooks(walk.webhooks, ctx).catch((error) => logger.warn({ error }, "Qualification flow webhook dispatch failed"));
    }
    this.scheduleWalkResume(walk, ctx);
    return outcome;
  }

  private async applyPrompt(input: QualificationInbound, state: StateRow, next: { pendingValue: string | null; askPending: boolean }, reply: string, kind: OutboxKind): Promise<QualificationOutcome> {
    return withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE lead_qualifications SET pending_value=$4,ask_pending=$5,last_inbound_external_id=$3,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status='em_andamento' AND current_step=$6 AND last_inbound_external_id IS DISTINCT FROM $3 RETURNING id`,
        [state.id, input.tenantId, input.externalId, next.pendingValue, next.askPending, state.current_step]
      );
      return updated.rows[0] ? this.queueSingleMessage(client, input, state.id, state.current_step, kind, reply) : { reply: null };
    });
  }

  /**
   * Resposta recebida enquanto o fluxo aguarda em wait_for_reply. Serializada com
   * a retomada por timeout (lock de linha + revalidação de wait_until): quem
   * chegar primeiro consome a espera, o outro vira no-op (lição da corrida).
   */
  private async consumeWaitReply(input: QualificationInbound, state: StateRow, definition: FlowDefinition, step: FlowStep, timezone: string | null): Promise<QualificationOutcome | null> {
    const text = input.text.trim();
    const ctx: WalkContext = {
      tenantId: input.tenantId,
      qualificationId: state.id,
      leadId: state.lead_id,
      flowId: state.flow_id,
      conversationId: state.conversation_id,
      sessionId: input.sessionId,
      contactPhone: input.contactPhone,
      contactJid: input.contactJid ?? null,
      externalId: input.externalId,
      timezone
    };
    const vars = flowVars(state.answers ?? {}, { name: state.lead_name, phone: input.contactPhone }, timezone);
    const result = await withTransaction(async (client) => {
      const fresh = await client.query<{ status: string; current_step: string; wait_until: Date | null; last_inbound_external_id: string | null }>(
        "SELECT status,current_step,wait_until,last_inbound_external_id FROM lead_qualifications WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [state.id, input.tenantId]
      );
      const row = fresh.rows[0];
      if (!row || row.status !== "em_andamento" || row.current_step !== state.current_step || !row.wait_until || row.last_inbound_external_id === input.externalId) {
        return null;
      }
      if (!text && !step.on_invalid_reply) {
        await logExecution(client, ctx, { id: state.current_step, kind: step.kind }, "skipped", { motivo: "resposta_vazia_sem_destino" });
        return { outcome: { reply: null } as QualificationOutcome, walk: null, ctx, vars };
      }
      await logExecution(client, ctx, { id: state.current_step, kind: step.kind }, "completed", { resposta: text || "(vazia)" });
      const answers = step.variable_name && text ? { ...state.answers, [step.variable_name]: text.slice(0, 200) } : state.answers ?? {};
      const historyEntries = text ? [{ etapa: state.current_step, campo: step.variable_name ?? null, resposta: input.text, valor: text, em: new Date().toISOString() }] : [];
      const walk = await this.walkFlow(client, ctx, definition, { ...vars, ...answers }, text ? step.next as string : step.on_invalid_reply as string, historyEntries);
      await this.persistWalkState(client, ctx, { qualificationId: state.id, answers }, walk, input.sessionId, input.externalId, definition);
      const outcome = await this.queueWalkMessages(client, ctx, state.id, walk.messages);
      return { outcome, walk, ctx, vars };
    });
    const { outcome, walk } = result ?? { outcome: null, walk: null };
    if (walk?.webhooks.length && ctx) {
      void fireFlowWebhooks(walk.webhooks, ctx).catch((error) => logger.warn({ error }, "Qualification flow webhook dispatch failed"));
    }
    this.scheduleWalkResume(walk, ctx);
    return outcome;
  }

  private async acceptAnswer(input: QualificationInbound, state: StateRow, definition: FlowDefinition, step: FlowStep, value: string, rawText: string, timezone: string | null, logKind?: string): Promise<QualificationOutcome> {
    const targetId = nextStepId(step, value);
    if (!targetId || !definition.steps[targetId]) return { reply: null };
    const answers = { ...state.answers, ...(step.field ? { [step.field]: value } : {}) };
    const historyEntry = { etapa: state.current_step, campo: step.field ?? null, resposta: rawText, valor: value, em: new Date().toISOString() };
    const vars = flowVars(answers, { name: state.lead_name, phone: input.contactPhone }, timezone);
    const ctx: WalkContext = {
      tenantId: input.tenantId,
      qualificationId: state.id,
      leadId: state.lead_id,
      flowId: state.flow_id,
      conversationId: state.conversation_id,
      sessionId: input.sessionId,
      contactPhone: input.contactPhone,
      contactJid: input.contactJid ?? null,
      externalId: input.externalId,
      timezone
    };

    const result = await withTransaction(async (client) => {
      const fresh = await client.query<{ current_step: string; status: string; last_inbound_external_id: string | null }>(
        "SELECT current_step,status,last_inbound_external_id FROM lead_qualifications WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [state.id, input.tenantId]
      );
      const row = fresh.rows[0];
      if (!row || row.status !== "em_andamento" || row.current_step !== state.current_step || row.last_inbound_external_id === input.externalId) return null;

      await logExecution(client, ctx, { id: state.current_step, kind: logKind ?? step.kind }, "completed", { valor: value, resposta: rawText });
      const walk = await this.walkFlow(client, ctx, definition, vars, targetId, [historyEntry]);
      const answeredCount = Object.keys(answers).length;
      await client.query(
        `UPDATE lead_qualifications SET current_step=$3,status=$4,answers=$5::jsonb,history=history||$6::jsonb,
         pending_value=NULL,ask_pending=false,wait_until=$7,wait_session_id=CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE $16::uuid END,
         faturamento=COALESCE($8,faturamento),investimento=COALESCE($9,investimento),
         instagram=COALESCE($10,instagram),resultado_final=COALESCE($11,resultado_final),classificacao=COALESCE($12,classificacao),
         answered_count=$13,total_questions=$14,last_inbound_external_id=$15,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [state.id, input.tenantId, walk.restStep, walk.concludo ? "concluido" : "em_andamento", JSON.stringify(answers), JSON.stringify([historyEntry]),
          walk.waitUntil,
          step.field === "faturamento" ? value : null, step.field === "investimento" ? value : null,
          step.field === "instagram" ? value : null, walk.concludo ? walk.concludo.resultado : null, walk.concludo ? walk.concludo.classificacao : null,
          answeredCount, answeredCount + remainingQuestions(definition, walk.restStep), input.externalId, input.sessionId]
      );
      await client.query("UPDATE scheduling_leads SET updated_at=now() WHERE id=$1 AND tenant_id=$2", [state.lead_id, input.tenantId]);
      await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_resposta',$3)",
        [state.lead_id, input.tenantId, { etapa: state.current_step, campo: step.field ?? null, valor: value }]
      );
      if (walk.concludo) await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_concluido',$3)",
        [state.lead_id, input.tenantId, { resultado: walk.concludo.resultado, classificacao: walk.concludo.classificacao }]
      );
      const outcome = await this.queueWalkMessages(client, ctx, state.id, walk.messages);
      return { outcome, walk, ctx, vars };
    });
    if (!result) return { reply: null };
    const { outcome, walk } = result;
    if (walk.webhooks.length) {
      void fireFlowWebhooks(walk.webhooks, ctx).catch((error) => logger.warn({ error }, "Qualification flow webhook dispatch failed"));
    }
    this.scheduleWalkResume(walk, ctx);
    return outcome;
  }

  /**
   * Caminha pelo grafo executando etapas que não pedem input do contato
   * (message/action seguem sozinhas; delay/wait_for_reply agendam retomada;
   * pergunta/final param). Cap de 50 etapas com erro EXPLÍCITO no log (lição 4).
   */
  private async walkFlow(
    client: PoolClient,
    ctx: WalkContext,
    definition: FlowDefinition,
    vars: FlowVars,
    fromStepId: string,
    historyEntries: Record<string, unknown>[] = [],
    intro: string | null = null
  ): Promise<WalkOutput> {
    const output: WalkOutput = {
      restStep: fromStepId, status: "em_andamento", waitUntil: null, messages: [], webhooks: [], historyEntries, concludo: null, stoppedReason: null
    };
    let stepId = fromStepId;
    let prefix = intro ? `${intro}\n\n` : "";
    const visited = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const step = definition.steps[stepId];
      if (!step) {
        output.stoppedReason = "missing_step";
        await logExecution(client, ctx, { id: stepId, kind: "desconhecida" }, "failed", { motivo: "etapa_inexistente" });
        return output;
      }
      if (visited.has(stepId)) {
        output.stoppedReason = "cycle";
        await logExecution(client, ctx, { id: stepId, kind: step.kind }, "failed", { motivo: "ciclo_detectado", etapa: stepId });
        logger.error({ tenantId: ctx.tenantId, flowId: ctx.flowId, leadId: ctx.leadId, stepId }, "Qualification flow cycle detected during walk");
        return output;
      }
      visited.add(stepId);
      output.restStep = stepId;
      switch (step.kind) {
        case "final": {
          output.messages.push({ stepId, kind: "final", text: prefix + renderFinalMessage(step, vars) });
          prefix = "";
          output.concludo = { resultado: stepId, classificacao: step.classificacao ?? null };
          output.status = "concluido";
          output.stoppedReason = "final";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "completed", { classificacao: step.classificacao ?? null });
          return output;
        }
        case "message": {
          output.messages.push({ stepId, kind: "message", text: prefix + renderTemplate(step.message ?? "", vars) });
          prefix = "";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "completed", {});
          stepId = step.next as string;
          continue;
        }
        case "action": {
          if (step.action_type === "webhook") {
            const body = step.method === "GET" ? null : step.template ? renderTemplate(step.template, vars) : JSON.stringify(vars);
            output.webhooks.push({ stepId, url: step.webhook_url as string, method: step.method ?? "POST", body });
            await logExecution(client, ctx, { id: stepId, kind: step.kind }, "entered", { url: step.webhook_url, method: step.method ?? "POST" });
          } else {
            const result = await this.runAction(client, ctx, step);
            await logExecution(client, ctx, { id: stepId, kind: step.kind }, result.ok ? "completed" : "failed", result.detail);
          }
          stepId = step.next as string;
          continue;
        }
        case "delay": {
          output.waitUntil = new Date(Date.now() + (step.wait_minutes as number) * 60_000);
          output.stoppedReason = "wait";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "waiting", { ate: output.waitUntil.toISOString(), minutos: step.wait_minutes });
          return output;
        }
        case "wait_for_reply": {
          if (step.message) output.messages.push({ stepId, kind: "message", text: prefix + renderTemplate(step.message, vars) });
          prefix = "";
          output.waitUntil = new Date(Date.now() + (step.timeout_minutes as number) * 60_000);
          output.stoppedReason = "wait";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "waiting", {
            ate: output.waitUntil.toISOString(), timeout_minutos: step.timeout_minutes, variavel: step.variable_name ?? null
          });
          return output;
        }
        case "branch":
        case "condition": {
          // C1-a: avaliação no mesmo mecanismo de variáveis do fluxo (respostas
          // anteriores + nome/telefone/data). Saídas yes/no vindas do snapshot;
          // destino inexistente = falha explícita (mesma semântica de missing_step).
          const outcome = evaluateCondition(step, vars) ? "yes" : "no";
          const target = step.transitions?.[outcome];
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "completed", {
            resultado: outcome, variavel: step.variable_name ?? null, operador: step.operator ?? null, valor: step.value ?? null
          });
          if (!target || !definition.steps[target]) {
            output.stoppedReason = "missing_step";
            await logExecution(client, ctx, { id: stepId, kind: step.kind }, "failed", { motivo: "destino_da_condicao_inexistente", resultado: outcome });
            return output;
          }
          stepId = target;
          continue;
        }
        case "finalize": {
          // C1-a: encerra sem enviar mensagem — end_reason vira resultado_final
          // (o autor usa nós message antes do finalize quando quer despedida).
          output.concludo = { resultado: step.end_reason ?? "finalizado", classificacao: null };
          output.status = "concluido";
          output.stoppedReason = "final";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "completed", { end_reason: step.end_reason ?? null });
          return output;
        }
        case "interactive": {
          // C1-h: para aguardando a escolha do contato; o payload estruturado
          // segue na outbox e sai por sendInteractive (capability-gated).
          output.messages.push({
            stepId, kind: "interactive",
            text: prefix + renderInteractivePreview(step, vars),
            interactive: interactivePayload(step, vars) as Record<string, unknown>
          });
          prefix = "";
          output.stoppedReason = "input";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "entered", { tipo: step.interactive_type ?? null });
          return output;
        }
        default: {
          // kinds de pergunta: o fluxo aguarda input — 'entered' fica no histórico
          // e o 'completed' é gravado quando a resposta é aceita.
          output.messages.push({ stepId, kind: "question", text: prefix + renderQuestion(step, vars) });
          prefix = "";
          output.stoppedReason = "input";
          await logExecution(client, ctx, { id: stepId, kind: step.kind }, "entered", { campo: step.field ?? null });
          return output;
        }
      }
    }
    output.stoppedReason = "cap";
    await logExecution(client, ctx, { id: stepId, kind: definition.steps[stepId]?.kind ?? "desconhecida" }, "failed", { motivo: "cap_50_etapas" });
    logger.error(
      { tenantId: ctx.tenantId, flowId: ctx.flowId, leadId: ctx.leadId, stepId },
      "Qualification flow hit the 50-step cap; execution stopped to avoid an infinite loop"
    );
    return output;
  }

  private async runAction(client: PoolClient, ctx: WalkContext, step: FlowStep): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
    switch (step.action_type) {
      case "tag_add": {
        const applied = await client.query<{ tag_id: string }>(
          `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id)
           SELECT $1,$2,t.id FROM lead_tags t WHERE t.tenant_id=$1 AND t.id=ANY($3::uuid[]) AND t.archived_at IS NULL
           ON CONFLICT DO NOTHING RETURNING tag_id`, [ctx.tenantId, ctx.leadId, step.tag_ids ?? []]
        );
        return { ok: true, detail: { acao: "tag_add", aplicadas: applied.rowCount, solicitadas: (step.tag_ids ?? []).length } };
      }
      case "tag_remove": {
        const removed = await client.query(
          "DELETE FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=ANY($3::uuid[])",
          [ctx.tenantId, ctx.leadId, step.tag_ids ?? []]
        );
        return { ok: true, detail: { acao: "tag_remove", removidas: removed.rowCount } };
      }
      case "stage_move": {
        const moved = await client.query<{ id: string }>(
          `UPDATE scheduling_leads l SET pipeline_stage_id=$3,updated_at=now()
           WHERE l.id=$2 AND l.tenant_id=$1
             AND EXISTS (SELECT 1 FROM pipeline_stages s WHERE s.tenant_id=$1 AND s.id=$3 AND s.archived_at IS NULL AND s.technical_status=l.status)
           RETURNING id`, [ctx.tenantId, ctx.leadId, step.stage_id]
        );
        return moved.rows[0]
          ? { ok: true, detail: { acao: "stage_move", stage_id: step.stage_id } }
          : { ok: false, detail: { acao: "stage_move", motivo: "estagio_invalido_para_status_atual" } };
      }
      case "assign_agent": {
        const assigned = await client.query<{ assigned_member_id: string }>(
          `UPDATE scheduling_leads l SET assigned_member_id=$3,updated_at=now()
           WHERE l.id=$2 AND l.tenant_id=$1
             AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=$1 AND m.id=$3 AND m.status='active')
           RETURNING assigned_member_id`, [ctx.tenantId, ctx.leadId, step.agent_id]
        );
        return assigned.rows[0]
          ? { ok: true, detail: { acao: "assign_agent", agent_id: step.agent_id } }
          : { ok: false, detail: { acao: "assign_agent", motivo: "agente_invalido" } };
      }
      default:
        return { ok: false, detail: { motivo: "acao_desconhecida" } };
    }
  }

  /** Agenda a retomada BullMQ de uma espera (best-effort; reconciliador cobre falha). */
  private scheduleWalkResume(walk: WalkOutput | null, ctx: WalkContext | null): void {
    if (!walk?.waitUntil || !ctx) return;
    void enqueueQualificationWait(
      { tenantId: ctx.tenantId, qualificationId: ctx.qualificationId, stepId: walk.restStep },
      Math.max(0, walk.waitUntil.getTime() - Date.now())
    ).catch((error) => logger.warn(
      { error, tenantId: ctx.tenantId, qualificationId: ctx.qualificationId },
      "Qualification wait enqueue failed; database reconciler will recover"
    ));
  }

  /** Contexto de execução para retomadas proativas (sem inbound). */
  private waitContext(
    state: {
      id: string; tenant_id: string; lead_id: string; flow_id: string; lead_phone: string;
      conversation_id: string | null; contact_phone: string | null; contact_jid: string | null; wait_session_id: string | null; timezone: string | null;
    },
    externalId: string
  ): WalkContext {
    return {
      tenantId: state.tenant_id,
      qualificationId: state.id,
      leadId: state.lead_id,
      flowId: state.flow_id,
      conversationId: state.conversation_id,
      sessionId: state.wait_session_id ?? "",
      contactPhone: state.contact_phone ?? state.lead_phone,
      contactJid: state.contact_jid,
      externalId,
      timezone: state.timezone
    };
  }

  /** Persiste o resultado do caminho (etapa de repouso, espera, respostas e conclusão). */
  private async persistWalkState(
    client: PoolClient,
    ctx: WalkContext,
    base: { qualificationId: string; answers: Record<string, string> },
    walk: WalkOutput,
    sessionId: string | null,
    externalId: string | null,
    definition: FlowDefinition
  ): Promise<void> {
    const answeredCount = Object.keys(base.answers).length;
    await client.query(
      `UPDATE lead_qualifications SET current_step=$3,status=$4,answers=$5::jsonb,
         history=CASE WHEN $6::jsonb = '[]'::jsonb THEN history ELSE history||$6::jsonb END,
         pending_value=NULL,ask_pending=false,wait_until=$7,
         wait_session_id=CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE $8::uuid END,
         resultado_final=COALESCE($9,resultado_final),classificacao=COALESCE($10,classificacao),
         answered_count=$11,total_questions=$12,last_inbound_external_id=COALESCE($13,last_inbound_external_id),updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [base.qualificationId, ctx.tenantId, walk.restStep, walk.status, JSON.stringify(base.answers), JSON.stringify(walk.historyEntries),
        walk.waitUntil, sessionId, walk.concludo ? walk.concludo.resultado : null, walk.concludo ? walk.concludo.classificacao : null,
        answeredCount, answeredCount + remainingQuestions(definition, walk.restStep), externalId]
    );
  }

  /** Enfileira uma mensagem na outbox existente (caminho de inbound). */
  private async queueSingleMessage(
    client: PoolClient,
    input: QualificationInbound,
    qualificationId: string,
    stepId: string,
    kind: OutboxKind,
    message: string
  ): Promise<QualificationOutcome> {
    const queued = await client.query<{ id: string }>(
      `INSERT INTO qualification_message_outbox
         (tenant_id,qualification_id,session_id,contact_phone,contact_jid,step_id,inbound_external_id,message_kind,message)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (qualification_id,step_id,inbound_external_id,message_kind) DO UPDATE SET message=EXCLUDED.message
       RETURNING id`,
      [input.tenantId, qualificationId, input.sessionId, input.contactPhone, input.contactJid ?? null, stepId, input.externalId, kind, message]
    );
    return { reply: message, outboxId: queued.rows[0]?.id };
  }

  /**
   * Enfileira todas as mensagens produzidas por um caminho. A primeira volta
   * inline ao chamador; as demais são entregues pela outbox (worker existente).
   */
  private async queueWalkMessages(
    client: PoolClient,
    ctx: WalkContext,
    qualificationId: string,
    messages: WalkMessage[]
  ): Promise<QualificationOutcome> {
    let first: QualificationOutcome = { reply: null };
    for (const message of messages) {
      try {
        const queued = await client.query<{ id: string }>(
          `INSERT INTO qualification_message_outbox
             (tenant_id,qualification_id,session_id,contact_phone,contact_jid,step_id,inbound_external_id,message_kind,message,interactive_payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (qualification_id,step_id,inbound_external_id,message_kind)
           DO UPDATE SET message=EXCLUDED.message,interactive_payload=EXCLUDED.interactive_payload
           RETURNING id`,
          [ctx.tenantId, qualificationId, ctx.sessionId, ctx.contactPhone, ctx.contactJid ?? null, message.stepId, ctx.externalId, message.kind, message.text, message.interactive ?? null]
        );
        // Interactive NUNCA vai inline: precisa do sendInteractive (payload
        // estruturado) que só a outbox roteia — o caminho inline é sendText.
        if (first.reply === null && message.kind !== "interactive") first = { reply: message.text, outboxId: queued.rows[0]?.id };
      } catch (error) {
        // Corrida de retomada (23505): outro walk enfileirou a mesma linha —
        // trata como no-op e o walk continua.
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
    return first;
  }
}

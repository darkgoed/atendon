import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import type { MessageGateway, MessageReferral } from "../messages/types.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import {
  flowDefinitionSchema, nextStepId, remainingQuestions, renderFinalMessage, renderQuestion, totalQuestions,
  type FlowDefinition, type FlowStep
} from "./flow.js";
import { classifyBoolean, matchAnswer, matchAnswerCandidates, normalizeText } from "./normalizer.js";
import { ensureCaseAssignment } from "../assignments/service.js";

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
type OutboxKind = "question" | "clarification" | "confirmation" | "final";

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
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  session_id: string;
  contact_phone: string;
  contact_jid: string | null;
  message: string;
  inbound_external_id: string;
}

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

function clarifyPrompt(step: FlowStep, candidates: string[] = []): string {
  if (candidates.length > 1) return `Sua resposta parece indicar mais de uma opção (${candidates.join(" ou ")}). Qual delas você quer escolher?\n${renderQuestion(step)}`;
  if (step.field === "instagram") return "Não consegui validar esse Instagram. Envie @usuario, um link do Instagram ou responda “não possui”.";
  if (step.kind === "boolean") return `Não consegui entender 🙈 Consegue me responder com Sim ou Não? ${step.question}`;
  return `Não consegui identificar direitinho 🙈 ${renderQuestion(step)}`;
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
  const text = normalizeText(input.text);
  if (definition.triggers.keywords.some((keyword) => text.includes(normalizeText(keyword)))) return "keyword";
  return null;
}

function attribution(input: QualificationInbound): Record<string, unknown> {
  return {
    provider: "meta",
    channel: "facebook",
    product: "newave",
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

async function queueOutbox(client: PoolClient, input: QualificationInbound, qualificationId: string, stepId: string, kind: OutboxKind, message: string): Promise<QualificationOutcome> {
  const queued = await client.query<{ id: string; message: string }>(
    `INSERT INTO qualification_message_outbox
       (tenant_id,qualification_id,session_id,contact_phone,contact_jid,step_id,inbound_external_id,message_kind,message)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (qualification_id,step_id,inbound_external_id) DO UPDATE SET message=EXCLUDED.message
     RETURNING id,message`,
    [input.tenantId, qualificationId, input.sessionId, input.contactPhone, input.contactJid ?? null, stepId, input.externalId, kind, message]
  );
  return { reply: queued.rows[0].message, outboxId: queued.rows[0].id };
}

async function pauseQualificationByPhone(client: PoolClient, tenantId: string, contactPhone: string, reason: string): Promise<void> {
  const paused = await client.query<{ lead_id: string }>(
    `UPDATE lead_qualifications q SET status='pausado',updated_at=now()
     FROM scheduling_leads l
     WHERE l.id=q.lead_id AND l.tenant_id=q.tenant_id AND q.tenant_id=$1 AND l.phone=$2 AND q.status='em_andamento'
     RETURNING q.lead_id`, [tenantId, contactPhone]
  );
  if (paused.rows[0]) await client.query(
    "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_pausado',$3)",
    [paused.rows[0].lead_id, tenantId, { motivo: reason }]
  );
}

export class QualificationService {
  async handleInbound(input: QualificationInbound, aiClassify?: AiOptionClassifier): Promise<QualificationOutcome | null> {
    const snapshot = await db.query<StateRow>(
      `SELECT q.id,q.lead_id,q.flow_id,q.current_step,q.status,q.answers,q.pending_value,q.ask_pending,
              q.last_inbound_external_id,q.definition_snapshot
       FROM scheduling_leads l
       JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id
       WHERE l.tenant_id=$1 AND l.phone=$2`,
      [input.tenantId, input.contactPhone]
    );
    const state = snapshot.rows[0];
    if (!state) return this.startFlow(input);
    if (state.status === "concluido") return null;
    if (state.status === "pausado") return { reply: null };
    if (state.last_inbound_external_id === input.externalId) return this.pendingForInbound(input.tenantId, state.id, input.externalId);

    const definition = parseDefinition(input.tenantId, state.definition_snapshot);
    if (!definition) return null;
    const step = definition.steps[state.current_step];
    if (!step || step.kind === "final") return null;

    if (state.ask_pending) {
      return this.applyPrompt(input, state, { pendingValue: state.pending_value, askPending: false }, renderQuestion(step), "question");
    }
    if (state.pending_value) {
      const confirmation = classifyBoolean(input.text);
      if (confirmation === "SIM") return this.acceptAnswer(input, state, definition, step, state.pending_value, input.text);
      if (confirmation === "NÃO") return this.applyPrompt(input, state, { pendingValue: null, askPending: false }, `Sem problemas! ${renderQuestion(step)}`, "question");
      return this.applyPrompt(input, state, { pendingValue: state.pending_value, askPending: false }, confirmationPrompt(state.pending_value), "confirmation");
    }

    const candidates = matchAnswerCandidates(step, input.text);
    const value = candidates.length > 1 ? null : matchAnswer(step, input.text);
    if (value) return this.acceptAnswer(input, state, definition, step, value, input.text);

    if (candidates.length <= 1 && aiClassify && step.kind !== "text" && step.options?.length) {
      const candidate = await aiClassify(step.question ?? "", step.options.map((option) => option.value), input.text).catch(() => null);
      const valid = candidate ? step.options.find((option) => normalizeText(option.value) === normalizeText(candidate)) : undefined;
      if (valid) return this.applyPrompt(input, state, { pendingValue: valid.value, askPending: false }, confirmationPrompt(valid.value), "confirmation");
    }
    return this.applyPrompt(input, state, { pendingValue: null, askPending: false }, clarifyPrompt(step, candidates), "clarification");
  }

  async pauseForHuman(tenantId: string, contactPhone: string): Promise<void> {
    await withTransaction(async (client) => {
      await client.query("UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, contactPhone]);
      await pauseQualificationByPhone(client, tenantId, contactPhone, "atendimento_humano");
    });
  }

  async pauseForConversation(tenantId: string, conversationId: string, reason: string): Promise<boolean> {
    const found = await withTransaction(async (client) => {
      const conversation = await client.query<{ contact_phone: string }>(
        `UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
         WHERE tenant_id=$1 AND id=$2 RETURNING contact_phone`, [tenantId, conversationId]
      );
      if (!conversation.rows[0]) return false;
      await pauseQualificationByPhone(client, tenantId, conversation.rows[0].contact_phone, reason);
      return true;
    });
    logger.info({ tenantId, conversationId, reason }, "Qualification paused for human conversation action");
    return found;
  }

  async claimConversation(tenantId: string, conversationId: string, userId: string): Promise<"claimed" | "conflict" | "missing"> {
    return withTransaction(async (client) => {
      const claimed = await client.query<{ contact_phone: string }>(
        `UPDATE conversations SET assigned_user_id=$3,claimed_at=COALESCE(claimed_at,now()),status='open',resolved_at=NULL,
           ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
         WHERE id=$1 AND tenant_id=$2 AND (assigned_user_id IS NULL OR assigned_user_id=$3)
         RETURNING contact_phone`, [conversationId, tenantId, userId]
      );
      if (!claimed.rows[0]) {
        const exists = await client.query("SELECT 1 FROM conversations WHERE id=$1 AND tenant_id=$2", [conversationId, tenantId]);
        return exists.rows[0] ? "conflict" : "missing";
      }
      await pauseQualificationByPhone(client, tenantId, claimed.rows[0].contact_phone, "conversation_claimed");
      return "claimed";
    });
  }

  async assignConversation(tenantId: string, conversationId: string, userId: string | null): Promise<{ found: boolean; previousUserId: string | null }> {
    return withTransaction(async (client) => {
      const current = await client.query<{ assigned_user_id: string | null; contact_phone: string }>(
        "SELECT assigned_user_id,contact_phone FROM conversations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [conversationId, tenantId]
      );
      if (!current.rows[0]) return { found: false, previousUserId: null };
      await client.query(
        `UPDATE conversations SET assigned_user_id=$3,
           claimed_at=CASE WHEN $3::uuid IS NULL THEN NULL WHEN assigned_user_id IS DISTINCT FROM $3 THEN now() ELSE claimed_at END,
           status='open',resolved_at=NULL,
           ai_active=CASE WHEN $3::uuid IS NULL THEN ai_active ELSE false END,
           handoff_reason=CASE WHEN $3::uuid IS NULL THEN handoff_reason ELSE 'manually_paused' END,
           handoff_error_code=CASE WHEN $3::uuid IS NULL THEN handoff_error_code ELSE NULL END
         WHERE id=$1 AND tenant_id=$2`, [conversationId, tenantId, userId]
      );
      if (userId) await pauseQualificationByPhone(client, tenantId, current.rows[0].contact_phone, "conversation_assigned");
      return { found: true, previousUserId: current.rows[0].assigned_user_id };
    });
  }

  async resumeForConversation(tenantId: string, conversationId: string): Promise<void> {
    await withTransaction(async (client) => {
      const current = await client.query<{ contact_phone: string; lead_id: string | null }>(
        `SELECT c.contact_phone,l.id lead_id FROM conversations c
         LEFT JOIN scheduling_leads l ON l.tenant_id=c.tenant_id AND l.phone=c.contact_phone
         WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE OF c`, [tenantId, conversationId]
      );
      if (!current.rows[0]) throw httpError(404, "Conversa não encontrada");
      await client.query("UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, conversationId]);
      if (!current.rows[0].lead_id) return;
      const resumed = await client.query(
        "UPDATE lead_qualifications SET status='em_andamento',ask_pending=true,updated_at=now() WHERE tenant_id=$1 AND lead_id=$2 AND status='pausado' RETURNING id",
        [tenantId, current.rows[0].lead_id]
      );
      if (resumed.rows[0]) await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_retomado',$3)",
        [current.rows[0].lead_id, tenantId, { origem: "conversa" }]
      );
    });
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
        await client.query("UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, row.phone]);
        await event("formulario_pausado", { motivo: "manual" });
        return { status: "pausado", etapa_atual: row.current_step };
      }
      if (action === "resume") {
        if (row.status !== "pausado") throw httpError(409, "Formulário não está pausado");
        await client.query("UPDATE lead_qualifications SET status='em_andamento',ask_pending=true,updated_at=now() WHERE id=$1", [row.id]);
        await client.query("UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, row.phone]);
        await event("formulario_retomado");
        return { status: "em_andamento", etapa_atual: row.current_step, pergunta_atual: renderQuestion(definition.steps[row.current_step]) };
      }
      await client.query(
        `UPDATE lead_qualifications SET status='em_andamento',current_step=$2,answers='{}',history='[]',pending_value=NULL,
         ask_pending=true,faturamento=NULL,investimento=NULL,instagram=NULL,resultado_final=NULL,classificacao=NULL,
         answered_count=0,total_questions=$3,last_inbound_external_id=NULL,updated_at=now() WHERE id=$1`,
        [row.id, definition.start, totalQuestions(definition)]
      );
      await client.query("UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, row.phone]);
      await event("formulario_reiniciado");
      return { status: "em_andamento", etapa_atual: definition.start, pergunta_atual: renderQuestion(definition.steps[definition.start]) };
    });
  }

  async listPendingOutbox(limit = 100): Promise<OutboxRow[]> {
    const result = await db.query<OutboxRow>(
      `SELECT id,tenant_id,session_id,contact_phone,contact_jid,message,inbound_external_id FROM qualification_message_outbox
       WHERE status='pending' AND next_attempt_at<=now() AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes')
       ORDER BY created_at LIMIT $1`, [limit]
    );
    return result.rows;
  }

  async deliverOutbox(row: OutboxRow, gateway: MessageGateway): Promise<string> {
    const claimed = await db.query<OutboxRow>(
      `UPDATE qualification_message_outbox SET claimed_at=now()
       WHERE id=$1 AND status='pending' AND next_attempt_at<=now()
         AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes')
       RETURNING id,tenant_id,session_id,contact_phone,contact_jid,message,inbound_external_id`, [row.id]
    );
    if (!claimed.rows[0]) return "";
    const current = claimed.rows[0];
    try {
      const sent = await gateway.sendText(current.session_id, current.contact_jid ?? current.contact_phone, current.message);
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
      return sent.externalId;
    } catch (error) {
      await db.query(
        `UPDATE qualification_message_outbox SET attempts=attempts+1,last_error=$2,claimed_at=NULL,
         next_attempt_at=now() + make_interval(secs => LEAST(300, power(2,LEAST(attempts,8))::int))
         WHERE id=$1 AND status='pending'`, [current.id, error instanceof Error ? error.message : String(error)]
      );
      throw error;
    }
  }

  async deliverOutboxById(id: string, gateway: MessageGateway): Promise<string | null> {
    const result = await db.query<OutboxRow>(
      "SELECT id,tenant_id,session_id,contact_phone,contact_jid,message,inbound_external_id FROM qualification_message_outbox WHERE id=$1 AND status='pending'",
      [id]
    );
    return result.rows[0] ? this.deliverOutbox(result.rows[0], gateway) : null;
  }

  private async pendingForInbound(tenantId: string, qualificationId: string, externalId: string): Promise<QualificationOutcome> {
    const pending = await db.query<{ id: string; message: string }>(
      `SELECT id,message FROM qualification_message_outbox
       WHERE tenant_id=$1 AND qualification_id=$2 AND inbound_external_id=$3 AND status='pending'
       ORDER BY created_at DESC LIMIT 1`, [tenantId, qualificationId, externalId]
    );
    return pending.rows[0] ? { reply: pending.rows[0].message, outboxId: pending.rows[0].id } : { reply: null };
  }

  private async startFlow(input: QualificationInbound): Promise<QualificationOutcome | null> {
    const flowRow = await db.query<{ id: string; definition: unknown }>(
      "SELECT id,definition FROM qualification_flows WHERE tenant_id=$1 AND active ORDER BY updated_at DESC LIMIT 1", [input.tenantId]
    );
    if (!flowRow.rows[0]) return null;
    const definition = parseDefinition(input.tenantId, flowRow.rows[0].definition);
    if (!definition) return null;
    const trigger = matchTrigger(definition, input);
    if (!trigger) return null;
    const firstStep = definition.steps[definition.start];

    return withTransaction(async (client) => {
      const existingLead = await client.query<{ id: string }>(
        `SELECT id FROM scheduling_leads
         WHERE tenant_id=$1
           AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
         ORDER BY created_at,id
         LIMIT 1
         FOR UPDATE`,
        [input.tenantId, input.contactPhone]
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
      const assigned = attribution(input);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO lead_qualifications
          (tenant_id,lead_id,flow_id,current_step,total_questions,last_inbound_external_id,definition_snapshot,trigger_type,attribution)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,lead_id) DO NOTHING RETURNING id`,
        [input.tenantId, leadId, flowRow.rows[0].id, definition.start, totalQuestions(definition), input.externalId, definition, trigger, assigned]
      );
      if (!inserted.rows[0]) return { reply: null };
      if (lead.rows[0].created) await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,new_status,details) VALUES($1,$2,'lead_criado','novo',$3)",
        [leadId, input.tenantId, { origem: definition.origem }]
      );
      await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_iniciado',$3)",
        [leadId, input.tenantId, { fluxo: flowRow.rows[0].id, gatilho: trigger, atribuicao: assigned }]
      );
      const question = definition.intro ? `${definition.intro}\n\n${renderQuestion(firstStep)}` : renderQuestion(firstStep);
      return queueOutbox(client, input, inserted.rows[0].id, definition.start, "question", question);
    });
  }

  private async applyPrompt(input: QualificationInbound, state: StateRow, next: { pendingValue: string | null; askPending: boolean }, reply: string, kind: OutboxKind): Promise<QualificationOutcome> {
    return withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE lead_qualifications SET pending_value=$4,ask_pending=$5,last_inbound_external_id=$3,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status='em_andamento' AND current_step=$6 AND last_inbound_external_id IS DISTINCT FROM $3 RETURNING id`,
        [state.id, input.tenantId, input.externalId, next.pendingValue, next.askPending, state.current_step]
      );
      return updated.rows[0] ? queueOutbox(client, input, state.id, state.current_step, kind, reply) : { reply: null };
    });
  }

  private async acceptAnswer(input: QualificationInbound, state: StateRow, definition: FlowDefinition, step: FlowStep, value: string, rawText: string): Promise<QualificationOutcome> {
    const targetId = nextStepId(step, value);
    const nextStep = targetId ? definition.steps[targetId] : undefined;
    if (!targetId || !nextStep) return { reply: null };
    const isFinal = nextStep.kind === "final";
    const answers = { ...state.answers, ...(step.field ? { [step.field]: value } : {}) };
    const historyEntry = { etapa: state.current_step, campo: step.field ?? null, resposta: rawText, valor: value, em: new Date().toISOString() };
    const outbound = isFinal ? renderFinalMessage(nextStep) : renderQuestion(nextStep);

    return withTransaction(async (client) => {
      const fresh = await client.query<{ current_step: string; status: string; last_inbound_external_id: string | null }>(
        "SELECT current_step,status,last_inbound_external_id FROM lead_qualifications WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [state.id, input.tenantId]
      );
      const row = fresh.rows[0];
      if (!row || row.status !== "em_andamento" || row.current_step !== state.current_step || row.last_inbound_external_id === input.externalId) return { reply: null };
      const answeredCount = Object.keys(answers).length;
      const pathTotal = answeredCount + remainingQuestions(definition, targetId);
      await client.query(
        `UPDATE lead_qualifications SET current_step=$3,status=$4,answers=$5::jsonb,history=history||$6::jsonb,
         pending_value=NULL,ask_pending=false,faturamento=COALESCE($7,faturamento),investimento=COALESCE($8,investimento),
         instagram=COALESCE($9,instagram),resultado_final=COALESCE($10,resultado_final),classificacao=COALESCE($11,classificacao),
         answered_count=$12,total_questions=$13,last_inbound_external_id=$14,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [state.id, input.tenantId, targetId, isFinal ? "concluido" : "em_andamento", JSON.stringify(answers), JSON.stringify([historyEntry]),
          step.field === "faturamento" ? value : null, step.field === "investimento" ? value : null,
          step.field === "instagram" ? value : null, isFinal ? targetId : null, isFinal ? nextStep.classificacao ?? null : null,
          answeredCount, pathTotal, input.externalId]
      );
      await client.query("UPDATE scheduling_leads SET updated_at=now() WHERE id=$1 AND tenant_id=$2", [state.lead_id, input.tenantId]);
      await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_resposta',$3)",
        [state.lead_id, input.tenantId, { etapa: state.current_step, campo: step.field ?? null, valor: value }]
      );
      if (isFinal) await client.query(
        "INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details) VALUES($1,$2,'formulario_concluido',$3)",
        [state.lead_id, input.tenantId, { resultado: targetId, classificacao: nextStep.classificacao ?? null }]
      );
      return queueOutbox(client, input, state.id, targetId, isFinal ? "final" : "question", outbound);
    });
  }
}

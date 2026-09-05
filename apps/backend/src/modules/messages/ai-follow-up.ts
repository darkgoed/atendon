import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import type { AiRouter } from "../ai-router/openrouter.js";
import { protectedSystemPrompt } from "../ai-router/prompt-guard.js";
import { decryptSecret } from "../ai-router/secret-box.js";
import {
  AI_HANDOFF_MARKER,
  parseAgentHandoff,
  unauthorizedAgentHandoffCorrection
} from "./handoff.js";
import {
  acquireConversationLock,
  composingDuration,
  DEFAULT_HUMANIZER_CONFIG,
  extendConversationLock,
  humanizedDelay,
  migrateHumanizerConfig,
  randomBetween,
  releaseConversationLock,
  sanitizeOutbound,
  sleep,
  splitResponse,
  type HumanizerConfig
} from "./humanizer.js";
import type { MessageGateway } from "./types.js";
import type { FollowUpDelivery } from "./follow-up-media.js";
import { consumeAiInteraction, reconcileAiTurnFromUsageLogs } from "../../billing/ai-consumption.js";
import { deriveBillingTurnId } from "../../billing/turn-id.js";
import { logger } from "../../logger.js";

const HISTORY_MAX_MESSAGES = 40;
const HISTORY_MAX_CHARACTERS = 12_000;
const PROCESSING_LEASE_MINUTES = 10;
const MAX_FAILURES = 5;
export const AI_FOLLOW_UP_NOT_NEEDED_MARKER = "[[NO_FOLLOW_UP_NEEDED]]";

export interface AiFollowUpClaim {
  conversationId: string;
  agentConfigVersionId: string;
  tenantId: string;
  sessionId: string;
  contactPhone: string;
  contactJid?: string;
  contactName?: string;
  sequenceVersion: number;
  followUpCount: number;
  maxCount: number;
  delaysMinutes: number[];
  delivery: FollowUpDelivery & {
    name?: string;
    description?: string;
    mimeType?: string;
    fileName?: string;
    sizeBytes?: number;
    dataBase64?: string;
  };
  model: string;
  provider?: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  openRouterApiKey?: string;
  humanizer?: HumanizerConfig;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

type FollowUpRow = {
  conversation_id: string;
  tenant_id: string;
  session_id: string;
  contact_phone: string;
  contact_jid: string | null;
  contact_name: string | null;
  ai_active: boolean;
  conversation_status: string;
  status: "scheduled" | "processing" | "cancelled" | "completed" | "failed";
  next_run_at: Date | null;
  processing_started_at: Date | null;
  follow_up_count: number;
  sequence_version: number;
  last_agent_message_id: string;
  latest_message_id: string | null;
  latest_sender: string | null;
  ai_follow_up_enabled: boolean;
  ai_follow_up_max_count: number;
  ai_follow_up_interval_minutes: number;
  ai_follow_up_delays_minutes: number[];
  ai_follow_up_delivery: unknown;
  agent_config_version_id: string | null;
  system_prompt: string | null;
  ai_model: string | null;
  model_params: { temperature?: number; max_tokens?: number } | null;
  agent_is_active: boolean | null;
  active_appointment: boolean;
  openrouter_provider: string | null;
  openrouter_api_key_encrypted: string | null;
  humanizer_config: HumanizerConfig | null;
};

function selectedDelivery(value: unknown, index: number): FollowUpDelivery {
  if (!Array.isArray(value)) return { type: "text" };
  const selected = value[index];
  if (!selected || typeof selected !== "object") return { type: "text" };
  const record = selected as Record<string, unknown>;
  if ((record.type === "image" || record.type === "sticker" || record.type === "audio" || record.type === "video")
    && typeof record.assetId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.assetId)) {
    return { type: record.type, assetId: record.assetId };
  }
  return { type: "text" };
}

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

const TOPIC_STOP_WORDS = new Set([
  "a", "ao", "aos", "as", "ate", "com", "como", "da", "das", "de", "do", "dos", "e", "ela", "ele",
  "em", "entre", "essa", "essas", "esse", "esses", "esta", "estas", "este", "estes", "eu", "fica", "ficam",
  "foi", "for", "mais", "mas", "me", "na", "nas", "no", "nos", "o", "os", "ou", "para", "por", "pra",
  "que", "se", "ser", "so", "sua", "suas", "te", "tem", "ter", "tu", "um", "uma", "voce", "voces"
]);

function topicWords(text: string): Set<string> {
  return new Set(normalizedWords(text).filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word)));
}

function topicBigrams(text: string): Set<string> {
  const words = normalizedWords(text).filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word));
  return new Set(words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`));
}

function lastUserMessageIndex(history: AiFollowUpClaim["history"]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") return index;
  }
  return -1;
}

/**
 * Detects whether two differently worded messages are still about the same
 * narrow pending subject. This is intentionally stricter than a general
 * semantic matcher: it requires either three meaningful shared terms or a
 * shared two-word topic expression such as "ticket medio".
 */
export function isSameFollowUpTopic(left: string, right: string): boolean {
  const leftWords = topicWords(left);
  const rightWords = topicWords(right);
  if (Math.min(leftWords.size, rightWords.size) < 2) return false;

  let overlap = 0;
  for (const word of leftWords) if (rightWords.has(word)) overlap += 1;
  if (overlap >= 3 && overlap / Math.min(leftWords.size, rightWords.size) >= 0.55) return true;
  if (overlap < 2) return false;

  const rightBigrams = topicBigrams(right);
  return [...topicBigrams(left)].some((bigram) => rightBigrams.has(bigram));
}

function unansweredAssistantMessages(history: AiFollowUpClaim["history"]): string[] {
  const lastContactIndex = lastUserMessageIndex(history);
  return history
    .slice(lastContactIndex + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter(Boolean);
}

export function hasAlreadyRetriedSameTopic(history: AiFollowUpClaim["history"]): boolean {
  const unanswered = unansweredAssistantMessages(history);
  if (unanswered.length < 2) return false;
  return isSameFollowUpTopic(unanswered.at(-2)!, unanswered.at(-1)!);
}

function compactContextText(text: string, maxCharacters = 500): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxCharacters ? compact : `${compact.slice(0, maxCharacters - 1).trimEnd()}…`;
}

/** Factual continuity snapshot; it deliberately contains no behavioral instruction. */
export function followUpContinuityContext(history: AiFollowUpClaim["history"]): string {
  const lastContactIndex = lastUserMessageIndex(history);
  const lastContact = lastContactIndex >= 0 ? history[lastContactIndex]?.content : undefined;
  const unanswered = unansweredAssistantMessages(history);
  const attempts = unanswered.slice(-3).map((message, index) => `${index + 1}. ${compactContextText(message)}`);

  return `CONTEXTO DE CONTINUIDADE OBSERVADO:
- Última mensagem real do contato: ${lastContact ? `"${compactContextText(lastContact)}"` : "não disponível no recorte"}
- Mensagens do atendimento depois dela, ainda sem nova resposta do contato: ${unanswered.length}
${attempts.length ? `- Retomadas mais recentes sem resposta:\n${attempts.join("\n")}` : "- Ainda não houve retomada sem resposta."}`;
}

export function isRepetitiveFollowUp(candidate: string, previousAssistantMessages: string[]): boolean {
  const candidateWords = normalizedWords(candidate);
  const normalizedCandidate = candidateWords.join(" ");
  if (!normalizedCandidate || candidateWords.length < 2) return true;

  return previousAssistantMessages.some((previous) => {
    const previousWords = normalizedWords(previous);
    const normalizedPrevious = previousWords.join(" ");
    if (!normalizedPrevious) return false;
    if (normalizedCandidate === normalizedPrevious) return true;
    if (Math.min(normalizedCandidate.length, normalizedPrevious.length) >= 24
      && (normalizedCandidate.includes(normalizedPrevious) || normalizedPrevious.includes(normalizedCandidate))) return true;

    const candidateSet = new Set(candidateWords);
    const previousSet = new Set(previousWords);
    const overlap = [...candidateSet].filter((word) => previousSet.has(word)).length;
    return overlap >= 4 && overlap / Math.min(candidateSet.size, previousSet.size) >= 0.78;
  });
}

const UNSUPPORTED_REPLY_OPENING = /^\s*(?:(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\uFE0F)\s*)*(?:entendi(?:do)?|perfeito|certo|[oó]timo|legal|combinado|excelente|que\s+bom|boa|beleza|show|fechou|top)\b/iu;
const CANNED_FOLLOW_UP_OPENING = /^\s*(?:(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\uFE0F)\s*)*(?:fico\s+(?:aqui\s+)?no\s+aguardo|no\s+aguardo|aguardo\s+(?:seu|sua)|passando\s+(?:só\s+)?(?:por\s+aqui\s+)?para|só\s+passando\s+(?:por\s+aqui\s+)?para|retornando\s+(?:aqui\s+)?para|me\s+diz\s+só\s+se)\b/iu;

/**
 * A follow-up is generated only while the latest agent message is still unanswered.
 * Openings like "Entendi" or "Perfeito" therefore acknowledge a contact reply that
 * does not exist and can make the model silently invent an answer.
 */
export function startsAsReplyToUnansweredMessage(candidate: string): boolean {
  return UNSUPPORTED_REPLY_OPENING.test(candidate);
}

/** Rejects stock collection language that makes a WhatsApp nudge sound automated. */
export function startsLikeCannedFollowUp(candidate: string): boolean {
  return CANNED_FOLLOW_UP_OPENING.test(candidate);
}

export function parseFollowUpDecision(candidate: string): { send: boolean; text: string } {
  const text = candidate.trim();
  return {
    // Fail closed if a non-OpenRouter implementation ignores the validator
    // and mixes the internal no-send decision with customer-facing copy.
    send: !text.includes(AI_FOLLOW_UP_NOT_NEEDED_MARKER),
    text: text.replaceAll(AI_FOLLOW_UP_NOT_NEEDED_MARKER, "").trim()
  };
}

export function followUpSystemPrompt(claim: Pick<AiFollowUpClaim, "systemPrompt" | "followUpCount" | "maxCount" | "history"> & Partial<Pick<AiFollowUpClaim, "delivery">>): string {
  const ordinal = claim.followUpCount + 1;
  const deliveryInstruction = claim.delivery?.type === "image"
    ? `\nFORMATO DESTA TENTATIVA:
- Uma imagem chamada "${compactContextText(claim.delivery.name ?? "imagem selecionada", 100)}" será enviada com a mensagem como legenda.
- Contexto factual informado pelo operador: "${compactContextText(claim.delivery.description ?? "sem contexto adicional", 500)}".
- Escreva uma legenda natural que apresente essa imagem e conecte o case ao próximo passo da conversa. Use somente os fatos fornecidos no contexto; não invente números, resultados ou prazos.
`
    : claim.delivery?.type === "audio"
      ? `\nFORMATO DESTA TENTATIVA:
- Um áudio chamado "${compactContextText(claim.delivery.name ?? "áudio selecionado", 100)}" será enviado como nota de voz, sem texto ou legenda acompanhando o envio.
- Contexto factual informado pelo operador: "${compactContextText(claim.delivery.description ?? "sem contexto adicional", 500)}". Use-o para orientar o conteúdo do áudio sem inventar fatos.
`
      : claim.delivery?.type === "video"
        ? `\nFORMATO DESTA TENTATIVA:
- Um vídeo chamado "${compactContextText(claim.delivery.name ?? "vídeo selecionado", 100)}" será enviado com uma legenda curta.
- Contexto factual informado pelo operador: "${compactContextText(claim.delivery.description ?? "sem contexto adicional", 500)}". Escreva uma legenda natural usando somente esses fatos; não invente números, resultados ou prazos.
`
    : "";
  return protectedSystemPrompt(`${claim.systemPrompt}

${followUpContinuityContext(claim.history)}
${deliveryInstruction}

MODO DE FOLLOW-UP AUTOMÁTICO:
- Você escreverá o follow-up ${ordinal} de no máximo ${claim.maxCount}, pois o contato ainda não respondeu à última mensagem do atendimento.
- A última mensagem do histórico é do atendimento e continua SEM RESPOSTA. Ela não foi escrita pelo contato e não contém uma resposta implícita.
- Antes de escrever, decida internamente se obter essa resposta é realmente necessário para levar este contato ao agendamento ou para entregar ao SDR ou especialista uma oportunidade pronta para fechar.
- Envie uma retomada somente quando a resposta ausente bloquear o próximo passo comercial necessário. Exemplos: confirmar um horário concreto já oferecido, escolher entre horários disponíveis, informar um dado indispensável para agendar ou aceitar o avanço para o SDR ou especialista concluir.
- Não envie só para manter a conversa viva, cobrar uma informação opcional, insistir em uma pergunta que o contato recusou, repetir conteúdo informativo, fazer nutrição genérica ou tentar reabrir uma conversa cujo próximo passo não depende daquela resposta. Também não envie se o histórico já mostra o agendamento concluído ou a oportunidade entregue ao atendimento humano.
- Na dúvida sobre a necessidade real da resposta, prefira não enviar.
- Se a resposta não for necessária para avançar ao agendamento ou ao fechamento pelo SDR ou especialista, responda exclusivamente ${AI_FOLLOW_UP_NOT_NEEDED_MARKER}. Não acrescente texto, explicação ou pontuação. O sistema cancelará a sequência sem enviar nada ao contato.
- Nunca responda à pergunta feita pelo próprio atendimento. Não suponha qual seria a resposta do contato, não confirme uma opção e não avance como se ele tivesse respondido. Por exemplo, se o atendimento perguntou se a loja vende só smartphones, é proibido escrever "Entendi, só smartphones".
- Releia todo o histórico e dê prioridade máxima ao assunto que ficou pendente entre a última mensagem real do contato e a mensagem mais recente do atendimento.
- Escreva uma única mensagem curta e espontânea, como um vendedor retomando o papo no WhatsApp, mantendo o foco em chegar ao agendamento. “Descontraída” aqui significa vocabulário do dia a dia, ritmo de conversa e uma abordagem nova, não uma frase de cobrança seguida da mesma pergunta.
- Não use linguagem de espera ou cobrança, como “fico no aguardo”, “passando para saber”, “retornando aqui” ou “me diz só se”. Não acrescente apenas “por aqui”, “rapidinho” ou outra introdução à frase anterior.
- Se a mensagem mais recente fez uma pergunta indispensável, mantenha-a como não respondida, mas mude de verdade a abordagem: transforme-a numa escolha muito fácil, use palavras mais naturais ou convide a pessoa a responder em poucas palavras. Exemplo de transformação de tom: em vez de repetir “vocês vendem mais à vista ou parcelado?”, use algo como “Por aí o pessoal costuma fechar mais no pix ou dividir?”. Use o exemplo só como referência de tom, nunca como texto fixo.
- Varie o jeito de chamar a pessoa ao longo das tentativas. Pode usar energia comercial e informal, no espírito de “bora vender mais” ou “tem alguém por aí”, somente quando combinar com o histórico e sem repetir bordões.
- Não reinicie a conversa, não use uma saudação genérica, não seja agressivo e não mencione follow-up, automação, IA, demora ou tentativa anterior.
- Não copie literalmente frases, perguntas, ofertas ou chamadas para ação que já apareceram nas mensagens do atendimento. É permitido reformular a última pergunta ainda não respondida. Não peça novamente um dado que o contato já informou.
- Não invente fatos, disponibilidade ou ações concluídas. Não execute ferramentas nem altere cadastros neste modo.
- Responda somente com a mensagem que será enviada, sem título, explicação, aspas ou marcadores.`, AI_HANDOFF_MARKER);
}

export async function scheduleAiFollowUpsAfterAgentReply(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; agentMessageId: string; sentAt: Date }
): Promise<{ conversationId: string; sequenceVersion: number; nextRunAt: Date } | null> {
  const result = await client.query<{
    conversation_id: string;
    sequence_version: number;
    next_run_at: Date;
  }>(
    `WITH active_appointment AS MATERIALIZED (
       SELECT 1
       FROM conversations conversation
       JOIN scheduling_leads lead
         ON lead.tenant_id=conversation.tenant_id
        AND regexp_replace(lead.phone,'\\D','','g')=regexp_replace(conversation.contact_phone,'\\D','','g')
       WHERE conversation.id=$2 AND conversation.tenant_id=$1
         AND (
           lead.recovery_required
           OR lead.status NOT IN ('novo','em_atendimento','aguardando_resposta','qualificado','em_qualificacao','aprovado')
           OR EXISTS (
             SELECT 1 FROM scheduling_appointments appointment
             WHERE appointment.tenant_id=lead.tenant_id
               AND appointment.lead_id=lead.id
               AND appointment.status IN ('confirmado','reagendado')
           )
         )
       LIMIT 1
     ), cancel_existing AS (
       UPDATE ai_follow_up_schedules
       SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
           cancellation_reason='appointment_active',updated_at=now()
       WHERE conversation_id=$2 AND EXISTS(SELECT 1 FROM active_appointment)
       RETURNING conversation_id
     )
     INSERT INTO ai_follow_up_schedules
       (conversation_id,tenant_id,last_agent_message_id,follow_up_count,sequence_version,status,sequence_started_at,next_run_at,
        processing_started_at,failure_count,last_error,cancellation_reason,updated_at)
     SELECT c.id,c.tenant_id,$3,0,1,'scheduled',$4::timestamptz,
              $4::timestamptz + make_interval(mins => s.ai_follow_up_delays_minutes[1]),
              NULL,0,NULL,NULL,now()
     FROM conversations c
     JOIN tenant_ai_settings s ON s.tenant_id=c.tenant_id
     JOIN LATERAL (
       SELECT id,sender FROM messages
       WHERE conversation_id=c.id AND NOT (sender='agent' AND media_is_sticker)
       ORDER BY created_at DESC,id DESC LIMIT 1
     ) latest ON latest.id=$3 AND latest.sender='agent'
     WHERE c.id=$2 AND c.tenant_id=$1 AND c.ai_active AND c.status='open'
       AND c.session_id IS NOT NULL
       AND s.ai_follow_up_enabled
       AND NOT EXISTS(SELECT 1 FROM active_appointment)
     ON CONFLICT(conversation_id) DO UPDATE SET
       tenant_id=EXCLUDED.tenant_id,
       last_agent_message_id=EXCLUDED.last_agent_message_id,
       follow_up_count=0,
       sequence_version=ai_follow_up_schedules.sequence_version+1,
       status='scheduled',
       sequence_started_at=EXCLUDED.sequence_started_at,
       next_run_at=EXCLUDED.next_run_at,
       processing_started_at=NULL,
       failure_count=0,
       last_error=NULL,
       cancellation_reason=NULL,
       updated_at=now()
     RETURNING conversation_id,sequence_version,next_run_at`,
    [input.tenantId, input.conversationId, input.agentMessageId, input.sentAt]
  );
  const row = result.rows[0];
  return row ? {
    conversationId: row.conversation_id,
    sequenceVersion: row.sequence_version,
    nextRunAt: row.next_run_at
  } : null;
}

export class AiFollowUpRepository {
  constructor(private readonly db: Pool, private readonly config?: AppConfig) {}

  async cancelForContact(tenantId: string, contactPhone: string, reason = "contact_replied"): Promise<number> {
    const result = await this.db.query(
      `UPDATE ai_follow_up_schedules f
       SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,cancellation_reason=$3,updated_at=now()
       FROM conversations c
       WHERE f.conversation_id=c.id AND f.tenant_id=c.tenant_id
         AND c.tenant_id=$1 AND c.contact_phone=$2 AND f.status IN ('scheduled','processing')`,
      [tenantId, contactPhone, reason]
    );
    return result.rowCount ?? 0;
  }

  async findDuePage(
    limit = 100,
    cursor?: { dueAt: Date; conversationId: string }
  ): Promise<{
      events: Array<{ conversationId: string; sequenceVersion: number; dueAt: Date }>;
      nextCursor: { dueAt: Date; conversationId: string } | null;
      oldestAgeMs: number;
    }> {
    const result = await this.db.query<{
      conversation_id: string;
      sequence_version: number;
      due_at: Date;
      oldest_age_ms: number;
    }>(
      `SELECT conversation_id,sequence_version,
              COALESCE(next_run_at,processing_started_at) due_at,
              COALESCE(max(extract(epoch FROM (
                now()-COALESCE(next_run_at,processing_started_at)
              ))*1000) OVER (),0)::float oldest_age_ms
       FROM ai_follow_up_schedules
       WHERE (
         (status='scheduled' AND next_run_at<=now())
         OR (status='processing' AND processing_started_at<now()-make_interval(mins => $2))
       )
       AND (
         $3::timestamptz IS NULL
         OR (COALESCE(next_run_at,processing_started_at),conversation_id) > ($3,$4::uuid)
       )
       ORDER BY COALESCE(next_run_at,processing_started_at),conversation_id
       LIMIT $1`,
      [limit, PROCESSING_LEASE_MINUTES, cursor?.dueAt ?? null, cursor?.conversationId ?? null]
    );
    const events = result.rows.map((row) => ({
      conversationId: row.conversation_id,
      sequenceVersion: row.sequence_version,
      dueAt: row.due_at
    }));
    const last = events.at(-1);
    return {
      events,
      nextCursor: events.length === limit && last
        ? { dueAt: last.dueAt, conversationId: last.conversationId }
        : null,
      oldestAgeMs: result.rows[0]?.oldest_age_ms ?? 0
    };
  }

  async findDueConversationIds(limit = 100): Promise<string[]> {
    return (await this.findDuePage(limit)).events.map((event) => event.conversationId);
  }

  async findScheduledEvent(
    conversationId: string
  ): Promise<{ conversationId: string; sequenceVersion: number; dueAt: Date } | null> {
    const result = await this.db.query<{
      conversation_id: string;
      sequence_version: number;
      next_run_at: Date;
    }>(
      `SELECT conversation_id,sequence_version,next_run_at
       FROM ai_follow_up_schedules
       WHERE conversation_id=$1 AND status='scheduled' AND next_run_at IS NOT NULL`,
      [conversationId]
    );
    const row = result.rows[0];
    return row ? {
      conversationId: row.conversation_id,
      sequenceVersion: row.sequence_version,
      dueAt: row.next_run_at
    } : null;
  }

  async claimDue(conversationId: string): Promise<AiFollowUpClaim | null> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<FollowUpRow>(
        `SELECT f.conversation_id,f.tenant_id,f.status,f.next_run_at,f.processing_started_at,
                f.follow_up_count,f.sequence_version,f.last_agent_message_id,
                c.session_id,c.contact_phone,c.contact_jid,c.contact_name,c.ai_active,c.status conversation_status,
                s.ai_follow_up_enabled,s.ai_follow_up_max_count,s.ai_follow_up_interval_minutes,
                s.ai_follow_up_delays_minutes,s.ai_follow_up_delivery,
                s.openrouter_provider,s.openrouter_api_key_encrypted,s.humanizer_config,
                a.agent_config_version_id,a.system_prompt,a.ai_model,a.model_params,a.is_active agent_is_active,
                latest.id latest_message_id,latest.sender latest_sender,
                EXISTS(
                  SELECT 1 FROM scheduling_leads lead
                  WHERE lead.tenant_id=c.tenant_id
                    AND regexp_replace(lead.phone,'\\D','','g')=regexp_replace(c.contact_phone,'\\D','','g')
                    AND (
                      lead.recovery_required
                      OR lead.status NOT IN ('novo','em_atendimento','aguardando_resposta','qualificado','em_qualificacao','aprovado')
                      OR EXISTS (
                        SELECT 1 FROM scheduling_appointments appointment
                        WHERE appointment.tenant_id=lead.tenant_id
                          AND appointment.lead_id=lead.id
                          AND appointment.status IN ('confirmado','reagendado')
                      )
                    )
                ) active_appointment
         FROM ai_follow_up_schedules f
         JOIN conversations c ON c.id=f.conversation_id AND c.tenant_id=f.tenant_id
         JOIN tenant_ai_settings s ON s.tenant_id=f.tenant_id
         LEFT JOIN LATERAL (
           SELECT v.id agent_config_version_id,v.system_prompt,v.ai_model,v.model_params,cfg.is_active
           FROM agent_configs cfg
           JOIN agent_config_versions v
             ON v.id=cfg.active_version_id AND v.tenant_id=cfg.tenant_id
            AND v.agent_config_id=cfg.id AND v.status='active'
           WHERE cfg.tenant_id=f.tenant_id ORDER BY cfg.updated_at DESC LIMIT 1
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT id,sender FROM messages WHERE conversation_id=f.conversation_id
             AND NOT (sender='agent' AND media_is_sticker)
           ORDER BY created_at DESC,id DESC LIMIT 1
         ) latest ON true
         WHERE f.conversation_id=$1
         FOR UPDATE OF f`,
        [conversationId]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }

      const staleProcessing = row.status === "processing"
        && Boolean(row.processing_started_at)
        && row.processing_started_at!.getTime() <= Date.now() - PROCESSING_LEASE_MINUTES * 60_000;
      const due = row.status === "scheduled" && Boolean(row.next_run_at) && row.next_run_at!.getTime() <= Date.now();
      if (!due && !staleProcessing) {
        await client.query("COMMIT");
        return null;
      }

      const completed = row.follow_up_count >= row.ai_follow_up_delays_minutes.length;
      const eligible = row.ai_follow_up_enabled && row.ai_active && row.conversation_status === "open"
        && row.agent_is_active === true && Boolean(row.agent_config_version_id)
        && Boolean(row.system_prompt) && Boolean(row.ai_model)
        && row.latest_message_id === row.last_agent_message_id && row.latest_sender === "agent"
        && !row.active_appointment && !completed;
      if (!eligible) {
        if (!row.agent_config_version_id && row.agent_is_active === true) {
          const alert = "Configuração ativa do agente sem versão resolvível";
          await client.query(
            `INSERT INTO system_alerts(tenant_id,message)
             SELECT $1,$2 WHERE NOT EXISTS (
               SELECT 1 FROM system_alerts
               WHERE tenant_id=$1 AND message=$2 AND created_at>=now()-interval '1 hour'
             )`,
            [row.tenant_id, alert]
          );
        }
        await client.query(
          `UPDATE ai_follow_up_schedules
           SET status=$2,next_run_at=NULL,processing_started_at=NULL,cancellation_reason=$3,updated_at=now()
           WHERE conversation_id=$1`,
          [conversationId, completed ? "completed" : "cancelled",
            completed ? "maximum_reached"
              : row.active_appointment ? "appointment_active"
                : !row.agent_config_version_id ? "agent_version_missing" : "conversation_changed"]
        );
        await client.query("COMMIT");
        return null;
      }

      await client.query(
        `UPDATE ai_follow_up_schedules
         SET status='processing',processing_started_at=now(),last_error=NULL,updated_at=now()
         WHERE conversation_id=$1`,
        [conversationId]
      );
      const historyResult = await client.query<{ sender: "contact" | "agent" | "human"; content: string }>(
        `WITH recent_history AS MATERIALIZED (
           SELECT sender,content,created_at,id
           FROM messages
           WHERE conversation_id=$1 AND NOT (sender='agent' AND media_is_sticker)
           ORDER BY created_at DESC,id DESC
           LIMIT $2
         ),
         ranked AS (
           SELECT sender,content,created_at,id,
             row_number() OVER (ORDER BY created_at DESC,id DESC) history_position,
             sum(char_length(content)) OVER (ORDER BY created_at DESC,id DESC) cumulative_characters
           FROM recent_history
         )
         SELECT sender,content FROM ranked
         WHERE cumulative_characters<=$3 OR history_position=1
         ORDER BY created_at,id`,
        [
          conversationId,
          this.config?.AI_HISTORY_MAX_MESSAGES ?? HISTORY_MAX_MESSAGES,
          this.config?.AI_HISTORY_MAX_CHARACTERS ?? HISTORY_MAX_CHARACTERS
        ]
      );
      const configuredDelivery = selectedDelivery(row.ai_follow_up_delivery, row.follow_up_count);
      let delivery: AiFollowUpClaim["delivery"] = { type: "text" };
      if (configuredDelivery.type === "image") {
        const asset = await client.query<{
          id: string; name: string; description: string; mime_type: string; file_name: string; size_bytes: number; media_data: Buffer;
        }>(
          `SELECT id,name,description,mime_type,file_name,size_bytes,media_data
           FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2`,
          [row.tenant_id, configuredDelivery.assetId]
        );
        const image = asset.rows[0];
        if (image) {
          delivery = {
            ...configuredDelivery,
            name: image.name,
            description: image.description,
            mimeType: image.mime_type,
            fileName: image.file_name,
            sizeBytes: image.size_bytes,
            dataBase64: image.media_data.toString("base64")
          };
        }
      } else if (configuredDelivery.type === "audio" || configuredDelivery.type === "video") {
        const asset = await client.query<{ id: string; name: string; mime_type: string; file_name: string; size_bytes: number; media_data: Buffer }>(
          `SELECT id,name,mime_type,file_name,size_bytes,media_data FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2`,
          [row.tenant_id, configuredDelivery.assetId]
        );
        const media = asset.rows[0];
        if (media) delivery = { ...configuredDelivery, name: media.name, mimeType: media.mime_type, fileName: media.file_name, sizeBytes: media.size_bytes, dataBase64: media.media_data.toString("base64") };
      } else if (configuredDelivery.type === "sticker") {
        const asset = await client.query<{
          id: string; name: string; mime_type: string; file_name: string; size_bytes: number; media_data: Buffer;
        }>(
          `SELECT id,name,mime_type,file_name,size_bytes,media_data
           FROM ai_stickers WHERE tenant_id=$1 AND id=$2 AND enabled`,
          [row.tenant_id, configuredDelivery.assetId]
        );
        const sticker = asset.rows[0];
        if (sticker) {
          delivery = {
            ...configuredDelivery,
            name: sticker.name,
            mimeType: sticker.mime_type,
            fileName: sticker.file_name,
            sizeBytes: sticker.size_bytes,
            dataBase64: sticker.media_data.toString("base64")
          };
        }
      }
      await client.query("COMMIT");

      const configuredKey = row.openrouter_api_key_encrypted && this.config
        ? decryptSecret(row.openrouter_api_key_encrypted, {
          current: this.config.DATA_ENCRYPTION_KEY,
          previous: this.config.DATA_ENCRYPTION_KEY_PREVIOUS ? [this.config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
          legacy: [this.config.JWT_SECRET]
        })
        : undefined;
      return {
        conversationId: row.conversation_id,
        agentConfigVersionId: row.agent_config_version_id!,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        contactPhone: row.contact_phone,
        contactJid: row.contact_jid ?? undefined,
        contactName: row.contact_name ?? undefined,
        sequenceVersion: row.sequence_version,
        followUpCount: row.follow_up_count,
        maxCount: row.ai_follow_up_delays_minutes.length,
        delaysMinutes: row.ai_follow_up_delays_minutes,
        delivery,
        model: row.ai_model!,
        provider: row.openrouter_provider ?? undefined,
        systemPrompt: row.system_prompt!,
        temperature: row.model_params?.temperature ?? 0.4,
        maxTokens: row.model_params?.max_tokens ?? 512,
        openRouterApiKey: configuredKey,
        humanizer: this.config ? migrateHumanizerConfig(row.humanizer_config ?? DEFAULT_HUMANIZER_CONFIG) : undefined,
        history: historyResult.rows.map((message) => ({
          role: message.sender === "contact" ? "user" as const : "assistant" as const,
          content: message.content
        }))
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async isClaimCurrent(claim: Pick<AiFollowUpClaim, "conversationId" | "sequenceVersion">): Promise<boolean> {
    const result = await this.db.query<{ current: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ai_follow_up_schedules f
         JOIN conversations c ON c.id=f.conversation_id AND c.tenant_id=f.tenant_id
         JOIN tenant_ai_settings s ON s.tenant_id=f.tenant_id
         JOIN LATERAL (
           SELECT id,sender FROM messages WHERE conversation_id=f.conversation_id
             AND NOT (sender='agent' AND media_is_sticker)
           ORDER BY created_at DESC,id DESC LIMIT 1
         ) latest ON true
         WHERE f.conversation_id=$1 AND f.sequence_version=$2 AND f.status='processing'
           AND c.ai_active AND c.status='open' AND s.ai_follow_up_enabled
           AND f.follow_up_count<cardinality(s.ai_follow_up_delays_minutes)
           AND latest.id=f.last_agent_message_id AND latest.sender='agent'
       ) current`,
      [claim.conversationId, claim.sequenceVersion]
    );
    return result.rows[0]?.current === true;
  }

  async recordAiUsage(input: {
    tenantId: string; conversationId: string; providerRequestId?: string; model: string;
    inputTokens: number; outputTokens: number; costUsd: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO usage_logs
         (tenant_id,conversation_id,ai_model,input_tokens,output_tokens,cost_usd,provider_request_id)
       SELECT c.tenant_id,c.id,$3,$4,$5,$6,$7 FROM conversations c
       WHERE c.id=$2 AND c.tenant_id=$1
       ON CONFLICT(provider_request_id) WHERE provider_request_id IS NOT NULL DO NOTHING`,
      [input.tenantId, input.conversationId, input.model, input.inputTokens, input.outputTokens,
        input.costUsd, input.providerRequestId ?? null]
    );
  }

  async completeSent(
    claim: AiFollowUpClaim,
    input: {
      text: string;
      model: string;
      externalId: string;
      sentAt: Date;
      mediaType?: "image";
      mediaMimeType?: string;
      mediaFileName?: string;
      mediaSizeBytes?: number;
      mediaIsSticker?: boolean;
      bubbles?: Array<{ text: string; externalId: string; sentAt: Date }>;
    }
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const deliveries = input.bubbles?.length
        ? input.bubbles.map((bubble) => ({ ...bubble, mediaType: null, mediaMimeType: null, mediaFileName: null, mediaSizeBytes: null, mediaIsSticker: false }))
        : [{
            text: input.text,
            externalId: input.externalId,
            sentAt: input.sentAt,
            mediaType: input.mediaType ?? null,
            mediaMimeType: input.mediaMimeType ?? null,
            mediaFileName: input.mediaFileName ?? null,
            mediaSizeBytes: input.mediaSizeBytes ?? null,
            mediaIsSticker: input.mediaIsSticker ?? false
          }];
      let lastMessageId: string | undefined;
      for (const delivery of deliveries) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO messages(
             conversation_id,sender,content,ai_model_used,agent_config_version_id,external_message_id,
             provider_message_key,created_at,media_type,media_mime_type,media_file_name,media_size_bytes,media_is_sticker
           )
           SELECT c.id,'agent',$3,$4,$5,$6,$7,$8,$10,$11,$12,$13,$14 FROM conversations c
           WHERE c.id=$1 AND c.tenant_id=$2 AND c.session_id=$9
           ON CONFLICT(provider_message_key) DO UPDATE SET
             sender='agent',content=EXCLUDED.content,ai_model_used=EXCLUDED.ai_model_used,
             agent_config_version_id=EXCLUDED.agent_config_version_id,
             media_type=EXCLUDED.media_type,media_mime_type=EXCLUDED.media_mime_type,
             media_file_name=EXCLUDED.media_file_name,media_size_bytes=EXCLUDED.media_size_bytes,
             media_is_sticker=EXCLUDED.media_is_sticker
           RETURNING id`,
          [claim.conversationId, claim.tenantId, delivery.text, input.model, claim.agentConfigVersionId,
            delivery.externalId, `${claim.tenantId}:${claim.sessionId}:${delivery.externalId}`, delivery.sentAt, claim.sessionId,
            delivery.mediaType, delivery.mediaMimeType, delivery.mediaFileName,
            delivery.mediaSizeBytes, delivery.mediaIsSticker]
        );
        if (!inserted.rows[0]) throw new Error("Conversation disappeared before follow-up could be recorded");
        lastMessageId = inserted.rows[0].id;
      }
      if (!lastMessageId) throw new Error("Follow-up delivery did not contain a message");
      const lastSentAt = deliveries.at(-1)!.sentAt;
      await client.query(
        `UPDATE conversations SET last_message_at=GREATEST(last_message_at,$3)
         WHERE id=$1 AND tenant_id=$2`,
        [claim.conversationId, claim.tenantId, lastSentAt]
      );
      await client.query(
        `UPDATE ai_follow_up_schedules f SET
           follow_up_count=f.follow_up_count+1,
           last_agent_message_id=CASE WHEN $5::boolean THEN f.last_agent_message_id ELSE $3 END,
           status=CASE
             WHEN NOT s.ai_follow_up_enabled OR NOT c.ai_active OR c.status<>'open' THEN 'cancelled'
             WHEN f.follow_up_count+1>=cardinality(s.ai_follow_up_delays_minutes) THEN 'completed'
             ELSE 'scheduled'
           END,
           next_run_at=CASE
             WHEN s.ai_follow_up_enabled AND c.ai_active AND c.status='open'
               AND f.follow_up_count+1<cardinality(s.ai_follow_up_delays_minutes)
             THEN f.sequence_started_at
               + make_interval(mins => s.ai_follow_up_delays_minutes[f.follow_up_count+2])
             ELSE NULL
           END,
           processing_started_at=NULL,failure_count=0,last_error=NULL,
           cancellation_reason=CASE
             WHEN NOT s.ai_follow_up_enabled THEN 'configuration_disabled'
             WHEN NOT c.ai_active OR c.status<>'open' THEN 'conversation_inactive'
             WHEN f.follow_up_count+1>=cardinality(s.ai_follow_up_delays_minutes) THEN 'maximum_reached'
             ELSE NULL
           END,
           updated_at=now()
         FROM tenant_ai_settings s,conversations c
         WHERE f.conversation_id=$1 AND f.tenant_id=$2 AND f.sequence_version=$4
           AND f.status='processing' AND s.tenant_id=f.tenant_id
           AND c.id=f.conversation_id AND c.tenant_id=f.tenant_id`,
        [claim.conversationId, claim.tenantId, lastMessageId, claim.sequenceVersion, input.mediaIsSticker ?? false]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseClaim(claim: Pick<AiFollowUpClaim, "conversationId" | "sequenceVersion">, delaySeconds = 5): Promise<void> {
    await this.db.query(
      `UPDATE ai_follow_up_schedules
       SET status='scheduled',next_run_at=now()+make_interval(secs => $3),processing_started_at=NULL,updated_at=now()
       WHERE conversation_id=$1 AND sequence_version=$2 AND status='processing'`,
      [claim.conversationId, claim.sequenceVersion, delaySeconds]
    );
  }

  async cancelClaim(claim: Pick<AiFollowUpClaim, "conversationId" | "sequenceVersion">, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE ai_follow_up_schedules
       SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,cancellation_reason=$3,updated_at=now()
       WHERE conversation_id=$1 AND sequence_version=$2 AND status='processing'`,
      [claim.conversationId, claim.sequenceVersion, reason]
    );
  }

  async recordFailure(claim: Pick<AiFollowUpClaim, "conversationId" | "sequenceVersion">, error: unknown): Promise<boolean> {
    const result = await this.db.query<{ status: string }>(
      `UPDATE ai_follow_up_schedules SET
         failure_count=failure_count+1,
         status=CASE WHEN failure_count+1>=$3 THEN 'failed' ELSE 'scheduled' END,
         next_run_at=CASE WHEN failure_count+1>=$3 THEN NULL ELSE now()+interval '1 minute' END,
         processing_started_at=NULL,last_error=$4,
         cancellation_reason=CASE WHEN failure_count+1>=$3 THEN 'repeated_failure' ELSE NULL END,
         updated_at=now()
       WHERE conversation_id=$1 AND sequence_version=$2 AND status='processing'
       RETURNING status`,
      [claim.conversationId, claim.sequenceVersion, MAX_FAILURES, error instanceof Error ? error.message : String(error)]
    );
    return result.rows[0]?.status === "failed";
  }

  async createFailureAlert(tenantId: string): Promise<void> {
    const message = "Os follow-ups automáticos da IA falharam repetidamente em uma conversa. Verifique a conexão e a configuração do modelo.";
    await this.db.query(
      `INSERT INTO system_alerts(tenant_id,message)
       SELECT $1,$2 WHERE NOT EXISTS(
         SELECT 1 FROM system_alerts WHERE tenant_id=$1 AND message=$2 AND created_at>=now()-interval '1 hour'
       )`,
      [tenantId, message]
    );
  }
}

export type AiFollowUpProcessResult = "sent" | "not_due" | "cancelled" | "busy";

export class AiFollowUpProcessor {
  constructor(
    private readonly repository: AiFollowUpRepository,
    private readonly gateway: MessageGateway,
    private readonly ai: AiRouter
  ) {}

  async process(conversationId: string): Promise<AiFollowUpProcessResult> {
    const claim = await this.repository.claimDue(conversationId);
    if (!claim) return "not_due";

    const conversationLock = await acquireConversationLock(`${claim.tenantId}:${claim.contactJid ?? claim.contactPhone}`);
    if (!conversationLock) {
      await this.repository.releaseClaim(claim);
      return "busy";
    }
    const lockHeartbeat = setInterval(() => void extendConversationLock(conversationLock).catch((error) => {
      console.error("Follow-up conversation lock heartbeat failed", { conversationId, error });
    }), 20_000);
    try {
      // Reserva atômica da franquia (mesma razão do inbound_reply): a checagem e
      // o consumo ocorrem na mesma transação serializada por tenant. A chave usa
      // conversationId + sequenceVersion, estável entre retentativas do follow-up.
      const billingTurnId = deriveBillingTurnId(
        claim.tenantId,
        "follow_up",
        `${claim.conversationId}:${claim.sequenceVersion}`
      );
      const consumption = await consumeAiInteraction(claim.tenantId, "follow_up", billingTurnId, { conversationId: claim.conversationId });
      if (!consumption.allowed) {
        logger.warn({ event: "ai_interaction_blocked", tenantId: claim.tenantId, conversationId: claim.conversationId, purpose: "follow_up", reason: consumption.reason }, consumption.reason === "BILLING_UNAVAILABLE" ? "AI follow-up skipped because billing is unavailable" : "AI follow-up skipped because the billing quota was reached");
        await this.repository.cancelClaim(claim, "ai_quota_reached");
        return "cancelled";
      }
      const previousAssistantMessages = claim.history
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);
      const completion = await this.ai.complete({
        model: claim.model,
        provider: claim.provider,
        systemPrompt: followUpSystemPrompt(claim),
        temperature: Math.min(1.2, Math.max(0.65, claim.temperature)),
        maxTokens: Math.min(400, claim.maxTokens),
        apiKey: claim.openRouterApiKey,
        history: claim.history,
        trace: {
          requestId: billingTurnId,
          conversationId: claim.conversationId,
          messageId: claim.conversationId,
          processingAttempt: 1,
          tenantId: claim.tenantId,
          reason: "follow_up"
        },
        validateFinalText: (text) => {
          const handoffCorrection = unauthorizedAgentHandoffCorrection(text);
          if (handoffCorrection) return handoffCorrection;
          if (text.includes(AI_FOLLOW_UP_NOT_NEEDED_MARKER) && text.trim() !== AI_FOLLOW_UP_NOT_NEEDED_MARKER) {
            return `A decisão de não enviar deve ser somente ${AI_FOLLOW_UP_NOT_NEEDED_MARKER}, sem qualquer mensagem junto. Se a resposta for indispensável para agendar ou permitir o fechamento pelo SDR ou especialista, remova o marcador e escreva apenas a retomada.`;
          }
          if (startsAsReplyToUnansweredMessage(text)) {
            return "A mensagem começa como se o contato tivesse respondido, mas nenhuma resposta chegou. Reescreva como uma retomada da pergunta pendente: não confirme nem invente uma resposta e não avance para a próxima pergunta.";
          }
          if (startsLikeCannedFollowUp(text)) {
            return "A retomada soa como cobrança automática ou apenas repete a pergunta com uma introdução. Reescreva de forma curta, espontânea e descontraída, mudando de verdade a abordagem e facilitando uma resposta simples. Não use 'fico no aguardo', 'passando para saber', 'retornando aqui' ou 'me diz só se'.";
          }
          return isRepetitiveFollowUp(text, previousAssistantMessages)
            ? "A mensagem proposta repete literalmente ou quase literalmente o atendimento anterior. Reescreva a retomada com outras palavras, mantendo como não respondida a última pergunta do atendimento."
            : undefined;
        },
        onUsage: (usage) => this.repository.recordAiUsage({
          tenantId: claim.tenantId,
          conversationId: claim.conversationId,
          ...usage
        })
      });
      const decision = parseFollowUpDecision(sanitizeOutbound(completion.text, ""));
      if (!decision.send) {
        await this.repository.cancelClaim(claim, "response_not_required");
        return "cancelled";
      }
      const parsed = parseAgentHandoff(decision.text);
      if (parsed.handoff) {
        // A provider implementation may ignore validateFinalText. Do not turn
        // an unauthorized marker into a silent abandonment of the sequence;
        // let the normal failure policy retry the follow-up instead.
        throw new Error("AI attempted unauthorized handoff during follow-up");
      }
      if (!parsed.text) throw new Error("AI generated an empty follow-up");
      if (!await this.repository.isClaimCurrent(claim)) {
        await this.repository.cancelClaim(claim, "conversation_changed");
        return "cancelled";
      }

      const destination = claim.contactJid ?? claim.contactPhone;
      const delivery = claim.delivery ?? { type: "text" as const };
      const humanizer = claim.humanizer ?? DEFAULT_HUMANIZER_CONFIG;
      const textBubbles = delivery.type === "text"
        ? splitResponse(parsed.text, humanizer.messageSplit.maxWordsPerBubble)
        : [parsed.text];
      await this.gateway.setPresence(claim.sessionId, "available");
      if (delivery.type !== "sticker") {
        await this.gateway.sendPresence(claim.sessionId, destination, "composing", humanizer.composing.resendIntervalMs + 1_000);
      }
      try {
        if (delivery.type !== "sticker" && claim.humanizer) {
          await sleep(composingDuration(textBubbles[0], humanizer));
        }
        if (!await this.repository.isClaimCurrent(claim)) {
          await this.repository.cancelClaim(claim, "conversation_changed");
          return "cancelled";
        }
        let sentAt = new Date();
        let sent: { externalId: string };
        let sentBubbles: Array<{ text: string; externalId: string; sentAt: Date }> | undefined;
        if (delivery.type === "sticker") {
          if (!delivery.dataBase64 || !this.gateway.sendSticker) {
            throw new Error("Configured follow-up sticker is unavailable");
          }
          sent = await this.gateway.sendSticker(claim.sessionId, destination, { dataBase64: delivery.dataBase64 });
        } else if (delivery.type === "image" || delivery.type === "audio" || delivery.type === "video") {
          if (!delivery.dataBase64 || !delivery.mimeType || !delivery.fileName || !this.gateway.sendMedia) throw new Error(`Configured follow-up ${delivery.type} is unavailable`);
          sent = await this.gateway.sendMedia(claim.sessionId, destination, { mediaType: delivery.type as never, mimeType: delivery.mimeType, fileName: delivery.fileName, dataBase64: delivery.dataBase64, caption: parsed.text });
        } else {
          sentBubbles = [];
          for (const [index, bubble] of textBubbles.entries()) {
            if (index > 0) {
              await this.gateway.sendPresence(claim.sessionId, destination, "composing", humanizer.composing.resendIntervalMs + 1_000);
              if (claim.humanizer) {
                await sleep(
                  humanizedDelay(randomBetween(humanizer.messageSplit.pauseBetweenBubblesMs), humanizer)
                  + composingDuration(bubble, humanizer)
                );
              }
            }
            const bubbleSentAt = new Date();
            const bubbleSent = await this.gateway.sendText(claim.sessionId, destination, bubble);
            sentBubbles.push({ text: bubble, externalId: bubbleSent.externalId, sentAt: bubbleSentAt });
          }
          sent = { externalId: sentBubbles[0]!.externalId };
          sentAt = sentBubbles[0]!.sentAt;
        }
        await this.repository.completeSent(claim, {
          text: delivery.type === "sticker" ? "" : parsed.text,
          model: claim.model,
          externalId: sent.externalId,
          sentAt,
          ...(sentBubbles ? { bubbles: sentBubbles } : {}),
          ...(delivery.type === "image" ? {
            mediaType: "image" as const,
            mediaMimeType: delivery.mimeType,
            mediaFileName: delivery.fileName,
            mediaSizeBytes: delivery.sizeBytes
          } : {}),
          ...(delivery.type === "sticker" ? {
            mediaType: "image" as const,
            mediaMimeType: delivery.mimeType,
            mediaFileName: delivery.fileName,
            mediaSizeBytes: delivery.sizeBytes,
            mediaIsSticker: true
          } : {})
        });
        void reconcileAiTurnFromUsageLogs(claim.tenantId, "follow_up", billingTurnId).catch(() => {});
      } finally {
        if (delivery.type !== "sticker") {
          await this.gateway.sendPresence(claim.sessionId, destination, "paused", 500);
        }
      }
      return "sent";
    } catch (error) {
      const terminal = await this.repository.recordFailure(claim, error);
      if (terminal) await this.repository.createFailureAlert(claim.tenantId);
      throw error;
    } finally {
      clearInterval(lockHeartbeat);
      await releaseConversationLock(conversationLock);
    }
  }
}

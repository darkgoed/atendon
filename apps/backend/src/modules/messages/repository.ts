import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import type { ReasoningEffort } from "../ai-router/openrouter.js";
import { decryptSecret } from "../ai-router/secret-box.js";
import { DEFAULT_MEDIA_FALLBACK } from "../ai-router/defaults.js";
import { parseIdempotencyKey, payloadFingerprint } from "./idempotency.js";
import type { HumanMessage, InboundMessage, MediaType, MessageDeliveryStatus, MessageReferral } from "./types.js";
import { DEFAULT_HUMANIZER_CONFIG, migrateHumanizerConfig, type HumanizerConfig } from "./humanizer.js";
import { scheduleAiFollowUpsAfterAgentReply } from "./ai-follow-up.js";
import { commercialStateBlocksAiAutomation } from "../commercial-journey/automation.js";
import { normalizePhoneE164, normalizeWhatsAppJid } from "../../phone.js";
import { StickerRepository, type AiStickerAsset, type AiStickerCatalogItem } from "../stickers/repository.js";
import {
  sanitizeOperationalError,
  transactionalToolName,
  type TransactionalClaim
} from "./transactional-outcome.js";
import { isCapabilityEnabled, isFeatureFlagEnabled, type CapabilityKey } from "../operations/feature-flags.js";
import { isWhatsAppSendRejectedError } from "../whatsapp/errors.js";
import { enqueueAiFollowUp } from "../../queue/ai-follow-up-queue.js";
import { assignConversationToNamedAttendant, ensureCaseAssignment } from "../assignments/service.js";
import { extractPrefilledFields } from "./prefilled-context-policy.js";

function canonicalMessageAddress<T extends InboundMessage | HumanMessage>(message: T): T {
  if (message.channel === "instagram") {
    const instagramContactId = message.instagramContactId?.trim();
    if (!instagramContactId || message.contactPhone !== `ig:${instagramContactId}`) {
      throw new Error("Instagram message requires a scoped ig: address and contact identity");
    }
    if (message.contactJid) throw new Error("Instagram message cannot carry a WhatsApp JID");
    return { ...message, instagramContactId };
  }
  const trustedProviderDigits = /^\d{8,15}$/.test(message.contactPhone)
    && Boolean(message.contactJid?.includes("@"));
  const contactPhone = trustedProviderDigits ? message.contactPhone : normalizePhoneE164(message.contactPhone);
  return {
    ...message,
    contactPhone,
    ...(message.contactJid
      ? { contactJid: normalizeWhatsAppJid(message.contactJid, contactPhone) ?? message.contactJid }
      : {})
  };
}

const HISTORY_MAX_MESSAGES = 40;
const HISTORY_MAX_CHARACTERS = 12_000;
const IDEMPOTENCY_WAIT_ATTEMPTS = 80;
const IDEMPOTENCY_WAIT_MS = 25;
const MEETING_PROVISIONING_WAIT_ATTEMPTS = 20;
const MEETING_PROVISIONING_WAIT_MS = 100;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export interface ConversationContext {
  conversationId: string;
  messageId: string;
  agentConfigVersionId: string;
  aiActive: boolean;
  /**
   * Valor cru de `conversations.ai_active`, sem combinar com o switch global
   * do agente (`agent_configs.is_active`) nem com `commercialStateBlocksAiAutomation`.
   * `aiActive` já é o efetivo (usado para decidir se a IA responde); esta
   * coluna serve só para MessageProcessor detectar quando `aiActive` é false
   * por desativação do agente/regra comercial enquanto a conversa ainda está
   * marcada como pertencente à IA no banco, e então persistir a transição
   * visível ao atendimento humano. Opcional para não quebrar fixtures de
   * teste antigas que não precisam desse detalhe; ausência é tratada como
   * "não transicionar" (comportamento seguro/anterior).
   */
  aiActiveColumn?: boolean;
  model: string;
  provider?: string;
  systemPrompt: string;
  offersGroupLink?: string;
  tripzZuluEnabled?: boolean;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
  openRouterApiKey?: string;
  mediaFallback: Record<Exclude<MediaType, "video">, string> & Partial<Record<"video", string>>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  humanizer?: HumanizerConfig;
  enabledToolNames: string[];
  stateToolGatingEnabled?: boolean;
  facebookAttribution: Record<string, unknown>;
  contactName?: string;
  channel?: "whatsapp" | "instagram";
  contactIdentifier?: string;
  timeZone: string;
  leadStatus?: string;
  commercialAutomationOverride?: boolean;
  leadQualificationStars?: number;
  meetingAgendas?: Array<{
    id: string;
    name: string;
    slotDurationMinutes: number;
  }>;
  registeredLead?: {
    id: string;
    name?: string;
    interestCategoryId?: string;
    unitId?: string;
    partnerId?: string;
    source: string;
    status: string;
    facebookAttribution: Record<string, unknown>;
    qualificationAnswers?: Record<string, string>;
  };
  activeAppointment?: {
    id: string;
    start: string;
    status: string;
    unitId: string;
    meetLink?: string;
  };
}

export interface PendingContactTextMessage {
  externalId: string;
  text: string;
}

export interface HandoffNotification {
  id: string;
  sessionId: string;
  attendantPhone: string;
  message: string;
}

export interface ManualOutboundInput {
  tenantId: string;
  conversationId: string;
  sessionId: string;
  contactPhone: string;
  contactJid?: string;
  text: string;
  sendText?: string;
  idempotencyKey: string;
  sentByUserId: string;
  mediaType?: MediaType;
  mediaMimeType?: string;
  mediaFileName?: string;
  mediaSizeBytes?: number;
  contentFingerprint?: string;
  replyToMessageId?: string;
}

export interface FailedMessageRecoverySummary {
  available: number;
  ambiguous: number;
  has_connected_session: boolean;
  legacy_unrecoverable: number;
  oldest_at: string | null;
}

export interface FailedMessageRecoveryResult {
  sent: number;
  failed: number;
  ambiguous: number;
  remaining: number;
}

export interface ToolCallJournalInput {
  tenantId: string;
  conversationId: string;
  inboundExternalId: string;
  aiTurnId: string;
  callOrdinal: number;
  providerCallId?: string;
  toolName: string;
  argumentsJson: string;
}

export type ToolCallJournalResult =
  | {
      journalId: string;
      status: "succeeded";
      resultText: string;
      occurredAt: string;
    }
  | {
      journalId: string;
      status: "failed";
      resultText?: string;
      errorMessage: string;
      occurredAt: string;
    }
  | {
      journalId: string;
      status: "pending";
      errorMessage: string;
      occurredAt: string;
    };

function errorEnvelopeMessage(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { erro?: unknown };
    if (!parsed || typeof parsed !== "object" || !("erro" in parsed)) return undefined;
    return sanitizeOperationalError(
      typeof parsed.erro === "string" ? parsed.erro : "Ferramenta retornou falha operacional"
    );
  } catch {
    return undefined;
  }
}

interface AgentSettingsRow {
  agent_config_version_id: string;
  system_prompt: string;
  ai_model: string;
  model_params: { temperature?: number; max_tokens?: number; reasoning_effort?: ReasoningEffort };
  updated_at: Date;
  openrouter_provider: string | null;
  openrouter_api_key_encrypted: string | null;
  media_fallback_audio: string | null;
  media_fallback_image: string | null;
  media_fallback_document: string | null;
  humanizer_config: HumanizerConfig | null;
  enabled_tools: string[];
}

export function normalizedFacebookAttribution(
  referral?: MessageReferral,
  messageText = ""
): Record<string, unknown> {
  if (!referral) return {};
  const sourceApp = referral.sourceApp?.toLowerCase();
  // Some Evolution/Meta payloads put lead-form answers only in the WhatsApp
  // text. Persist the normalized fields in attribution as well as the message,
  // so they survive the rolling history character limit and are not asked
  // again later in a long conversation.
  const textFields = extractPrefilledFields(
    [{ role: "user", content: messageText }],
    true
  );
  const prefilledFields = {
    ...Object.fromEntries(textFields.map((field) => [field.label, field.value])),
    ...(referral.prefilledFields ?? {})
  };
  return {
    provider: "meta",
    channel: sourceApp === "instagram" ? "instagram" : "facebook",
    source_type: referral.sourceType,
    ...(referral.sourceId ? { source_id: referral.sourceId } : {}),
    ...(referral.sourceUrl ? { source_url: referral.sourceUrl } : {}),
    ...(referral.headline ? { headline: referral.headline } : {}),
    ...(referral.body ? { body: referral.body } : {}),
    ...(referral.mediaType ? { media_type: referral.mediaType } : {}),
    ...(referral.mediaUrl ? { media_url: referral.mediaUrl } : {}),
    ...(referral.thumbnailUrl ? { thumbnail_url: referral.thumbnailUrl } : {}),
    ...(referral.ctwaClid ? { ctwa_clid: referral.ctwaClid } : {}),
    ...(sourceApp ? { source_app: sourceApp } : {}),
    ...(Object.keys(prefilledFields).length ? { prefilled_fields: prefilledFields } : {})
  };
}

export interface MessageRepositoryEventEnqueuers {
  followUp: typeof enqueueAiFollowUp;
}

export class MessageRepository {
  private readonly eventEnqueuers: MessageRepositoryEventEnqueuers;

  constructor(
    private readonly db: Pool,
    private readonly config?: AppConfig,
    eventEnqueuers?: Partial<MessageRepositoryEventEnqueuers>
  ) {
    this.eventEnqueuers = {
      followUp: eventEnqueuers?.followUp ?? enqueueAiFollowUp,
    };
  }

  async capabilityEnabled(tenantId: string, key: CapabilityKey): Promise<boolean> {
    return isCapabilityEnabled(this.db, tenantId, key);
  }


  private async stateToolGatingEnabled(tenantId: string): Promise<boolean> {
    try {
      return await isFeatureFlagEnabled(this.db, tenantId, "state_tool_gating_v2");
    } catch (error) {
      // During a rolling deployment an older database may not have the flag
      // catalog yet. Fail closed to the legacy behavior instead of interrupting
      // inbound processing before the migration reaches this instance.
      if (
        error && typeof error === "object"
        && (
          "code" in error && error.code === "42P01"
          || "statusCode" in error && error.statusCode === 500
        )
      ) return false;
      throw error;
    }
  }

  private messageKey(message: { tenantId: string; sessionId: string; externalId: string; providerMessageKey?: string }): string {
    // `providerMessageKey` carrega o identificador bruto do provedor (o `mid`
    // do Instagram). Usá-lo aqui é o que torna respostas citadas resolvíveis:
    // o `reply_to.mid` de um webhook aponta para o `mid` bruto, não para o
    // external_id com hash que o dispatcher fabrica.
    return `${message.tenantId}:${message.sessionId}:${message.providerMessageKey ?? message.externalId}`;
  }

  private async waitForMeetingProvisioning(
    input: ToolCallJournalInput,
    resultText: string
  ): Promise<string> {
    if (!["agendar_reuniao", "reagendar_reuniao"].includes(input.toolName)) return resultText;
    let payload: Record<string, unknown>;
    let appointment: Record<string, unknown>;
    try {
      const parsed = JSON.parse(resultText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return resultText;
      payload = parsed as Record<string, unknown>;
      if (!payload.agendamento || typeof payload.agendamento !== "object" || Array.isArray(payload.agendamento)) {
        return resultText;
      }
      appointment = payload.agendamento as Record<string, unknown>;
    } catch {
      return resultText;
    }
    if (!["pending", "processing"].includes(String(appointment.meeting_provisioning_status))) {
      return resultText;
    }
    if (typeof appointment.id !== "string") return resultText;

    for (let attempt = 0; attempt < MEETING_PROVISIONING_WAIT_ATTEMPTS; attempt += 1) {
      const current = await this.db.query<{
        id: string;
        unit_id: string;
        unit_name: string;
        start_at: Date;
        end_at: Date;
        status: string;
        timezone: string;
        meeting_url: string | null;
        meeting_provisioning_status: string;
        slot_duration_min: number;
      }>(
        `SELECT appointment.id,appointment.unit_id,unit.name unit_name,
                appointment.start_at,appointment.end_at,appointment.status,
                tenant.timezone,appointment.meeting_url,
                appointment.meeting_provisioning_status,unit.slot_duration_min
         FROM scheduling_appointments appointment
         JOIN scheduling_units unit
           ON unit.id=appointment.unit_id AND unit.tenant_id=appointment.tenant_id
         JOIN tenants tenant ON tenant.id=appointment.tenant_id
         WHERE appointment.id=$1 AND appointment.tenant_id=$2`,
        [appointment.id, input.tenantId]
      );
      const row = current.rows[0];
      if (!row) throw new Error("Agendamento criado não pertence ao tenant do journal");
      if (!["pending", "processing"].includes(row.meeting_provisioning_status)) {
        const settledAppointment = {
          ...appointment,
          id: row.id,
          unidade_id: row.unit_id,
          unidade_nome: row.unit_name,
          start: row.start_at.toISOString(),
          end: row.end_at.toISOString(),
          duration_min: Math.round((row.end_at.getTime() - row.start_at.getTime()) / 60_000),
          status: row.status,
          timezone: row.timezone,
          meeting_provisioning_status: row.meeting_provisioning_status,
          meet_link: row.meeting_url
        };
        return JSON.stringify({
          ...payload,
          agendamento: settledAppointment,
          ...(row.meeting_provisioning_status === "ready" && row.meeting_url
            ? {
                instrucao: `Confirme a data e o horário e envie exatamente este link do Google Meet ao contato: ${row.meeting_url}`
              }
            : {})
        });
      }
      if (attempt < MEETING_PROVISIONING_WAIT_ATTEMPTS - 1) {
        await wait(MEETING_PROVISIONING_WAIT_MS);
      }
    }
    return resultText;
  }

  async listAiStickerCatalog(tenantId: string, conversationId: string): Promise<AiStickerCatalogItem[]> {
    return new StickerRepository(this.db).listCatalog(tenantId, conversationId);
  }

  async findEnabledAiSticker(tenantId: string, stickerId: string): Promise<AiStickerAsset | null> {
    return new StickerRepository(this.db).findEnabledAsset(tenantId, stickerId);
  }

  async recordAiStickerSend(input: {
    tenantId: string; conversationId: string; stickerId: string; externalId: string;
  }): Promise<void> {
    await new StickerRepository(this.db).recordSend(input);
  }

  private async recordInstagramInboundAndLoadContext(
    message: InboundMessage & { channel: "instagram"; instagramContactId: string },
    input: { shouldClaim: boolean; tripzAiEnabled: boolean }
  ): Promise<ConversationContext | null> {
    const attribution = normalizedFacebookAttribution(message.referral, message.text);
    const transaction = await withTenantTransaction(this.db, message.tenantId, async (client) => {
      const conversation = await client.query<{
        id: string; ai_active: boolean; contact_name: string | null; facebook_attribution: Record<string, unknown>;
        lead_id: string | null; status: string;
      }>(
        `UPDATE conversations c SET
           instagram_username=COALESCE($4,c.instagram_username),
           contact_name=COALESCE($5,c.contact_name),
           facebook_attribution=CASE WHEN $6::jsonb<>'{}'::jsonb THEN $6::jsonb ELSE c.facebook_attribution END,
           contact_presence='available',contact_presence_updated_at=now(),contact_last_seen_at=now(),
           status='open',resolved_at=NULL,last_message_at=now(),
           queue_id=CASE WHEN c.status='closed' THEN
             (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)
             ELSE COALESCE(c.queue_id,
               (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)) END
         WHERE c.tenant_id=$1 AND c.session_id=$2 AND c.instagram_contact_id=$3
           AND c.contact_phone IS NULL
         RETURNING c.id,c.ai_active,c.contact_name,c.facebook_attribution,c.lead_id,c.status`,
        [message.tenantId, message.sessionId, message.instagramContactId,
          message.instagramUsername ?? null, message.contactName ?? null, attribution]
      );
      const current = conversation.rows[0];
      if (!current) throw new Error("Instagram conversation does not belong to tenant and connection");
      if (current.lead_id) {
        await client.query(
          `UPDATE scheduling_leads SET
             instagram_username=COALESCE($3,instagram_username),name=COALESCE($4,name),updated_at=now()
           WHERE id=$1 AND tenant_id=$2 AND instagram_session_id=$5 AND instagram_contact_id=$6 AND phone IS NULL`,
          [current.lead_id, message.tenantId, message.instagramUsername ?? null,
            message.contactName ?? null, message.sessionId, message.instagramContactId]
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages(
           conversation_id,sender,content,media_type,external_message_id,provider_message_key,
           processing_started_at,media_mime_type,media_file_name,media_size_bytes,media_is_sticker
         ) VALUES($1,'contact',$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END,$7,$8,$9,$10)
         ON CONFLICT(provider_message_key) DO NOTHING RETURNING id`,
        [current.id, message.text, message.mediaType ?? null, message.externalId, this.messageKey(message),
          input.shouldClaim, message.mediaMimeType ?? null, message.mediaFileName ?? null,
          message.mediaSizeBytes ?? null, message.mediaIsSticker ?? false]
      );
      let messageId = inserted.rows[0]?.id;
      let acquired = Boolean(messageId);
      if (!messageId) {
        const existing = await client.query<{ id: string; processed_at: Date | null }>(
          `UPDATE messages SET processing_started_at=now()
           WHERE provider_message_key=$1 AND $2::boolean AND processed_at IS NULL
             AND (processing_started_at IS NULL OR processing_started_at<now()-interval '10 minutes')
           RETURNING id,processed_at`,
          [this.messageKey(message), input.shouldClaim]
        );
        messageId = existing.rows[0]?.id;
        acquired = Boolean(messageId);
        if (!messageId && !input.shouldClaim) {
          messageId = (await client.query<{ id: string }>(
            "SELECT id FROM messages WHERE provider_message_key=$1",
            [this.messageKey(message)]
          )).rows[0]?.id;
        }
      }
      if (inserted.rows[0]) {
        // O webhook do Instagram entrega a resposta citada como
        // `message.reply_to.mid` (o mid bruto do provedor). Com a mensagem
        // citada armazenada sob provider_message_key=`tenant:sessão:mid`
        // (ver MessageRepository.messageKey), a resolução é uma busca direta
        // pela chave. Mensagens citadas mais antigas que a adoção desta chave
        // (ou apagadas) simplesmente não resolvem: reply_to fica NULL e a
        // conversa continua, sem derrubar o processamento.
        if (message.replyToExternalId) {
          const quoted = await client.query<{ id: string }>(
            "SELECT id FROM messages WHERE provider_message_key=$1",
            [`${message.tenantId}:${message.sessionId}:${message.replyToExternalId}`]
          );
          if (quoted.rows[0]) {
            await client.query(
              "UPDATE messages SET reply_to_message_id=$2 WHERE id=$1 AND reply_to_message_id IS NULL",
              [inserted.rows[0].id, quoted.rows[0].id]
            );
          }
        }
        await client.query(
          `UPDATE ai_follow_up_schedules SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
             cancellation_reason='contact_replied',updated_at=now()
           WHERE conversation_id=$1 AND status IN ('scheduled','processing')`,
          [current.id]
        );
        await ensureCaseAssignment(client, {
          tenantId: message.tenantId,
          selector: { conversationId: current.id },
          reason: current.status === "closed" ? "retorno_conversa_encerrada" : "novo_contato",
          forceRotation: current.status === "closed"
        });
      }
      return { conversationId: current.id, messageId, acquired };
    });
    if (input.shouldClaim && !transaction.acquired) return null;
    if (!transaction.messageId) throw new Error("Instagram inbound message could not be resolved");

    const snapshot = await this.db.query<{
      ai_active: boolean; contact_name: string | null; instagram_username: string | null;
      facebook_attribution: Record<string, unknown>; timezone: string;
      agent_config_version_id: string | null; system_prompt: string | null; ai_model: string | null;
      model_params: { temperature?: number; max_tokens?: number; reasoning_effort?: ReasoningEffort } | null;
      enabled_tools: string[] | null; agent_is_active: boolean | null;
      openrouter_provider: string | null; openrouter_api_key_encrypted: string | null;
      media_fallback_audio: string | null; media_fallback_image: string | null; media_fallback_document: string | null;
      humanizer_config: HumanizerConfig | null; lead_status: string | null; lead_qualification_stars: number | null;
      registered_lead: ConversationContext["registeredLead"] | null;
      active_appointment: ConversationContext["activeAppointment"] | null;
    }>(
      `SELECT c.ai_active,c.contact_name,c.instagram_username,c.facebook_attribution,t.timezone,
              agent.agent_config_version_id,agent.system_prompt,agent.ai_model,agent.model_params,
              agent.enabled_tools,agent.agent_is_active,
              settings.openrouter_provider,settings.openrouter_api_key_encrypted,
              settings.media_fallback_audio,settings.media_fallback_image,settings.media_fallback_document,
              settings.humanizer_config,lead.status lead_status,lead.qualification_stars lead_qualification_stars,
              CASE WHEN lead.id IS NULL THEN NULL ELSE json_build_object(
                'id',lead.id,'name',lead.name,'interestCategoryId',lead.interest_category_id,
                'unitId',lead.unit_id,'partnerId',lead.partner_id,'source',lead.source,
                'status',lead.status,'facebookAttribution',lead.facebook_attribution,
                'qualificationAnswers',lead.qualification_answers) END registered_lead,
              (SELECT json_build_object('id',appointment.id,'start',appointment.start_at,
                 'status',appointment.status,'unitId',appointment.unit_id,'meetLink',appointment.meeting_url)
               FROM scheduling_appointments appointment
               WHERE appointment.tenant_id=c.tenant_id AND appointment.lead_id=c.lead_id
                 AND appointment.status IN ('confirmado','reagendado') AND appointment.end_at>now()
               ORDER BY appointment.start_at DESC LIMIT 1) active_appointment
       FROM conversations c JOIN tenants t ON t.id=c.tenant_id
       LEFT JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id AND lead.deleted_at IS NULL
       LEFT JOIN tenant_ai_settings settings ON settings.tenant_id=c.tenant_id
       LEFT JOIN LATERAL (
         SELECT v.id agent_config_version_id,v.system_prompt,v.ai_model,v.model_params,v.enabled_tools,
                cfg.is_active agent_is_active
         FROM agent_configs cfg JOIN agent_config_versions v
           ON v.id=cfg.active_version_id AND v.tenant_id=cfg.tenant_id
          AND v.agent_config_id=cfg.id AND v.status='active'
         WHERE cfg.tenant_id=c.tenant_id AND (cfg.session_id=c.session_id OR cfg.session_id IS NULL)
         ORDER BY (cfg.session_id IS NOT NULL) DESC,cfg.updated_at DESC LIMIT 1
       ) agent ON true
       WHERE c.id=$1 AND c.tenant_id=$2`,
      [transaction.conversationId, message.tenantId]
    );
    const row = snapshot.rows[0];
    if (!row) throw new Error("Instagram conversation disappeared while loading AI context");
    const historyResult = await this.db.query<{ sender: string; content: string }>(
      `WITH recent AS (
         SELECT sender,content,created_at,id FROM messages WHERE conversation_id=$1
           AND NOT (sender='agent' AND media_is_sticker)
         ORDER BY created_at DESC,id DESC LIMIT $2
       ), ranked AS (
         SELECT *,row_number() OVER(ORDER BY created_at DESC,id DESC) position,
           sum(char_length(content)) OVER(ORDER BY created_at DESC,id DESC) characters FROM recent
       ) SELECT sender,content FROM ranked WHERE characters<=$3 OR position=1 ORDER BY created_at,id`,
      [transaction.conversationId, this.config?.AI_HISTORY_MAX_MESSAGES ?? HISTORY_MAX_MESSAGES,
        this.config?.AI_HISTORY_MAX_CHARACTERS ?? HISTORY_MAX_CHARACTERS]
    );
    const safeTools = (Array.isArray(row.enabled_tools) ? row.enabled_tools : []).filter((name) =>
      ["pesquisar_contexto", "pesquisar_modelo", "consultar_categorias", "consultar_parceiros", "consultar_unidades", "consultar_agendas"].includes(name)
    );
    if (!row.agent_config_version_id || !row.system_prompt || !row.ai_model) {
      await this.markInboundProcessed(message);
    }
    const configuredKey = row.openrouter_api_key_encrypted && this.config
      ? decryptSecret(row.openrouter_api_key_encrypted, {
        current: this.config.DATA_ENCRYPTION_KEY,
        previous: this.config.DATA_ENCRYPTION_KEY_PREVIOUS ? [this.config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
        legacy: [this.config.JWT_SECRET]
      }) : undefined;
    const contactIdentifier = row.instagram_username ? `@${row.instagram_username}` : `ig:${message.instagramContactId}`;
    return {
      conversationId: transaction.conversationId,
      messageId: transaction.messageId,
      agentConfigVersionId: row.agent_config_version_id ?? "",
      aiActive: Boolean(row.ai_active && row.agent_is_active && row.agent_config_version_id),
      aiActiveColumn: row.ai_active,
      model: row.ai_model ?? "",
      provider: row.openrouter_provider ?? undefined,
      systemPrompt: row.system_prompt ?? "",
      offersGroupLink: this.config?.TRIPZ_OFFERS_GROUP_LINK,
      tripzZuluEnabled: input.tripzAiEnabled,
      temperature: row.model_params?.temperature ?? 0.4,
      maxTokens: row.model_params?.max_tokens ?? 512,
      reasoningEffort: row.model_params?.reasoning_effort ?? "medium",
      openRouterApiKey: configuredKey,
      mediaFallback: {
        audio: row.media_fallback_audio ?? DEFAULT_MEDIA_FALLBACK.audio,
        image: row.media_fallback_image ?? DEFAULT_MEDIA_FALLBACK.image,
        document: row.media_fallback_document ?? DEFAULT_MEDIA_FALLBACK.document,
        video: row.media_fallback_document ?? DEFAULT_MEDIA_FALLBACK.document
      },
      humanizer: this.config ? migrateHumanizerConfig(row.humanizer_config ?? DEFAULT_HUMANIZER_CONFIG) : undefined,
      enabledToolNames: safeTools,
      stateToolGatingEnabled: await this.stateToolGatingEnabled(message.tenantId),
      facebookAttribution: row.facebook_attribution ?? {},
      contactName: row.contact_name ?? undefined,
      channel: "instagram",
      contactIdentifier,
      timeZone: row.timezone ?? "UTC",
      leadStatus: row.lead_status ?? undefined,
      leadQualificationStars: row.lead_qualification_stars ?? undefined,
      meetingAgendas: [],
      registeredLead: row.registered_lead ?? undefined,
      activeAppointment: row.active_appointment ?? undefined,
      history: historyResult.rows.map((item) => ({
        role: item.sender === "contact" ? "user" as const : "assistant" as const,
        content: item.content
      }))
    };
  }

  async recordInboundAndLoadContext(message: InboundMessage, options: { claim?: boolean } = {}): Promise<ConversationContext | null> {
    message = canonicalMessageAddress(message);
    const shouldClaim = options.claim !== false;
    const safeCapabilityEnabled = async (key: CapabilityKey): Promise<boolean> => {
      try {
        return await this.capabilityEnabled(message.tenantId, key);
      } catch {
        // Conversations are core. A catalog failure suppresses optional module
        // behavior but must not prevent the inbound message from being stored.
        return false;
      }
    };
    const [leadsCapabilityEnabled, tripzAiEnabled] = await Promise.all([
      safeCapabilityEnabled("leads_v1"),
      safeCapabilityEnabled("tripz_ai_v1")
    ]);
    if (message.channel === "instagram") {
      return this.recordInstagramInboundAndLoadContext(
        message as InboundMessage & { channel: "instagram"; instagramContactId: string },
        { shouldClaim, tripzAiEnabled }
      );
    }
    // Single query: upsert conversation, insert message (if new), and get agent config + history
    const result = await withTenantTransaction(this.db, message.tenantId, async (client) => {
      const previous = await client.query<{ status: string }>(
        `SELECT status
         FROM conversations
         WHERE tenant_id=$1
           AND regexp_replace(contact_phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
         ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,created_at DESC,id
         FOR UPDATE`,
        [message.tenantId, message.contactPhone]
      );
      const recorded = await client.query<{
      conversation_id: string;
      message_id: string;
      ai_active: boolean;
      agent_is_active: boolean;
      message_inserted: boolean;
      processed_at: Date | null;
      agent_config_version_id: string | null;
      system_prompt: string;
      ai_model: string;
      model_params: { temperature?: number; max_tokens?: number; reasoning_effort?: ReasoningEffort };
      updated_at: Date;
      openrouter_provider: string | null;
      openrouter_api_key_encrypted: string | null;
      media_fallback_audio: string | null;
      media_fallback_image: string | null;
      media_fallback_document: string | null;
      humanizer_config: HumanizerConfig | null;
      enabled_tools: string[];
      facebook_attribution: Record<string, unknown>;
      contact_name: string | null;
      timezone: string;
      lead_status: string | null;
      commercial_override_active: boolean;
      lead_qualification_stars: number | null;
      meeting_agendas: ConversationContext["meetingAgendas"];
      registered_lead: ConversationContext["registeredLead"] | null;
      active_appointment: ConversationContext["activeAppointment"] | null;
      history: Array<{ sender: string; content: string }>;
      }>(`
      WITH conv AS (
        INSERT INTO conversations
          (tenant_id, session_id, contact_phone, contact_name, contact_jid, facebook_attribution,
           contact_presence, contact_presence_updated_at, contact_last_seen_at, queue_id)
        SELECT $1, s.id, $3, $4, $5, $13::jsonb, 'available', now(), now(),
               (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)
        FROM whatsapp_sessions s
        WHERE s.id = $2 AND s.tenant_id = $1
        ON CONFLICT (tenant_id, session_id, contact_phone) DO UPDATE
        SET contact_name = COALESCE(
              (SELECT lead.name
               FROM scheduling_leads lead
               WHERE lead.tenant_id=$1 AND lead.name IS NOT NULL
                 AND regexp_replace(lead.phone,'\\D','','g')=regexp_replace($3,'\\D','','g')
               ORDER BY lead.updated_at DESC,lead.id
               LIMIT 1),
              EXCLUDED.contact_name,
              conversations.contact_name
            ),
            contact_jid = COALESCE(EXCLUDED.contact_jid, conversations.contact_jid),
            facebook_attribution = CASE WHEN $13::jsonb <> '{}'::jsonb THEN $13::jsonb ELSE conversations.facebook_attribution END,
            contact_presence = 'available',
            contact_presence_updated_at = now(),
            contact_last_seen_at = now(),
            status = 'open', resolved_at = NULL, last_message_at = now(),
            queue_id = CASE WHEN conversations.status='closed' THEN
              (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)
              ELSE COALESCE(conversations.queue_id,
                (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)) END
        RETURNING id, ai_active, ai_commercial_override_at, facebook_attribution, contact_name
      ),
      automatic_lead AS (
        INSERT INTO scheduling_leads(tenant_id,phone,name,source,facebook_attribution)
        SELECT $1,$3,conv.contact_name,
               CASE WHEN conv.facebook_attribution <> '{}'::jsonb THEN 'facebook' ELSE 'whatsapp' END,
               conv.facebook_attribution
        FROM conv
        WHERE $18::boolean
          AND NOT EXISTS (
          SELECT 1 FROM scheduling_leads existing
          WHERE existing.tenant_id=$1
            AND regexp_replace(existing.phone,'\\D','','g')=regexp_replace($3,'\\D','','g')
        )
        ON CONFLICT (tenant_id,phone) DO NOTHING
        RETURNING id,name,interest_category_id,unit_id,partner_id,source,status,
                  qualification_stars,qualification_answers,facebook_attribution,
                  commercial_updated_at,updated_at
      ),
      automatic_lead_event AS (
        INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,new_status,details)
        SELECT id,$1,'lead_criado',status,jsonb_build_object('origem_automatica','conversa')
        FROM automatic_lead
        RETURNING id
      ),
      msg AS (
        INSERT INTO messages
          (conversation_id, sender, content, media_type, external_message_id, provider_message_key, processing_started_at,
           media_mime_type, media_file_name, media_size_bytes, media_is_sticker)
        SELECT conv.id, 'contact', $6, $7, $8, $9, CASE WHEN $12 THEN now() ELSE NULL END, $14, $15, $16, $17 FROM conv
        ON CONFLICT (provider_message_key) DO NOTHING
        RETURNING id, sender, content, created_at, processed_at
      ),
      cancel_follow_ups AS (
        UPDATE ai_follow_up_schedules SET
          status='cancelled',next_run_at=NULL,processing_started_at=NULL,
          cancellation_reason='contact_replied',updated_at=now()
        WHERE conversation_id=(SELECT id FROM conv)
          AND EXISTS(SELECT 1 FROM msg)
          AND status IN ('scheduled','processing')
        RETURNING conversation_id
      ),
      claimed AS (
        UPDATE messages SET processing_started_at = now()
        WHERE provider_message_key = $9 AND $12
          AND processed_at IS NULL
          AND (processing_started_at IS NULL OR processing_started_at < now() - interval '10 minutes')
        RETURNING id, processed_at
      ),
      agent AS (
        SELECT v.id agent_config_version_id,v.system_prompt,v.ai_model,v.model_params,v.enabled_tools,
               a.is_active AS agent_is_active,
               t.timezone,
               s.openrouter_provider, s.openrouter_api_key_encrypted,
               COALESCE(v.activated_at,v.created_at) updated_at,
               s.media_fallback_audio, s.media_fallback_image, s.media_fallback_document, s.humanizer_config
        FROM agent_configs a
        JOIN agent_config_versions v
          ON v.id=a.active_version_id AND v.tenant_id=a.tenant_id
         AND v.agent_config_id=a.id AND v.status='active'
        JOIN tenants t ON t.id=a.tenant_id
        LEFT JOIN tenant_ai_settings s ON s.tenant_id=a.tenant_id
        WHERE a.tenant_id = $1
          AND (a.session_id = $2 OR a.session_id IS NULL)
        ORDER BY (a.session_id IS NOT NULL) DESC, a.updated_at DESC
        LIMIT 1
      ),
      lead AS (
        SELECT id,name,interest_category_id,unit_id,partner_id,source,status,
               qualification_stars,qualification_answers,facebook_attribution,
               commercial_updated_at,updated_at
        FROM automatic_lead
        UNION ALL
        SELECT existing.id,existing.name,existing.interest_category_id,existing.unit_id,
               existing.partner_id,existing.source,existing.status,
               existing.qualification_stars,existing.qualification_answers,existing.facebook_attribution,
               existing.commercial_updated_at,existing.updated_at
        FROM scheduling_leads existing
        WHERE existing.tenant_id=$1
          AND regexp_replace(existing.phone,'\\D','','g')=regexp_replace($3,'\\D','','g')
          AND NOT EXISTS (SELECT 1 FROM automatic_lead)
        LIMIT 1
      ),
      persisted_recent_history AS MATERIALIZED (
        SELECT id, sender, content, created_at FROM messages
        WHERE conversation_id = (SELECT id FROM conv)
          AND NOT (sender='agent' AND media_is_sticker)
        ORDER BY created_at DESC,id DESC
        LIMIT $10
      ),
      history_candidates AS (
        SELECT id, sender, content, created_at FROM persisted_recent_history
        UNION ALL
        -- PostgreSQL does not expose rows written by a data-modifying CTE
        -- to sibling SELECTs in the same statement. Include msg's RETURNING
        -- row explicitly so the model receives the current user turn.
        SELECT id, sender, content, created_at FROM msg
      ),
      recent_history AS MATERIALIZED (
        SELECT id,sender,content,created_at
        FROM history_candidates
        ORDER BY created_at DESC,id DESC
        LIMIT $10
      ),
      ranked_history AS (
        SELECT *,
          row_number() OVER (ORDER BY created_at DESC, id DESC) AS history_position,
          sum(char_length(content)) OVER (ORDER BY created_at DESC, id DESC) AS cumulative_characters
        FROM recent_history
      ),
      hist AS (
        SELECT json_agg(json_build_object('sender', sender, 'content', content) ORDER BY created_at DESC, id DESC) as history
        FROM ranked_history
        WHERE cumulative_characters <= $11 OR history_position = 1
      )
      SELECT
        conv.id as conversation_id,
        COALESCE(msg.id, claimed.id, (
          SELECT id FROM messages WHERE provider_message_key=$9
        )) as message_id,
        conv.ai_active,
        agent.agent_is_active,
        agent.agent_config_version_id,
        COALESCE(msg.id IS NOT NULL OR claimed.id IS NOT NULL, FALSE) as message_inserted,
        COALESCE(msg.processed_at, claimed.processed_at) AS processed_at,
        agent.system_prompt,
        agent.ai_model,
        agent.model_params,
        agent.updated_at,
        agent.openrouter_provider,
        agent.openrouter_api_key_encrypted,
        agent.media_fallback_audio,
        agent.media_fallback_image,
        agent.media_fallback_document,
        agent.humanizer_config,
        agent.enabled_tools,
        agent.timezone,
        conv.facebook_attribution,
        conv.contact_name,
        (SELECT status FROM lead) AS lead_status,
        conv.ai_commercial_override_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM lead
            WHERE GREATEST(
              COALESCE(lead.commercial_updated_at,'epoch'::timestamptz),
              COALESCE(lead.updated_at,'epoch'::timestamptz)
            ) > conv.ai_commercial_override_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduling_appointments appointment
            WHERE appointment.tenant_id=$1
              AND appointment.lead_id=(SELECT id FROM lead)
              AND appointment.status IN ('confirmado','reagendado')
              AND appointment.updated_at > conv.ai_commercial_override_at
          ) AS commercial_override_active,
        (SELECT qualification_stars FROM lead) AS lead_qualification_stars,
        (SELECT COALESCE(json_agg(json_build_object(
           'id', unit.id,
           'name', unit.name,
           'slotDurationMinutes', unit.slot_duration_min
         ) ORDER BY unit.name, unit.id), '[]'::json)
         FROM scheduling_units unit
         WHERE unit.tenant_id = $1) AS meeting_agendas,
        (SELECT json_build_object(
           'id', lead.id,
           'name', lead.name,
           'interestCategoryId', lead.interest_category_id,
           'unitId', lead.unit_id,
           'partnerId', lead.partner_id,
           'source', lead.source,
           'status', lead.status,
           'facebookAttribution', lead.facebook_attribution,
           'qualificationAnswers', lead.qualification_answers
         )
         FROM lead) AS registered_lead,
        (SELECT json_build_object(
           'id', appointment.id,
           'start', appointment.start_at,
           'status', appointment.status,
           'unitId', appointment.unit_id,
           'meetLink', appointment.meeting_url
         )
         FROM scheduling_appointments appointment
         WHERE appointment.tenant_id = $1
           AND appointment.lead_id = (SELECT id FROM lead)
           AND appointment.status IN ('confirmado','reagendado')
           AND appointment.end_at > now()
         ORDER BY appointment.start_at DESC
         LIMIT 1) AS active_appointment,
        COALESCE(hist.history, '[]'::json) as history
      FROM conv CROSS JOIN hist
      LEFT JOIN agent ON true
      LEFT JOIN msg ON true
      LEFT JOIN claimed ON true
    `, [
      message.tenantId,
      message.sessionId,
      message.contactPhone,
      message.contactName ?? null,
      message.contactJid ?? null,
      message.text,
      message.mediaType ?? null,
      message.externalId,
      this.messageKey(message),
      this.config?.AI_HISTORY_MAX_MESSAGES ?? HISTORY_MAX_MESSAGES,
      this.config?.AI_HISTORY_MAX_CHARACTERS ?? HISTORY_MAX_CHARACTERS,
      shouldClaim,
      normalizedFacebookAttribution(message.referral, message.text),
      message.mediaMimeType ?? null,
      message.mediaFileName ?? null,
      message.mediaSizeBytes ?? null,
      message.mediaIsSticker ?? false,
      leadsCapabilityEnabled
      ]);
      if (recorded.rows[0]?.message_inserted) {
        const returning = previous.rows.length > 0
          && !previous.rows.some((conversation) => conversation.status === "open")
          && previous.rows.some((conversation) => conversation.status === "closed");
        await ensureCaseAssignment(client, {
          tenantId: message.tenantId,
          selector: { conversationId: recorded.rows[0].conversation_id },
          reason: returning ? "retorno_conversa_encerrada" : "novo_contato",
          forceRotation: returning
        });
      }
      return recorded;
    });

    if (!result.rows[0]) throw new Error("Session does not belong to tenant");
    const row = result.rows[0];

    // A claiming call only proceeds when it inserted the message or atomically
    // acquired an expired/released lease. Concurrent deliveries return null.
    if (shouldClaim && !row.message_inserted) return null;

    if (!row.agent_config_version_id) {
      const alert = "Configuração ativa do agente sem versão resolvível";
      await this.db.query(
        `INSERT INTO system_alerts(tenant_id,message)
         SELECT $1,$2 WHERE NOT EXISTS (
           SELECT 1 FROM system_alerts
           WHERE tenant_id=$1 AND message=$2 AND created_at>=now()-interval '1 hour'
         )`,
        [message.tenantId, alert]
      );
      await this.markInboundProcessed(message);
      return {
        conversationId: row.conversation_id,
        messageId: row.message_id,
        agentConfigVersionId: "",
        aiActive: false,
        aiActiveColumn: row.ai_active,
        model: "",
        systemPrompt: "",
        offersGroupLink: this.config?.TRIPZ_OFFERS_GROUP_LINK,
        tripzZuluEnabled: false,
        temperature: 0,
        maxTokens: 64,
        mediaFallback: { ...DEFAULT_MEDIA_FALLBACK, video: DEFAULT_MEDIA_FALLBACK.document },
        enabledToolNames: [],
        facebookAttribution: row.facebook_attribution ?? {},
        contactName: row.contact_name ?? undefined,
        channel: "whatsapp",
        contactIdentifier: message.contactPhone,
        timeZone: row.timezone ?? "UTC",
        history: []
      };
    }

    const settings: AgentSettingsRow = {
      agent_config_version_id: row.agent_config_version_id,
      system_prompt: row.system_prompt,
      ai_model: row.ai_model,
      model_params: row.model_params,
      updated_at: row.updated_at,
      openrouter_provider: row.openrouter_provider,
      openrouter_api_key_encrypted: row.openrouter_api_key_encrypted,
      media_fallback_audio: row.media_fallback_audio,
      media_fallback_image: row.media_fallback_image,
      media_fallback_document: row.media_fallback_document,
      humanizer_config: row.humanizer_config,
      enabled_tools: Array.isArray(row.enabled_tools) ? row.enabled_tools : []
    };
    const stateToolGatingEnabled = await this.stateToolGatingEnabled(message.tenantId);

    const configuredKey = settings.openrouter_api_key_encrypted && this.config
      ? decryptSecret(settings.openrouter_api_key_encrypted, {
        current: this.config.DATA_ENCRYPTION_KEY,
        previous: this.config.DATA_ENCRYPTION_KEY_PREVIOUS ? [this.config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
        legacy: [this.config.JWT_SECRET]
      }) : undefined;

    const history = Array.isArray(row.history) ? row.history : [];
    return {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      agentConfigVersionId: settings.agent_config_version_id,
      // The global agent switch and the conversation switch are independent.
      // Keep the global state out of the settings cache so disabling the agent
      // takes effect on the very next inbound message.
      aiActive: row.ai_active && row.agent_is_active && !commercialStateBlocksAiAutomation({
        leadStatus: row.lead_status,
        unresolvedAppointment: Boolean(row.active_appointment),
        overrideActive: row.commercial_override_active
      }),
      aiActiveColumn: row.ai_active,
      model: settings.ai_model,
      provider: settings.openrouter_provider ?? undefined,
      systemPrompt: settings.system_prompt,
      offersGroupLink: this.config?.TRIPZ_OFFERS_GROUP_LINK,
      tripzZuluEnabled: tripzAiEnabled,
      temperature: settings.model_params.temperature ?? 0.4,
      maxTokens: settings.model_params.max_tokens ?? 512,
      reasoningEffort: settings.model_params.reasoning_effort ?? "medium",
      openRouterApiKey: configuredKey,
      mediaFallback: {
        audio: settings.media_fallback_audio ?? DEFAULT_MEDIA_FALLBACK.audio,
        image: settings.media_fallback_image ?? DEFAULT_MEDIA_FALLBACK.image,
        document: settings.media_fallback_document ?? DEFAULT_MEDIA_FALLBACK.document,
        video: settings.media_fallback_document ?? DEFAULT_MEDIA_FALLBACK.document
      },
      humanizer: this.config ? migrateHumanizerConfig(settings.humanizer_config ?? DEFAULT_HUMANIZER_CONFIG) : undefined,
      enabledToolNames: settings.enabled_tools,
      stateToolGatingEnabled,
      facebookAttribution: row.facebook_attribution ?? {},
      contactName: row.contact_name ?? undefined,
      channel: "whatsapp",
      contactIdentifier: message.contactPhone,
      timeZone: row.timezone,
      leadStatus: row.lead_status ?? undefined,
      commercialAutomationOverride: row.commercial_override_active,
      leadQualificationStars: row.lead_qualification_stars ?? undefined,
      meetingAgendas: Array.isArray(row.meeting_agendas) ? row.meeting_agendas : [],
      registeredLead: row.registered_lead ?? undefined,
      activeAppointment: row.active_appointment ?? undefined,
      history: history.reverse().map((item) => ({
        role: item.sender === "contact" ? "user" as const : "assistant" as const,
        content: item.content
      }))
    };
  }

  async releaseInboundProcessing(message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId">): Promise<void> {
    await this.db.query(
      `UPDATE messages SET processing_started_at = NULL
       WHERE provider_message_key = $1 AND sender = 'contact' AND processed_at IS NULL`,
      [this.messageKey(message)]
    );
  }

  async recordAudioTranscription(
    message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId">,
    transcription: string
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE messages SET content=$2
       WHERE provider_message_key=$1 AND sender='contact' AND media_type='audio'`,
      [this.messageKey(message), transcription]
    );
    if (result.rowCount === 0) throw new Error("Inbound audio message was not found for transcription");
  }

  async findAudioTranscription(
    message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId">
  ): Promise<string | undefined> {
    const result = await this.db.query<{ content: string }>(
      `SELECT content FROM messages
       WHERE provider_message_key=$1 AND sender='contact' AND media_type='audio' AND content <> ''`,
      [this.messageKey(message)]
    );
    return result.rows[0]?.content;
  }

  async recordMediaAnalysis(
    message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId" | "mediaType">,
    analysis: string
  ): Promise<void> {
    if (message.mediaType !== "image" && message.mediaType !== "document") {
      throw new Error("Media analysis only supports images and documents");
    }
    const result = await this.db.query(
      `UPDATE messages SET content=$3
       WHERE provider_message_key=$1 AND sender='contact' AND media_type=$2`,
      [this.messageKey(message), message.mediaType, analysis]
    );
    if (result.rowCount === 0) throw new Error("Inbound visual/document media was not found for analysis");
  }

  async findMediaAnalysis(
    message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId" | "mediaType">
  ): Promise<string | undefined> {
    if (message.mediaType !== "image" && message.mediaType !== "document") return undefined;
    const result = await this.db.query<{ content: string }>(
      `SELECT content FROM messages
       WHERE provider_message_key=$1 AND sender='contact' AND media_type=$2
         AND content LIKE '[MÍDIA ANALISADA PELA IA:%'`,
      [this.messageKey(message), message.mediaType]
    );
    return result.rows[0]?.content;
  }

  async recordAgentReply(input: {
    tenantId: string; sessionId: string; conversationId: string; text: string; model: string;
    agentConfigVersionId?: string;
    externalId: string; inboundExternalId: string; inboundExternalIds?: string[]; createdAt?: Date;
    bubbles?: Array<{ text: string; externalId: string; createdAt: Date }>;
    transactionClaims?: TransactionalClaim[];
    /** Persiste uma resposta parcial sem concluir o processamento nem iniciar follow-up. */
    intermediate?: boolean;
    /** @deprecated Usage from OpenRouter must be persisted through recordAiUsage per provider response. */
    inputTokens?: number; outputTokens?: number; costUsd?: number;
  }): Promise<void> {
    const inboundExternalIds = Array.from(new Set([input.inboundExternalId, ...(input.inboundExternalIds ?? [])]));
    const inboundProviderKeys = inboundExternalIds.map((externalId) => this.messageKey({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      externalId
    }));
    const followUpEvent = await withTenantTransaction(this.db, input.tenantId, async (client) => {
      const deliveries = input.bubbles?.length
        ? input.bubbles
        : [{ text: input.text, externalId: input.externalId, createdAt: input.createdAt ?? new Date() }];
      let firstInserted: { id: string; created_at: Date } | undefined;
      let lastInserted: { id: string; created_at: Date } | undefined;
      for (const delivery of deliveries) {
        const inserted = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO messages (conversation_id, sender, content, ai_model_used, agent_config_version_id, external_message_id, provider_message_key, created_at)
           SELECT c.id, 'agent', $3, $4, COALESCE($5,a.active_version_id), $6, $7, $8
           FROM conversations c
           JOIN LATERAL (
             SELECT active_version_id FROM agent_configs
             WHERE tenant_id=c.tenant_id
               AND (session_id=c.session_id OR session_id IS NULL)
             ORDER BY (session_id IS NOT NULL) DESC, updated_at DESC,id LIMIT 1
           ) a ON true
           WHERE c.id = $1 AND c.tenant_id = $2
           ON CONFLICT (provider_message_key) DO UPDATE SET sender='agent', content=EXCLUDED.content,
             ai_model_used=EXCLUDED.ai_model_used,agent_config_version_id=EXCLUDED.agent_config_version_id,media_type=NULL
           RETURNING id,created_at`,
          [input.conversationId, input.tenantId, delivery.text, input.model, input.agentConfigVersionId,
            delivery.externalId, this.messageKey({ ...input, externalId: delivery.externalId }), delivery.createdAt]
        );
        if (!inserted.rows[0]) throw new Error("Conversation does not belong to tenant");
        firstInserted ??= inserted.rows[0];
        lastInserted = inserted.rows[0];
      }
      if (!firstInserted || !lastInserted) throw new Error("Agent reply did not contain a message");
      // The delayed fallback is suppressed only after Evolution already
      // accepted the normal agent reply and that reply is durably recorded.
      // Merely observing Meet readiness in the tool journal is not sufficient:
      // the later outbound send could still fail.
      // Suppression is intentionally not gated by scheduling_meet_outbox_v2: an outbox
      // persisted while the flag was ON must still be suppressed after the flag or the
      // kill switch is turned off, otherwise the reconciler resends the same link.
      await client.query(
        `UPDATE scheduling_meeting_contact_delivery_outbox outbox
         SET status='suppressed',completed_at=now(),processing_started_at=NULL,
             last_error=NULL,updated_at=now()
         WHERE outbox.tenant_id=$1 AND outbox.conversation_id=$2
           AND outbox.status IN ('pending','processing')
           AND outbox.attempted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM unnest($3::text[]) delivered(content)
             WHERE position(outbox.meet_url in delivered.content) > 0
           )`,
        [input.tenantId, input.conversationId, deliveries.map((delivery) => delivery.text)]
      );
      for (const claim of input.transactionClaims ?? []) {
        const claimValueHash = payloadFingerprint({
          action: claim.action,
          claimType: claim.claimType,
          normalizedValue: claim.normalizedValue
        });
        const insertedClaim = await client.query(
          `INSERT INTO agent_message_transaction_claims(
             tenant_id,conversation_id,message_id,journal_id,action,claim_type,normalized_value,value_hash
           )
           SELECT $1,$2,m.id,j.id,$5,$6,$7,$8
           FROM messages m
           JOIN conversations c ON c.id=m.conversation_id AND c.id=$2 AND c.tenant_id=$1
           JOIN ai_tool_call_journal j
             ON j.id=$4 AND j.tenant_id=c.tenant_id AND j.conversation_id=c.id
           WHERE m.id=$3 AND j.tool_name=$9
           ON CONFLICT(message_id,journal_id,claim_type) DO NOTHING
           RETURNING id`,
          [
            input.tenantId,
            input.conversationId,
            firstInserted.id,
            claim.journalId,
            claim.action,
            claim.claimType,
            claim.normalizedValue,
            claimValueHash,
            transactionalToolName(claim.action)
          ]
        );
        if (!insertedClaim.rows[0]) {
          const replay = await client.query<{ identical: boolean }>(
            `SELECT (
               tenant_id=$1
               AND conversation_id=$2
               AND action=$5
               AND normalized_value=$7
               AND value_hash=$8
             ) AS identical
             FROM agent_message_transaction_claims
             WHERE message_id=$3 AND journal_id=$4 AND claim_type=$6`,
            [
              input.tenantId,
              input.conversationId,
              firstInserted.id,
              claim.journalId,
              claim.action,
              claim.claimType,
              claim.normalizedValue,
              claimValueHash
            ]
          );
          if (replay.rows[0]?.identical) continue;
          if (replay.rows[0]) {
            throw new Error("Transactional claim replay conflicts with immutable evidence");
          }
          throw new Error("Transactional claim journal does not belong to the agent reply");
        }
      }
      if (input.inputTokens !== undefined && input.outputTokens !== undefined && input.costUsd !== undefined) {
        await client.query(
          `INSERT INTO usage_logs (tenant_id, conversation_id, ai_model, input_tokens, output_tokens, cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.tenantId, input.conversationId, input.model, input.inputTokens, input.outputTokens, input.costUsd]
        );
      }
      if (!input.intermediate) {
        await client.query(
          `UPDATE messages m SET processed_at = now() FROM conversations c
           WHERE m.conversation_id=c.id AND c.tenant_id=$1
             AND m.provider_message_key = ANY($2::text[]) AND m.sender='contact'`,
          [input.tenantId, inboundProviderKeys]
        );
        return scheduleAiFollowUpsAfterAgentReply(client, {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          agentMessageId: lastInserted.id,
          sentAt: lastInserted.created_at
        });
      }
      return null;
    });
    if (followUpEvent) {
      try {
        await this.eventEnqueuers.followUp(followUpEvent.conversationId, {
          sequenceVersion: followUpEvent.sequenceVersion,
          dueAt: followUpEvent.nextRunAt
        });
      } catch {
        // The durable schedule is the recovery source; the low-frequency
        // reconciler will repair a commit -> enqueue interruption.
      }
    }
  }

  async recordAiUsage(input: {
    tenantId: string; conversationId: string; messageId?: string; providerRequestId?: string; model: string;
    inputTokens: number; outputTokens: number; reasoningTokens?: number; cachedInputTokens?: number;
    cacheWriteInputTokens?: number; costUsd: number; requestId?: string; processingAttempt?: number;
    providerRequestIndex?: number; callReason?: string; durationMs?: number; toolsUsed?: string[];
    systemPromptCharacters?: number; historyMessageCount?: number; historyCharacters?: number;
    requestMessageCharacters?: number; toolSchemaCharacters?: number; toolResultCharacters?: number;
  }): Promise<void> {
    const owner = await this.db.query(
      "SELECT 1 FROM conversations WHERE id=$1 AND tenant_id=$2",
      [input.conversationId, input.tenantId]
    );
    if (!owner.rows[0]) throw new Error("Conversation does not belong to tenant");
    const result = await this.db.query(
      `INSERT INTO usage_logs
         (tenant_id, conversation_id, message_id, ai_model, input_tokens, output_tokens,
          reasoning_tokens, cached_input_tokens, cache_write_input_tokens, cost_usd,
          provider_request_id, request_id, processing_attempt, provider_request_index,
          call_reason, duration_ms, tools_used, system_prompt_characters,
          history_message_count, history_characters, request_message_characters,
          tool_schema_characters, tool_result_characters)
       SELECT c.tenant_id, c.id, m.id, $4, $5, $6, $7, $8, $9, $10,
              $11, $12::uuid, $13, $14, $15, $16, $17::text[], $18, $19, $20, $21, $22, $23
       FROM conversations c
       LEFT JOIN messages m ON m.id=$3 AND m.conversation_id=c.id
       WHERE c.id=$2 AND c.tenant_id=$1
       ON CONFLICT (provider_request_id) WHERE provider_request_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.tenantId, input.conversationId, input.messageId ?? null, input.model,
        input.inputTokens, input.outputTokens, input.reasoningTokens ?? 0,
        input.cachedInputTokens ?? 0, input.cacheWriteInputTokens ?? 0, input.costUsd,
        input.providerRequestId ?? null, input.requestId ?? null, input.processingAttempt ?? null,
        input.providerRequestIndex ?? null, input.callReason ?? null, input.durationMs ?? null,
        input.toolsUsed ?? [], input.systemPromptCharacters ?? null, input.historyMessageCount ?? null,
        input.historyCharacters ?? null, input.requestMessageCharacters ?? null,
        input.toolSchemaCharacters ?? null, input.toolResultCharacters ?? null
      ]
    );
    if (!result.rows[0] && !input.providerRequestId) throw new Error("Failed to record AI usage");
  }

  async getAiUsageTotals(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    requestId: string;
  }): Promise<{ providerRequests: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const result = await this.db.query<{
      provider_requests: number;
      input_tokens: string;
      output_tokens: string;
      cost_usd: string;
    }>(
      `SELECT count(*)::int AS provider_requests,
              COALESCE(sum(input_tokens),0)::text AS input_tokens,
              COALESCE(sum(output_tokens),0)::text AS output_tokens,
              COALESCE(sum(cost_usd),0)::text AS cost_usd
       FROM usage_logs
       WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3 AND request_id=$4::uuid`,
      [input.tenantId, input.conversationId, input.messageId, input.requestId]
    );
    const row = result.rows[0];
    return {
      providerRequests: Number(row?.provider_requests ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0)
    };
  }


  async recordFallback(input: { tenantId: string; sessionId: string; conversationId: string; agentConfigVersionId?: string; mediaType: MediaType; text: string; externalId: string }): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO messages (conversation_id, sender, content, agent_config_version_id, media_type, external_message_id, provider_message_key)
         SELECT c.id, 'agent', $3, COALESCE($4,a.active_version_id), $5, $6, $7
         FROM conversations c
         JOIN LATERAL (
           SELECT active_version_id FROM agent_configs
           WHERE tenant_id=c.tenant_id
             AND (session_id=c.session_id OR session_id IS NULL)
           ORDER BY (session_id IS NOT NULL) DESC, updated_at DESC,id LIMIT 1
         ) a ON true
         WHERE c.id=$1 AND c.tenant_id=$2
         ON CONFLICT (provider_message_key) DO UPDATE SET
           sender='agent',content=EXCLUDED.content,agent_config_version_id=EXCLUDED.agent_config_version_id,media_type=EXCLUDED.media_type
         RETURNING id,created_at`,
        [input.conversationId, input.tenantId, input.text, input.agentConfigVersionId,
          input.mediaType, input.externalId, this.messageKey(input)]
      );
      if (!inserted.rows[0]) throw new Error("Conversation does not belong to tenant");
      await scheduleAiFollowUpsAfterAgentReply(client, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        agentMessageId: inserted.rows[0].id,
        sentAt: inserted.rows[0].created_at
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markInboundProcessed(
    message: Pick<InboundMessage, "tenantId" | "sessionId" | "externalId">,
    externalIds?: string[]
  ): Promise<void> {
    const ids = externalIds?.length ? externalIds : [message.externalId];
    const keys = ids.map((externalId) => this.messageKey({ ...message, externalId }));
    await this.db.query(
      "UPDATE messages SET processed_at = now() WHERE provider_message_key = ANY($1::text[]) AND sender = 'contact'",
      [keys]
    );
  }

  async findPendingContactTextMessages(conversationId: string, fromExternalId: string): Promise<PendingContactTextMessage[]> {
    const result = await this.db.query<{ external_message_id: string; content: string }>(
      `WITH anchor AS (
         SELECT created_at, id FROM messages
         WHERE conversation_id = $1 AND sender = 'contact' AND external_message_id = $2
         LIMIT 1
       )
       SELECT m.external_message_id, m.content
       FROM messages m, anchor a
       WHERE m.conversation_id = $1
         AND m.sender = 'contact'
         AND m.media_type IS NULL
         AND m.processed_at IS NULL
         AND m.external_message_id IS NOT NULL
         AND (m.created_at, m.id) >= (a.created_at, a.id)
       ORDER BY m.created_at, m.id`,
      [conversationId, fromExternalId]
    );
    return result.rows.map((row) => ({ externalId: row.external_message_id, text: row.content }));
  }

  async findUnreadContactMessages(conversationId: string, throughExternalId: string): Promise<string[]> {
    const result = await this.db.query(
      `WITH anchor AS (
         SELECT created_at, id FROM messages
         WHERE conversation_id = $1 AND sender = 'contact' AND external_message_id = $2
         LIMIT 1
       )
       SELECT m.external_message_id FROM messages m, anchor a
       WHERE m.conversation_id = $1 AND m.sender = 'contact' AND m.status != 'read'
         AND m.external_message_id IS NOT NULL
         AND (m.created_at, m.id) <= (a.created_at, a.id)
       ORDER BY m.created_at, m.id`,
      [conversationId, throughExternalId]
    );
    return result.rows.map(r => r.external_message_id);
  }

  async markContactMessagesRead(conversationId: string, externalIds: string[]): Promise<void> {
    if (!externalIds.length) return;
    await this.db.query(
      `UPDATE messages SET status = 'read'
       WHERE conversation_id = $1 AND sender = 'contact'
         AND external_message_id = ANY($2::text[]) AND status != 'read'`,
      [conversationId, externalIds]
    );
  }

  async updateMessageStatus(message: { tenantId: string; sessionId: string; externalId: string; status: MessageDeliveryStatus }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE messages SET status = $2
       WHERE provider_message_key = $1 AND sender IN ('agent', 'human')
         AND (
           ($2 = 'failed' AND status = 'sent')
           OR
           ($2 != 'failed' AND (
             status = 'failed'
             OR array_position(ARRAY['sent','delivered','read'], status)
                < array_position(ARRAY['sent','delivered','read'], $2)
           ))
         )`,
      [this.messageKey(message), message.status]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async confirmInstagramEcho(message: {
    tenantId: string; sessionId: string; externalId: string;
  }): Promise<boolean> {
    const result = await this.db.query<{ conversation_id: string }>(
      `UPDATE messages m SET status=CASE WHEN m.status='failed' THEN 'sent' ELSE m.status END
       FROM conversations c
       WHERE m.conversation_id=c.id AND c.tenant_id=$1 AND c.session_id=$2
         AND c.instagram_contact_id IS NOT NULL AND c.contact_phone IS NULL
         AND m.provider_message_key=$3 AND m.sender IN ('agent','human')
       RETURNING m.conversation_id`,
      [message.tenantId, message.sessionId, this.messageKey(message)]
    );
    if (result.rows[0]) {
      await this.notifyConversationMessagesChanged(message.tenantId, result.rows[0].conversation_id);
      return true;
    }
    return false;
  }

  async updateInstagramMessageReaction(message: {
    tenantId: string; sessionId: string; externalId: string; emoji: string | null;
  }): Promise<boolean> {
    const result = await this.db.query<{ conversation_id: string }>(
      `UPDATE messages m SET reaction_emoji=$4
       FROM conversations c
       WHERE m.conversation_id=c.id AND c.tenant_id=$1 AND c.session_id=$2
         AND c.instagram_contact_id IS NOT NULL AND c.contact_phone IS NULL
         AND m.provider_message_key=$3
       RETURNING m.conversation_id`,
      [message.tenantId, message.sessionId, this.messageKey(message), message.emoji]
    );
    if (result.rows[0]) {
      await this.notifyConversationMessagesChanged(message.tenantId, result.rows[0].conversation_id);
      return true;
    }
    return false;
  }

  private async notifyConversationMessagesChanged(tenantId: string, conversationId: string): Promise<void> {
    await this.db.query(
      `SELECT pg_notify('atendon_realtime_changes',json_build_object(
         'v',1,'type','conversation.messages.changed','workspaceId',$1::text,'conversationId',$2::text
       )::text)`,
      [tenantId, conversationId]
    );
  }

  async pauseForHandoff(input: {
    tenantId: string;
    conversationId: string;
    sessionId: string;
    reason: "contact_requested" | "technical_failure";
    errorCode?: string;
    assigneeName?: string;
    idempotencyKey: string;
    notificationText: string;
  }): Promise<HandoffNotification | null> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const namedAssignee = input.assigneeName
        ? await assignConversationToNamedAttendant(client, {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            assigneeName: input.assigneeName
          })
        : null;
      const conversation = await client.query<{ attendant_phone: string | null; contact_phone: string }>(
        `UPDATE conversations c
         SET ai_active = false,
             handoff_reason = $3,
             handoff_error_code = CASE WHEN $3='technical_failure' THEN $5 ELSE NULL END
         FROM tenants t
         WHERE c.id = $1 AND c.tenant_id = $2 AND c.session_id = $4 AND t.id = c.tenant_id
         RETURNING t.attendant_phone,c.contact_phone`,
        [input.conversationId, input.tenantId, input.reason, input.sessionId, input.errorCode ?? null]
      );
      if (!conversation.rows[0]) throw new Error("Conversation not found for workspace and WhatsApp session");
      if (input.assigneeName && !namedAssignee) {
        const alertMessage = `A IA pausou uma conversa para ${input.assigneeName}, mas não encontrou um atendente ativo e inequívoco com esse nome.`;
        await client.query(
          `INSERT INTO system_alerts(tenant_id,message)
           SELECT $1,$2
           WHERE NOT EXISTS (
             SELECT 1 FROM system_alerts
             WHERE tenant_id=$1 AND message=$2 AND created_at >= now()-interval '1 hour'
           )`,
          [input.tenantId, alertMessage]
        );
      }
      const phone = conversation.rows[0]?.attendant_phone?.trim();
      if (!phone || !/^\d{10,15}$/.test(phone)) {
        const alertMessage = "A IA pausou uma conversa para atendimento humano, mas o workspace não possui telefone de atendente válido configurado.";
        await client.query(
          `INSERT INTO system_alerts(tenant_id,message)
           SELECT $1,$2
           WHERE NOT EXISTS (
             SELECT 1 FROM system_alerts
             WHERE tenant_id=$1 AND message=$2 AND created_at >= now()-interval '1 hour'
           )`,
          [input.tenantId, alertMessage]
        );
        await client.query("COMMIT");
        return null;
      }

      const notification = await client.query<{
        id: string;
        session_id: string;
        attendant_phone: string;
        message: string;
      }>(
        `INSERT INTO handoff_notifications
           (tenant_id, conversation_id, session_id, idempotency_key, attendant_phone, message)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET message = EXCLUDED.message
         RETURNING id, session_id, attendant_phone, message`,
        [input.tenantId, input.conversationId, input.sessionId, input.idempotencyKey, phone, input.notificationText]
      );
      await client.query("COMMIT");
      const row = notification.rows[0];
      return { id: row.id, sessionId: row.session_id, attendantPhone: row.attendant_phone, message: row.message };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sinaliza para o painel que esta conversa parou de receber resposta
   * automática porque o agente está desativado (globalmente ou por regra
   * comercial), sem que isso tenha sido uma pausa manual nem um pedido do
   * contato. Diferente de `pauseForHandoff`, não exige telefone de atendente
   * configurado nem dispara notificação: é só a transição de estado que
   * torna a conversa visível no filtro humano ("Abertas") em vez de ficar
   * presa como se ainda pertencesse à IA. Condicional em `ai_active=true`
   * para nunca sobrescrever um handoff mais específico já registrado por
   * outro caminho concorrente (pedido do contato, pausa manual, etc.).
   */
  async markAiUnavailable(tenantId: string, conversationId: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations
       SET ai_active=false, handoff_reason='agent_disabled'
       WHERE id=$1 AND tenant_id=$2 AND ai_active=true`,
      [conversationId, tenantId]
    );
  }

  async getPendingHandoffNotification(id: string): Promise<HandoffNotification | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      attendant_phone: string;
      message: string;
    }>(
      `SELECT id, session_id, attendant_phone, message
       FROM handoff_notifications WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    const row = result.rows[0];
    return row ? { id: row.id, sessionId: row.session_id, attendantPhone: row.attendant_phone, message: row.message } : null;
  }

  async findPendingHandoffNotificationIds(limit = 100): Promise<string[]> {
    return (await this.findPendingHandoffNotificationPage(limit)).ids;
  }

  async findPendingHandoffNotificationPage(
    limit = 100,
    cursor?: string
  ): Promise<{ ids: string[]; nextCursor: string | null; oldestAgeMs: number }> {
    const result = await this.db.query<{ id: string; oldest_age_ms: number }>(
      `SELECT id,
              COALESCE(max(extract(epoch FROM (now()-created_at))*1000) OVER (),0)::float oldest_age_ms
       FROM handoff_notifications
       WHERE status='pending'
         AND ($2::uuid IS NULL OR (created_at,id) > (
           SELECT created_at,id FROM handoff_notifications WHERE id=$2
         ))
       ORDER BY created_at,id
       LIMIT $1`,
      [limit, cursor ?? null]
    );
    const ids = result.rows.map((row) => row.id);
    return {
      ids,
      nextCursor: ids.length === limit ? ids.at(-1)! : null,
      oldestAgeMs: result.rows[0]?.oldest_age_ms ?? 0
    };
  }

  async markHandoffNotificationSent(id: string, externalMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE handoff_notifications
       SET status = 'sent', sent_at = now(), external_message_id = $2, last_error = NULL
       WHERE id = $1 AND status = 'pending'`,
      [id, externalMessageId]
    );
  }

  async recordHandoffNotificationFailure(id: string, error: unknown, terminal = false): Promise<void> {
    await this.db.query(
      `UPDATE handoff_notifications
       SET attempts = attempts + CASE WHEN $3 THEN 0 ELSE 1 END, last_error = $2,
           status = CASE WHEN $3 THEN 'failed' ELSE status END
       WHERE id = $1 AND status = 'pending'`,
      [id, error instanceof Error ? error.message : String(error), terminal]
    );
  }

  async createSystemAlertOnce(tenantId: string, message: string): Promise<void> {
    await this.db.query(
      `INSERT INTO system_alerts(tenant_id,message)
       SELECT $1,$2
       WHERE NOT EXISTS (
         SELECT 1 FROM system_alerts
         WHERE tenant_id=$1 AND message=$2 AND created_at >= now()-interval '1 hour'
       )`,
      [tenantId, message]
    );
  }

  async createConnectionAlertOnce(tenantId: string, sessionId: string, message: string): Promise<void> {
    if (typeof this.db.connect !== "function") {
      await this.createSystemAlertOnce(tenantId, message);
      return;
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`system-alert:connection:${tenantId}:${sessionId}`]);
      await client.query(
        `INSERT INTO system_alerts(tenant_id,message)
         SELECT $1,$2
         WHERE NOT EXISTS (
           SELECT 1 FROM system_alerts
           WHERE tenant_id=$1 AND message=$2 AND created_at >= now()-interval '1 hour'
         )`,
        [tenantId, message]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reactivate(tenantId: string, conversationId: string): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT id FROM conversations WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [conversationId, tenantId]
      );
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE conversations SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL,
             ai_commercial_override_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [conversationId, tenantId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async sendManualMessageOnce(
    input: ManualOutboundInput,
    send: () => Promise<{ externalId: string }>
  ): Promise<{ externalId: string; duplicate: boolean }> {
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const requestHash = input.mediaType
      ? payloadFingerprint({
        conversationId: input.conversationId,
        text: input.text,
        mediaType: input.mediaType,
        mediaMimeType: input.mediaMimeType ?? null,
        mediaFileName: input.mediaFileName ?? null,
        mediaSizeBytes: input.mediaSizeBytes ?? null,
        contentFingerprint: input.contentFingerprint ?? null
      })
      : payloadFingerprint({ conversationId: input.conversationId, text: input.text });
    const recoveryPayload = input.mediaType ? null : JSON.stringify({
      sendText: input.sendText ?? input.text,
      displayText: input.text,
      sentByUserId: input.sentByUserId
    });
    const claimed = await this.db.query<{ id: string }>(
      `INSERT INTO outbound_message_requests(tenant_id,conversation_id,idempotency_key,request_hash,recovery_payload)
       SELECT $1,c.id,$3,$4,$6::jsonb FROM conversations c
       WHERE c.id=$2 AND c.tenant_id=$1 AND c.session_id=$5
       ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.conversationId, idempotencyKey, requestHash, input.sessionId, recoveryPayload]
    );

    if (!claimed.rows[0]) {
      for (let attempt = 0; attempt < IDEMPOTENCY_WAIT_ATTEMPTS; attempt += 1) {
        const previous = await this.db.query<{
          request_hash: string;
          status: "pending" | "sent" | "failed" | "ambiguous";
          external_message_id: string | null;
          error_message: string | null;
          stale: boolean;
        }>(
          `SELECT request_hash,status,external_message_id,error_message,
                  processing_started_at < now() - interval '5 minutes' AS stale
           FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2`,
          [input.tenantId, idempotencyKey]
        );
        const row = previous.rows[0];
        if (!row) throw new Error("Conversation does not belong to tenant or session");
        if (row.request_hash.trim() !== requestHash) throw conflict("Idempotency-Key já foi usada com outro conteúdo");
        if (row.status === "sent" && row.external_message_id) return { externalId: row.external_message_id, duplicate: true };
        if (row.status === "failed") throw conflict(`Envio anterior falhou: ${row.error_message ?? "erro desconhecido"}`);
        if (row.status === "ambiguous") throw conflict("O WhatsApp pode ter aceitado o envio anterior; confirme no histórico antes de tentar novamente");
        if (row.stale) break;
        await wait(IDEMPOTENCY_WAIT_MS);
      }
      const expired = await this.db.query(
        `UPDATE outbound_message_requests
         SET status='failed',error_message='Reserva expirada; confirme o estado antes de reenviar',completed_at=now()
         WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'
           AND processing_started_at < now() - interval '5 minutes'
         RETURNING id`,
        [input.tenantId, idempotencyKey]
      );
      if (expired.rows[0]) throw conflict("Reserva de envio expirada; use uma nova Idempotency-Key após confirmar o estado");
      throw conflict("Envio com esta Idempotency-Key ainda está em andamento");
    }

    let sent: { externalId: string };
    try {
      sent = await send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `UPDATE outbound_message_requests
         SET status=$3,error_message=$4,completed_at=now()
         WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`,
        [input.tenantId, idempotencyKey, isWhatsAppSendRejectedError(error) ? "failed" : "ambiguous", message]
      );
      throw error;
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query(
        `UPDATE conversations SET contact_jid=COALESCE($4,contact_jid),last_message_at=now()
         WHERE id=$1 AND tenant_id=$2 AND session_id=$3 RETURNING id`,
        [input.conversationId, input.tenantId, input.sessionId, input.contactJid ?? null]
      );
      if (!conversation.rows[0]) throw new Error("Conversation disappeared before outbound message could be recorded");
      const recorded = await client.query(
        `INSERT INTO messages
           (conversation_id,sender,content,media_type,external_message_id,provider_message_key,
            media_mime_type,media_file_name,media_size_bytes,sent_by_user_id,reply_to_message_id)
         SELECT c.id,'human',$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM conversations c
         WHERE c.id=$1 AND c.tenant_id=$2 AND c.session_id=$3
         ON CONFLICT(provider_message_key) DO NOTHING`,
        [input.conversationId, input.tenantId, input.sessionId, input.text, input.mediaType ?? null, sent.externalId,
          this.messageKey({ tenantId: input.tenantId, sessionId: input.sessionId, externalId: sent.externalId }),
          input.mediaMimeType ?? null, input.mediaFileName ?? null, input.mediaSizeBytes ?? null, input.sentByUserId,
          input.replyToMessageId ?? null]
      );
      if ((recorded.rowCount ?? 0) === 0) {
        const exists = await client.query("SELECT 1 FROM messages WHERE provider_message_key=$1", [
          this.messageKey({ tenantId: input.tenantId, sessionId: input.sessionId, externalId: sent.externalId })
        ]);
        if (!exists.rows[0]) throw new Error("Conversation disappeared before outbound message could be recorded");
      }
      await client.query(
        `UPDATE outbound_message_requests
         SET status='sent',external_message_id=$3,error_message=NULL,recovery_payload=NULL,completed_at=now()
         WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`,
        [input.tenantId, idempotencyKey, sent.externalId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `UPDATE outbound_message_requests
         SET status='ambiguous',external_message_id=COALESCE(external_message_id,$3),
             error_message=$4,completed_at=now()
         WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`,
        [input.tenantId, idempotencyKey, sent.externalId, message]
      );
      throw error;
    } finally {
      client.release();
    }
    return { externalId: sent.externalId, duplicate: false };
  }

  async failedMessageRecoverySummary(tenantId: string): Promise<FailedMessageRecoverySummary> {
    const result = await this.db.query<{
      available: number;
      ambiguous: number;
      has_connected_session: boolean;
      legacy_unrecoverable: number;
      oldest_at: Date | null;
    }>(
      `SELECT
        count(*) FILTER (WHERE request.status='failed' AND request.recovery_payload IS NOT NULL AND connection.channel='whatsapp')::int AS available,
        count(*) FILTER (WHERE request.status='ambiguous' AND connection.channel='whatsapp')::int AS ambiguous,
        count(*) FILTER (WHERE request.status='failed' AND request.recovery_payload IS NULL AND connection.channel='whatsapp')::int AS legacy_unrecoverable,
        min(request.created_at) FILTER (WHERE request.status='failed' AND request.recovery_payload IS NOT NULL AND connection.channel='whatsapp') AS oldest_at,
        EXISTS (
          SELECT 1
          FROM outbound_message_requests recoverable
          JOIN conversations conversation
            ON conversation.id=recoverable.conversation_id AND conversation.tenant_id=recoverable.tenant_id
          JOIN whatsapp_sessions connection
            ON connection.id=conversation.session_id AND connection.tenant_id=conversation.tenant_id
          WHERE recoverable.tenant_id=$1 AND recoverable.status='failed'
            AND recoverable.recovery_payload IS NOT NULL
            AND connection.channel='whatsapp' AND connection.archived_at IS NULL AND connection.status='connected'
        ) AS has_connected_session
      FROM outbound_message_requests request
      JOIN conversations conversation ON conversation.id=request.conversation_id AND conversation.tenant_id=request.tenant_id
      JOIN whatsapp_sessions connection ON connection.id=conversation.session_id AND connection.tenant_id=conversation.tenant_id
      WHERE request.tenant_id=$1`,
      [tenantId]
    );
    const row = result.rows[0];
    return {
      available: Number(row?.available ?? 0),
      ambiguous: Number(row?.ambiguous ?? 0),
      has_connected_session: Boolean(row?.has_connected_session),
      legacy_unrecoverable: Number(row?.legacy_unrecoverable ?? 0),
      oldest_at: row?.oldest_at?.toISOString() ?? null
    };
  }

  async recoverFailedManualMessages(
    tenantId: string,
    send: (input: { sessionId: string; destination: string; text: string }) => Promise<{ externalId: string }>,
    limit = 25
  ): Promise<FailedMessageRecoveryResult> {
    type RecoveryRow = {
      id: string;
      conversation_id: string;
      session_id: string;
      contact_phone: string;
      contact_jid: string | null;
      recovery_payload: unknown;
    };
    const claim = await this.db.connect();
    let rows: RecoveryRow[] = [];
    try {
      await claim.query("BEGIN");
      // A crashed recovery may have reached WhatsApp before local persistence.
      // Never resend such an unknown outcome; surface it for manual review.
      await claim.query(
        `UPDATE outbound_message_requests
         SET status='ambiguous',error_message='Recuperação interrompida após início do envio',completed_at=now()
         WHERE tenant_id=$1 AND status='pending' AND recovery_attempts>0
           AND recovery_payload IS NOT NULL
           AND processing_started_at < now()-interval '5 minutes'
           AND EXISTS (
             SELECT 1 FROM conversations c
             JOIN whatsapp_sessions s ON s.id=c.session_id AND s.tenant_id=c.tenant_id
             WHERE c.id=outbound_message_requests.conversation_id AND s.channel='whatsapp'
           )`,
        [tenantId]
      );
      const selected = await claim.query<RecoveryRow>(
        `SELECT request.id,request.conversation_id,conversation.session_id,
                conversation.contact_phone,conversation.contact_jid,request.recovery_payload
         FROM outbound_message_requests request
         JOIN conversations conversation
           ON conversation.id=request.conversation_id AND conversation.tenant_id=request.tenant_id
         JOIN whatsapp_sessions connection
           ON connection.id=conversation.session_id AND connection.tenant_id=conversation.tenant_id
         WHERE request.tenant_id=$1 AND request.status='failed'
           AND request.recovery_payload IS NOT NULL
           AND connection.channel='whatsapp'
           AND connection.archived_at IS NULL AND connection.status='connected'
         ORDER BY request.created_at,request.id
         FOR UPDATE OF request SKIP LOCKED
         LIMIT $2`,
        [tenantId, Math.max(1, Math.min(limit, 50))]
      );
      rows = selected.rows;
      if (rows.length > 0) {
        await claim.query(
          `UPDATE outbound_message_requests
           SET status='pending',recovery_attempts=recovery_attempts+1,
               processing_started_at=now(),completed_at=NULL
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='failed'`,
          [tenantId, rows.map((row) => row.id)]
        );
      }
      await claim.query("COMMIT");
    } catch (error) {
      await claim.query("ROLLBACK");
      throw error;
    } finally {
      claim.release();
    }

    let sentCount = 0;
    let failedCount = 0;
    let ambiguousCount = 0;
    for (const row of rows) {
      const payload = row.recovery_payload as Record<string, unknown> | null;
      const sendText = typeof payload?.sendText === "string" ? payload.sendText : "";
      const displayText = typeof payload?.displayText === "string" ? payload.displayText : "";
      const sentByUserId = typeof payload?.sentByUserId === "string" ? payload.sentByUserId : "";
      if (!sendText || !displayText || !sentByUserId) {
        await this.db.query(
          `UPDATE outbound_message_requests
           SET status='failed',recovery_payload=NULL,error_message='Payload de recuperação inválido',completed_at=now()
           WHERE id=$1 AND tenant_id=$2 AND status='pending'`,
          [row.id, tenantId]
        );
        failedCount += 1;
        continue;
      }

      let providerResult: { externalId: string };
      try {
        providerResult = await send({
          sessionId: row.session_id,
          destination: row.contact_jid ?? row.contact_phone,
          text: sendText
        });
      } catch (error) {
        await this.db.query(
          `UPDATE outbound_message_requests
           SET status=$3,error_message=$4,completed_at=now()
           WHERE id=$1 AND tenant_id=$2 AND status='pending'`,
          [row.id, tenantId, isWhatsAppSendRejectedError(error) ? "failed" : "ambiguous", error instanceof Error ? error.message : String(error)]
        );
        if (isWhatsAppSendRejectedError(error)) failedCount += 1;
        else ambiguousCount += 1;
        continue;
      }

      const record = await this.db.connect();
      try {
        await record.query("BEGIN");
        const providerMessageKey = this.messageKey({
          tenantId,
          sessionId: row.session_id,
          externalId: providerResult.externalId
        });
        const inserted = await record.query(
          `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key,sent_by_user_id)
           SELECT conversation.id,'human',$4,$5,$6,$7
           FROM conversations conversation
           WHERE conversation.id=$1 AND conversation.tenant_id=$2 AND conversation.session_id=$3
           ON CONFLICT(provider_message_key) DO NOTHING`,
          [row.conversation_id, tenantId, row.session_id, displayText, providerResult.externalId, providerMessageKey, sentByUserId]
        );
        if ((inserted.rowCount ?? 0) === 0) {
          const existing = await record.query("SELECT 1 FROM messages WHERE provider_message_key=$1", [providerMessageKey]);
          if (!existing.rows[0]) throw new Error("A conversa desapareceu antes de registrar a mensagem recuperada");
        }
        await record.query(
          `UPDATE conversations SET contact_jid=COALESCE($4,contact_jid),last_message_at=now()
           WHERE id=$1 AND tenant_id=$2 AND session_id=$3`,
          [row.conversation_id, tenantId, row.session_id, row.contact_jid]
        );
        await record.query(
          `UPDATE outbound_message_requests
           SET status='sent',external_message_id=$3,error_message=NULL,recovery_payload=NULL,
               recovered_at=now(),completed_at=now()
           WHERE id=$1 AND tenant_id=$2 AND status='pending'`,
          [row.id, tenantId, providerResult.externalId]
        );
        await record.query("COMMIT");
        sentCount += 1;
      } catch (error) {
        await record.query("ROLLBACK");
        await this.db.query(
          `UPDATE outbound_message_requests
           SET status='ambiguous',external_message_id=COALESCE(external_message_id,$3),
               error_message=$4,completed_at=now()
           WHERE id=$1 AND tenant_id=$2 AND status='pending'`,
          [row.id, tenantId, providerResult.externalId, error instanceof Error ? error.message : String(error)]
        );
        ambiguousCount += 1;
      } finally {
        record.release();
      }
    }

    const remaining = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbound_message_requests request
       WHERE request.tenant_id=$1 AND request.status='failed' AND request.recovery_payload IS NOT NULL
         AND EXISTS (SELECT 1 FROM conversations c JOIN whatsapp_sessions s ON s.id=c.session_id AND s.tenant_id=c.tenant_id WHERE c.id=request.conversation_id AND s.channel='whatsapp')`,
      [tenantId]
    );
    return {
      sent: sentCount,
      failed: failedCount,
      ambiguous: ambiguousCount,
      remaining: Number(remaining.rows[0]?.count ?? 0)
    };
  }

  async executeToolCallOnceDetailed(
    input: ToolCallJournalInput,
    execute: () => Promise<string>
  ): Promise<ToolCallJournalResult> {
    const argumentsHash = payloadFingerprint({ tool: input.toolName, arguments: (() => {
      try { return JSON.parse(input.argumentsJson || "{}"); } catch { return {}; }
    })() });
    const claimed = await this.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO ai_tool_call_journal
         (tenant_id,conversation_id,inbound_external_id,ai_turn_id,call_ordinal,provider_call_id,tool_name,arguments_hash)
       SELECT $1,c.id,$3,$4,$5,$6,$7,$8 FROM conversations c
       WHERE c.id=$2 AND c.tenant_id=$1
       ON CONFLICT(tenant_id,inbound_external_id,ai_turn_id,call_ordinal) DO NOTHING
       RETURNING id,created_at`,
      [input.tenantId, input.conversationId, input.inboundExternalId, input.aiTurnId, input.callOrdinal,
        input.providerCallId ?? null, input.toolName, argumentsHash]
    );

    if (!claimed.rows[0]) {
      for (let attempt = 0; attempt < IDEMPOTENCY_WAIT_ATTEMPTS; attempt += 1) {
        const previous = await this.db.query<{
          id: string;
          tool_name: string;
          arguments_hash: string;
          status: "pending" | "completed" | "failed";
          result_text: string | null;
          error_message: string | null;
          occurred_at: Date;
          stale: boolean;
        }>(
          `SELECT id,tool_name,arguments_hash,status,result_text,error_message,
                  COALESCE(completed_at,created_at) occurred_at,
                  processing_started_at < now() - interval '5 minutes' AS stale
           FROM ai_tool_call_journal
           WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4`,
          [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal]
        );
        const row = previous.rows[0];
        if (!row) throw new Error("Conversation does not belong to tenant");
        if (row.tool_name !== input.toolName || row.arguments_hash.trim() !== argumentsHash) {
          throw conflict("Tool call ordinal foi reutilizado com outra operação");
        }
        if (row.status === "completed" && row.result_text !== null) {
          const envelopeError = errorEnvelopeMessage(row.result_text);
          if (envelopeError) {
            await this.db.query(
              `UPDATE ai_tool_call_journal
               SET status='failed',error_message=$5,completed_at=COALESCE(completed_at,now())
               WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4 AND status='completed'`,
              [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal, envelopeError]
            );
            return {
              journalId: row.id,
              status: "failed",
              resultText: row.result_text,
              errorMessage: envelopeError,
              occurredAt: row.occurred_at.toISOString()
            };
          }
          return {
            journalId: row.id,
            status: "succeeded",
            resultText: row.result_text,
            occurredAt: row.occurred_at.toISOString()
          };
        }
        if (row.status === "failed") {
          return {
            journalId: row.id,
            status: "failed",
            ...(row.result_text ? { resultText: row.result_text } : {}),
            errorMessage: sanitizeOperationalError(row.error_message ?? "Tool call anterior falhou"),
            occurredAt: row.occurred_at.toISOString()
          };
        }
        if (row.stale) break;
        await wait(IDEMPOTENCY_WAIT_MS);
      }
      const expired = await this.db.query<{ id: string; occurred_at: Date }>(
        `UPDATE ai_tool_call_journal
         SET status='failed',error_message='Reserva expirada; efeito requer reconciliação',completed_at=now()
         WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4 AND status='pending'
           AND processing_started_at < now() - interval '5 minutes'
         RETURNING id,completed_at occurred_at`,
        [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal]
      );
      if (expired.rows[0]) {
        return {
          journalId: expired.rows[0].id,
          status: "failed",
          errorMessage: "Reserva expirada; efeito requer reconciliação",
          occurredAt: expired.rows[0].occurred_at.toISOString()
        };
      }
      const pending = await this.db.query<{ id: string; created_at: Date }>(
        `SELECT id,created_at FROM ai_tool_call_journal
         WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4`,
        [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal]
      );
      if (!pending.rows[0]) throw new Error("Conversation does not belong to tenant");
      return {
        journalId: pending.rows[0].id,
        status: "pending",
        errorMessage: "Tool call com esta chave ainda está em andamento",
        occurredAt: pending.rows[0].created_at.toISOString()
      };
    }

    try {
      const result = await this.waitForMeetingProvisioning(input, await execute());
      const envelopeError = errorEnvelopeMessage(result);
      if (envelopeError) {
        const failed = await this.db.query<{ completed_at: Date }>(
          `UPDATE ai_tool_call_journal
               SET status='failed',result_text=$5,error_message=$6,completed_at=now()
               WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4 AND status='pending'
               RETURNING completed_at`,
          [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal, result, envelopeError]
        );
        return {
          journalId: claimed.rows[0].id,
          status: "failed",
          resultText: result,
          errorMessage: envelopeError,
          occurredAt: (failed.rows[0]?.completed_at ?? claimed.rows[0].created_at).toISOString()
        };
      }
      const completed = await this.db.query<{ completed_at: Date }>(
        `UPDATE ai_tool_call_journal SET status='completed',result_text=$5,completed_at=now()
         WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4 AND status='pending'
         RETURNING completed_at`,
        [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal, result]
      );
      return {
        journalId: claimed.rows[0].id,
        status: "succeeded",
        resultText: result,
        occurredAt: (completed.rows[0]?.completed_at ?? claimed.rows[0].created_at).toISOString()
      };
    } catch (error) {
      const message = sanitizeOperationalError(error);
      const failed = await this.db.query<{ completed_at: Date }>(
        `UPDATE ai_tool_call_journal SET status='failed',error_message=$5,completed_at=now()
         WHERE tenant_id=$1 AND inbound_external_id=$2 AND ai_turn_id=$3 AND call_ordinal=$4 AND status='pending'
         RETURNING completed_at`,
        [input.tenantId, input.inboundExternalId, input.aiTurnId, input.callOrdinal, message]
      );
      return {
        journalId: claimed.rows[0].id,
        status: "failed",
        errorMessage: message,
        occurredAt: (failed.rows[0]?.completed_at ?? claimed.rows[0].created_at).toISOString()
      };
    }
  }

  async executeToolCallOnce(input: ToolCallJournalInput, execute: () => Promise<string>): Promise<string> {
    const result = await this.executeToolCallOnceDetailed(input, execute);
    if (result.status === "succeeded") return result.resultText;
    throw result.status === "pending"
      ? conflict(result.errorMessage)
      : new Error(result.errorMessage);
  }

  private async recordInstagramHuman(
    message: HumanMessage & { channel: "instagram"; instagramContactId: string }
  ): Promise<"recorded" | "duplicate"> {
    return withTenantTransaction(this.db, message.tenantId, async (client) => {
      // Eco humano (o dono da conta respondeu pelo app nativo do Instagram)
      // pode ser o PRIMEIRO evento de um contato que nunca mandou DM pelo
      // AtendON — não existe conversa ainda. Antes, isto fazia só UPDATE e,
      // sem linha para casar, afetava 0 linhas e lançava
      // "Instagram conversation does not belong to tenant and connection"
      // em retry infinito (>10000 tentativas observadas em produção).
      // Agora faz INSERT..ON CONFLICT como o equivalente de WhatsApp em
      // recordHuman(), criando a conversa quando ainda não existe.
      // lead_id é NOT NULL em conversations; para Instagram (diferente do
      // fluxo por telefone) não existe trigger que crie o lead sozinho, por
      // isso criamos/casamos o scheduling_lead aqui, mesmo padrão usado em
      // instagram/repository.ts::persistEvent.
      const lead = await client.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,source,instagram_contact_id,instagram_session_id)
         VALUES($1,NULL,NULL,'instagram',$2,$3)
         ON CONFLICT(tenant_id,instagram_session_id,instagram_contact_id) WHERE instagram_contact_id IS NOT NULL
         DO UPDATE SET updated_at=now()
         RETURNING id`,
        [message.tenantId, message.instagramContactId, message.sessionId]
      );
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO conversations(
           tenant_id,session_id,contact_phone,instagram_contact_id,instagram_username,lead_id,
           ai_active,handoff_reason,status,last_message_at,queue_id
         ) VALUES(
           $1,$2,NULL,$3,$4,$5,false,'manually_paused','open',now(),
           (SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial AND archived_at IS NULL LIMIT 1)
         )
         ON CONFLICT(tenant_id,session_id,instagram_contact_id) WHERE instagram_contact_id IS NOT NULL
         DO UPDATE SET
           ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL,
           instagram_username=COALESCE(EXCLUDED.instagram_username,conversations.instagram_username),
           last_message_at=now(),status='open',resolved_at=NULL,
           queue_id=COALESCE(conversations.queue_id,EXCLUDED.queue_id)
         RETURNING id`,
        [message.tenantId, message.sessionId, message.instagramContactId, message.instagramUsername ?? null, lead.rows[0].id]
      );
      const row = conversation.rows[0];
      if (!row) throw new Error("Instagram conversation does not belong to tenant and connection");
      await ensureCaseAssignment(client, {
        tenantId: message.tenantId,
        selector: { conversationId: row.id },
        reason: "novo_contato"
      });
      await client.query(
        `UPDATE ai_follow_up_schedules SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
           cancellation_reason='human_intervened',updated_at=now()
         WHERE conversation_id=$1 AND status IN ('scheduled','processing')`,
        [row.id]
      );
      const inserted = await client.query(
        `INSERT INTO messages(
           conversation_id,sender,content,media_type,external_message_id,provider_message_key,
           media_mime_type,media_file_name,media_size_bytes,media_is_sticker
         ) VALUES($1,'human',$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(provider_message_key) DO NOTHING`,
        [row.id, message.text, message.mediaType ?? null, message.externalId, this.messageKey(message),
          message.mediaMimeType ?? null, message.mediaFileName ?? null,
          message.mediaSizeBytes ?? null, message.mediaIsSticker ?? false]
      );
      return inserted.rowCount === 0 ? "duplicate" : "recorded";
    });
  }

  async recordHuman(message: HumanMessage): Promise<"recorded" | "duplicate"> {
    message = canonicalMessageAddress(message);
    if (message.channel === "instagram") {
      return this.recordInstagramHuman(
        message as HumanMessage & { channel: "instagram"; instagramContactId: string }
      );
    }
    const conversation = await withTenantTransaction(this.db, message.tenantId, async (client) => {
      const recorded = await client.query<{ id: string }>(
        `WITH conv AS (
         INSERT INTO conversations (tenant_id, session_id, contact_phone, contact_jid, queue_id)
         SELECT $1, s.id, $3, $4,
                (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)
         FROM whatsapp_sessions s WHERE s.id = $2 AND s.tenant_id = $1
         ON CONFLICT (tenant_id, session_id, contact_phone) DO UPDATE
         SET contact_jid = COALESCE(EXCLUDED.contact_jid, conversations.contact_jid),
             ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL,last_message_at = now(),
             status='open',resolved_at=NULL,
             queue_id=CASE WHEN conversations.status='closed' THEN
               (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)
               ELSE COALESCE(conversations.queue_id,
                 (SELECT q.id FROM conversation_queues q WHERE q.tenant_id=$1 AND q.is_initial AND q.archived_at IS NULL LIMIT 1)) END
         RETURNING id
       ),
       automatic_lead AS (
         INSERT INTO scheduling_leads(tenant_id,phone,source)
         SELECT $1,$3,'whatsapp' FROM conv
         WHERE NOT EXISTS (
           SELECT 1 FROM scheduling_leads existing
           WHERE existing.tenant_id=$1
             AND regexp_replace(existing.phone,'\\D','','g')=regexp_replace($3,'\\D','','g')
         )
         ON CONFLICT (tenant_id,phone) DO NOTHING
         RETURNING id,status
       ),
       automatic_lead_event AS (
         INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,new_status,details)
         SELECT id,$1,'lead_criado',status,jsonb_build_object('origem_automatica','conversa')
         FROM automatic_lead
         RETURNING id
       )
         SELECT id FROM conv`,
        [message.tenantId, message.sessionId, message.contactPhone, message.contactJid ?? null]
      );
      if (recorded.rows[0]) {
        await ensureCaseAssignment(client, {
          tenantId: message.tenantId,
          selector: { conversationId: recorded.rows[0].id },
          reason: "novo_contato"
        });
      }
      return recorded;
    });
    if (!conversation.rows[0]) throw new Error("Session does not belong to tenant");
    await this.db.query(
      `UPDATE ai_follow_up_schedules SET
         status='cancelled',next_run_at=NULL,processing_started_at=NULL,
         cancellation_reason='human_intervened',updated_at=now()
       WHERE conversation_id=$1 AND status IN ('scheduled','processing')`,
      [conversation.rows[0].id]
    );
    const result = await this.db.query(
      `INSERT INTO messages
         (conversation_id, sender, content, media_type, external_message_id, provider_message_key,
          media_mime_type, media_file_name, media_size_bytes, media_is_sticker)
       VALUES ($1, 'human', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider_message_key) DO NOTHING`,
      [conversation.rows[0].id, message.text, message.mediaType ?? null, message.externalId, this.messageKey(message),
        message.mediaMimeType ?? null, message.mediaFileName ?? null, message.mediaSizeBytes ?? null,
        message.mediaIsSticker ?? false]
    );
    return result.rowCount === 0 ? "duplicate" : "recorded";
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { AiRouter, FinalTextCorrection } from "../ai-router/openrouter.js";
import { isNonRetryableAiError, NonRetryableAiError } from "../ai-router/openrouter.js";
import { createSchedulingToolExecutor, normalizeModelSearchResult } from "../ai-router/tool-executor.js";
import { DEFAULT_ENABLED_TOOL_NAMES } from "../ai-router/tools.js";
import { mediaFallback } from "./media-fallback.js";
import {
  contactAcceptsOfferedHandoff,
  contactRequestsHandoff,
  parseAgentHandoff,
  unauthorizedAgentHandoffCorrection
} from "./handoff.js";
import { isPromptInjection, PROMPT_INJECTION_REPLY } from "../ai-router/prompt-guard.js";
import { logger } from "../../logger.js";
import type { ConversationContext, HandoffNotification, MessageRepository } from "./repository.js";
import type { MessageGateway, SessionMessage } from "./types.js";
import { acquireConversationLock, composingDuration, consumeRateLimitRedis, debounceInbound, extendConversationLock, humanizedDelay, isConversationLocked, randomBetween, releaseConversationLock, sanitizeOutbound, selectContextualReaction, sleep, splitResponse, withComposingRefresh } from "./humanizer.js";
import {
  canonicalizeMeetingDurationPrompt,
  initialPrefilledGreetingCorrection,
  meetingDurationDisclosureCorrection,
  meetingDurationContextNote,
  meetingInvitationContextCorrection,
  prefilledLeadContextNote,
  prefilledQualificationCompletionCorrection,
  schedulingPeriodQuestionCorrection,
  schedulingAvailabilityPolicyCorrection
} from "./prefilled-context.js";
import type { AiStickerCatalogItem } from "../stickers/repository.js";
import { needsObjectionRecovery, OBJECTION_RECOVERY_BLOCKED_TOOLS, objectionRecoveryCorrection, objectionRecoveryPromptNote } from "./objection-recovery.js";
import {
  claimsUnprovenTransactionalSuccess,
  composeActiveAppointmentConfirmation,
  composeTransactionalReply,
  customerTransactionalOutcomeExists,
  successfulCustomerTransactionalOutcomeExists,
  type TransactionalClaim,
  type TransactionalOutcome
} from "./transactional-outcome.js";
import {
  canonicalStatePromptNote,
  deriveCanonicalConversationState,
  gateToolsForCanonicalState,
  hasPersistedSlotOffer
} from "./state-tool-gating.js";
import { runAgentTurn } from "./agent-turn-runner.js";
import {
  appendTripzOffersInvitation,
  isTripzZuluAgent,
  tripzZuluDetectsOwnerNameReferral,
  tripzZuluRequestsOwnerHandoff,
  tripzZuluTurnInstruction,
  tripzZuluTurnSignals,
  TRIPZ_ZULU_OWNER_NAME,
  TRIPZ_ZULU_OWNER_REFERRAL_REPLY
} from "../tripz-ai/zulu.js";
import { extractSchedulingTimes, hasSchedulingTime } from "./scheduling-time.js";
import { workspaceClockNote } from "./turn-clock.js";
import { buscarDisponibilidade, markLeadDisqualified, verificarHorarios } from "../scheduling/service.js";
import {
  buildAiTurnPreview,
  safeAiToolLabel
} from "../realtime/ai-turn-contract.js";
import { capabilityForAiTool, filterAiToolsByCapabilities } from "../../capabilities/ai-tools.js";
import { consumeAiInteraction, reconcileAiTurnFromUsageLogs } from "../../billing/ai-consumption.js";
import type { CapabilityKey } from "../operations/feature-flags.js";
import type {
  AiTurnProgressPublisher,
  AiTurnProgressSession
} from "../realtime/ai-turn-progress.js";
export { workspaceClockNote } from "./turn-clock.js";

const RECENT_USER_ECHO_WINDOW = 6;
const SHORT_PLEASANTRY = /\b(?:tudo\s+(?:bem|certo)|como\s+(?:vai|voce|você)|boa\s+(?:tarde|noite)|bom\s+dia|oi|ola|olá|opa)\b/i;
const MODEL_SEARCH_TOOL_CHOICE = { type: "function" as const, function: { name: "pesquisar_modelo" } };
const CONTEXT_SEARCH_TOOL_CHOICE = { type: "function" as const, function: { name: "pesquisar_contexto" } };
const REGISTER_LEAD_TOOL_CHOICE = { type: "function" as const, function: { name: "registrar_lead" } };
const PROACTIVE_SCHEDULING_TOOL_NAMES = new Set([
  "consultar_agendas", "consultar_unidades", "verificar_horarios", "verificar_horarios_reuniao",
  "agendar_visita", "agendar_reuniao"
]);
const AVAILABILITY_TOOL_NAMES = new Set([
  "consultar_agendas", "consultar_unidades", "verificar_horarios", "verificar_horarios_reuniao"
]);
const SPECIFIC_PRODUCT_MODEL_PATTERNS = [
  /\b(?:iphone|galaxy|samsung|motorola|moto|xiaomi|redmi|poco|realme|ipad|apple\s*watch|watch|smart\s*tv|tv|lg|tcl|aoc|philips|hisense)\s+[a-z0-9][a-z0-9\s-]{0,30}\d{1,3}[a-z0-9]*(?:\s+(?:pro\s*max|pro|max|plus|ultra|mini|fe|edge|note|lite))*\b/iu,
  /\b\d{1,3}\s*(?:pro\s*max|pro|max|plus|ultra|mini)\b/iu,
  /\b(?:s|a|m|g|z)\d{2,3}(?:\s*(?:pro\s*max|pro|max|plus|ultra|fe|edge|note|lite))?\b/iu
];

const STICKER_DIRECTIVE = /\[\[FIGURINHA:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\]/giu;

export function stickerCatalogPrompt(catalog: AiStickerCatalogItem[]): string {
  if (!catalog.length) return "";
  const entries = catalog.map((sticker) => {
    const tags = sticker.tags.length ? `; tags: ${sticker.tags.join(", ")}` : "";
    const recency = sticker.lastSentAt ? `; já usada nesta conversa em ${sticker.lastSentAt}` : "";
    return `- ${sticker.id} | ${sticker.name}: ${sticker.description}${tags}${recency}`;
  }).join("\n");
  return `\n\nBIBLIOTECA DE FIGURINHAS DO WORKSPACE:
${entries}

Você pode acrescentar no máximo uma figurinha à resposta quando ela combinar claramente com o momento e tornar o atendimento mais natural. Não use em assuntos sensíveis, reclamações, recusas, valores, dados pessoais ou confirmações formais. Evite repetir uma já usada recentemente. Para enviar, mantenha sua mensagem normal e acrescente ao final exatamente [[FIGURINHA:id]], usando um id da lista. O marcador é interno e nunca será exibido ao contato. Nunca escreva um marcador sem também escrever uma mensagem de texto útil.`;
}

export function extractStickerDirective(text: string, allowedIds: ReadonlySet<string>): { text: string; stickerId?: string } {
  let selected: string | undefined;
  const cleanText = text.replace(STICKER_DIRECTIVE, (_marker, rawId: string) => {
    const id = rawId.toLocaleLowerCase("en-US");
    if (!selected && allowedIds.has(id)) selected = id;
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleanText, ...(selected ? { stickerId: selected } : {}) };
}

const SHORT_AFFIRMATIVE = /^(?:s+|sim+|pode\s+ser|isso(?:\s+mesmo)?|confirmo|combinado|fechado)$/iu;
// Aceita a combinação natural de dois agradecimentos ("ok vlw", "beleza obrigado"):
// ancorado em um único token, um "Ok vlw" abria um turno completo da IA depois da
// reunião já confirmada e ela reabria a oferta de horários.
const TERMINAL_ACKNOWLEDGEMENT_TOKEN = "(?:ok(?:ay)?|certo|beleza|blz|show|combinado|fechado|t[aá]\\s+bom|tranquilo|tranquilao|valeu|vlw+|vlws|obrigad[oa]|obg|obgd|agradecid[oa]|perfeito|otimo|isso)";
const TERMINAL_ACKNOWLEDGEMENT = new RegExp(
  `^${TERMINAL_ACKNOWLEDGEMENT_TOKEN}(?:\\s+(?:entao|mesmo|demais))?(?:\\s+${TERMINAL_ACKNOWLEDGEMENT_TOKEN})?$`,
  "iu"
);
const CONFIRMATION_QUESTION = /\b(?:confirm(?:a|o|amos|ar)|posso\s+(?:marcar|agendar|reservar)|podemos\s+(?:marcar|agendar|reservar)|quer\s+que\s+eu\s+(?:deixe|marque|agende|reserve|confirme))\b/iu;
const CONFIRMED_APPOINTMENT = /\b(?:confirmad[oa]|agendad[oa]|marcad[oa]|reservad[oa])\b/iu;
const APPOINTMENT_CHANGE_REQUEST = /\b(?:reagend\w*|remarc\w*|desmarc\w*|cancel\w*|adiar|antecipar|mudar|trocar|alterar|outro\s+(?:hor[aá]rio|dia)|mais\s+(?:tarde|cedo))\b/iu;
const SLOT_REJECTION = /\b(?:indispon[ií]vel|n[aã]o\s+(?:est[aá]\s+)?(?:mais\s+)?(?:livre|dispon[ií]vel)|sem\s+(?:vaga|encaixe)|n[aã]o\s+consigo\s+(?:marcar|agendar|encaixar))\b/iu;
const AUDIO_FORMAT_BY_MIME: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm"
};

export function refreshContextWithinTurn(
  frozen: ConversationContext,
  refreshed: ConversationContext
): ConversationContext {
  return {
    ...refreshed,
    messageId: frozen.messageId,
    agentConfigVersionId: frozen.agentConfigVersionId,
    model: frozen.model,
    provider: frozen.provider,
    systemPrompt: frozen.systemPrompt,
    offersGroupLink: frozen.offersGroupLink,
    tripzZuluEnabled: frozen.tripzZuluEnabled,
    temperature: frozen.temperature,
    maxTokens: frozen.maxTokens,
    reasoningEffort: frozen.reasoningEffort,
    openRouterApiKey: frozen.openRouterApiKey,
    mediaFallback: frozen.mediaFallback,
    humanizer: frozen.humanizer,
    enabledToolNames: frozen.enabledToolNames,
    stateToolGatingEnabled: frozen.stateToolGatingEnabled,
    meetingAgendas: frozen.meetingAgendas
  };
}

export function canonicalMeetingSlotDuration(context: Pick<
  ConversationContext,
  "meetingAgendas" | "registeredLead" | "activeAppointment"
>): number | undefined {
  const agendas = (context.meetingAgendas ?? []).filter((agenda) =>
    Number.isInteger(agenda.slotDurationMinutes) && agenda.slotDurationMinutes > 0
  );
  const selectedAgendaId = context.activeAppointment?.unitId ?? context.registeredLead?.unitId;
  const selected = selectedAgendaId
    ? agendas.find((agenda) => agenda.id === selectedAgendaId)
    : undefined;
  if (selected) return selected.slotDurationMinutes;
  const durations = [...new Set(agendas.map((agenda) => agenda.slotDurationMinutes))];
  return durations.length === 1 ? durations[0] : undefined;
}

export function transcriptionAudioFormat(mimeType: string, fileName?: string): string {
  const normalizedMime = mimeType.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  const fromMime = AUDIO_FORMAT_BY_MIME[normalizedMime];
  if (fromMime) return fromMime;
  const extension = fileName?.split(".").at(-1)?.toLocaleLowerCase("en-US");
  if (extension && ["aac", "flac", "m4a", "mp3", "mp4", "ogg", "opus", "wav", "webm"].includes(extension)) {
    return extension === "opus" ? "ogg" : extension;
  }
  throw new Error(`Unsupported audio format: ${mimeType}`);
}

const TRANSCRIPTION_VOCABULARY = /<VOCABULARIO_TRANSCRICAO>([\s\S]*?)<\/VOCABULARIO_TRANSCRICAO>/iu;

export function audioTranscriptionPrompt(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): string {
  const configuredVocabulary = systemPrompt.match(TRANSCRIPTION_VOCABULARY)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const recentContext = history
    .slice(-6)
    .map((item) => item.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(-900);
  return [
    "Áudio de WhatsApp em português brasileiro. Transcreva literalmente, com pontuação clara. Preserve nomes próprios, marcas, siglas, valores e horários. Não traduza. Formas faladas como meio dia devem ser escritas como meio-dia.",
    configuredVocabulary ? `Vocabulário esperado: ${configuredVocabulary}` : "",
    recentContext ? `Contexto recente, apenas para desambiguar palavras: ${recentContext}` : ""
  ].filter(Boolean).join("\n");
}

export function mediaAnalysisContext(
  mediaType: "image" | "document",
  analysis: string,
  caption?: string,
  mediaIsSticker = false
): string {
  const label = mediaIsSticker ? "FIGURINHA" : mediaType === "image" ? "IMAGEM" : "DOCUMENTO";
  return [
    `[MÍDIA ANALISADA PELA IA: ${label}]`,
    analysis.trim(),
    caption?.trim() ? `Legenda/pergunta original do contato: ${caption.trim()}` : "",
    mediaIsSticker
      ? "INSTRUÇÃO INTERNA: responda de forma espontânea ao tom da figurinha e continue a conversa do ponto atual. Nunca descreva, explique ou mencione a figurinha nem diga o que ela faz/mostra."
      : ""
  ].filter(Boolean).join("\n");
}

function mediaFailureAlert(mediaType: "audio" | "image" | "document", error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (mediaType === "audio" && /(?:\b402\b|balance|saldo)/iu.test(detail)) {
    return "A transcrição de áudio está indisponível: a OpenRouter exige ao menos US$ 0,50 de saldo para processar áudio. Adicione créditos à conta vinculada à chave do agente.";
  }
  const label = mediaType === "audio" ? "transcrição de áudio" : mediaType === "image" ? "análise de imagem" : "leitura de documento";
  return `Falha na ${label} pela IA. Verifique a chave, o saldo e a compatibilidade do modelo configurado na OpenRouter.`;
}

function lastAssistantMessage(history: Array<{ role: "user" | "assistant"; content: string }>): string | undefined {
  return [...history].reverse().find((item) => item.role === "assistant")?.content;
}

export function extractUnknownCommercialTerm(text: string, knownContext: string): string | undefined {
  const candidates = [
    ...text.matchAll(/\b(?:produto|servi[cç]o|plano|pacote|solu[cç][aã]o|sistema|modalidade)[ \t]+(?:chamad[oa][ \t]+)?["“']?([\p{Letter}\p{Number}][\p{Letter}\p{Number} \t._+-]{1,60})/giu),
    ...text.matchAll(/\b(?:voc[eê]s?[ \t]+(?:trabalham?|oferecem?|vendem?|fazem)|tem|conhecem?)[ \t]+(?:(?:com|o|a)[ \t]+)?["“']?([\p{Letter}\p{Number}][\p{Letter}\p{Number} \t._+-]{1,60})/giu)
  ];
  const generic = /^(?:(?:do|da|de|dos|das|um|uma|o|a)[ ]+)?(?:isso|esse|essa|algum|alguma|produto|servico|plano|sistema|solucao|modalidade|financeira|credito|financiamento|empresa|loja|operacao|atendimento)$/u;
  const normalizedContext = normalizeForEchoCheck(knownContext);
  for (const match of candidates) {
    const term = match[1]?.replace(/\s+/g, " ").trim();
    if (!term) continue;
    const normalized = normalizeForEchoCheck(term)
      .replace(/\b(?:por favor|pra mim|para mim|ai|a[ií]|hoje|tambem)\b.*$/u, "")
      .trim();
    if (normalized.length < 3 || generic.test(normalized)) continue;
    if (!normalizedContext.includes(normalized)) return term.slice(0, normalized.length).trim();
  }
  return undefined;
}

export type SpecificSchedulingIntent =
  | { kind: "direct_schedule"; time: string }
  | { kind: "availability_check"; time: string };

export function classifySpecificSchedulingIntent(text: string): SpecificSchedulingIntent | undefined {
  const normalized = text.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
  const time = extractSchedulingTimes(normalized).at(-1);
  if (!time) return undefined;
  // O horário já foi extraído; estes padrões só distinguem "9 está livre?" de
  // "pode ser às 9", então a hora aqui pode vir sem o sufixo `h`/`:`.
  const hour = String.raw`(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d)?|meio[\s-]?dia`;
  const asksAvailability = new RegExp(
    String.raw`\b(?:tem|ha|existe)\b.{0,100}\b(?:[01]?\d|2[0-3])(?:h|:)`
    + String.raw`|\b(?:${hour})\b.{0,24}\b(?:esta|ta|fica)\s+(?:livre|disponivel)`
    + String.raw`|\b(?:livre|disponivel)\s+(?:as\s+)?\b(?:${hour})\b`,
    "u"
  ).test(normalized);
  if (asksAvailability) return { kind: "availability_check", time };
  const directlyAuthorizes = /\b(?:pode\s+ser|pode\s+(?:marcar|agendar|reservar)|marc[ae]|agend[ae]|reserv[ae]|quero|fechad[oa]|vamos\s+(?:de|nesse)|fica\s+(?:para|pra|bom|boa|melhor|otim[oa]))\b/u.test(normalized);
  return directlyAuthorizes ? { kind: "direct_schedule", time } : undefined;
}

function mentionedTimes(text: string): string[] {
  return [...extractSchedulingTimes(text)].sort();
}

function offeredSchedulingTimes(text: string): string[] {
  const normalized = normalizeForEchoCheck(text);
  const reportsCompletedOutcome = /\b(?:ficou|esta|foi)\s+(?:confirmad[oa]|marcad[oa]|agendad[oa]|reservad[oa]|reagendad[oa]|cancelad[oa])\b/u.test(normalized)
    || /\b(?:confirmei|marquei|agendei|reservei|reagendei|cancelei)\b/u.test(normalized);
  if (reportsCompletedOutcome) return [];
  const times = mentionedTimes(text);
  const describesOperatingWindow = /\b(?:atendimento|funcionamento|expediente|abert[oa]s?|abre|fecha|horario comercial)\b/u
    .test(normalized);
  // A faixa que o próprio contato informou para falar com alguém não é uma
  // oferta de slots da nossa agenda. O incidente de 17/08/2026 passou por aqui:
  // "entre 8h e meio-dia" tinha duas horas e, por isso, era tratado como duas
  // opções inventadas mesmo sem linguagem de disponibilidade ou escolha.
  const describesTimeWindow = times.length > 1
    && /\b(?:das|entre)\b.{0,48}\b(?:ate|ao|as|e)\b/u.test(normalized);
  const asksForSlotChoice = /\b(?:qual\b.{0,50})?(?:pode ser|funciona|fica melhor|prefere)\b/u.test(normalized)
    || /\b(?:marcar|agendar|reservar)\b/u.test(normalized);
  const assertsOwnSchedule = /\b(?:tenho|temos)\b.{0,32}\b(?:disponivel|disponibilidade|livre|horarios?|encaixes?)\b/u.test(normalized)
    || /\b(?:minha|nossa)\s+agenda\b|\bagenda\b.{0,24}\b(?:tem|disponivel|livre|horarios?|encaixes?)\b/u.test(normalized);
  const explicitlyOffersRange = asksForSlotChoice || assertsOwnSchedule
    || (times.length > 1 && /\bou\b/u.test(normalized));
  const explicitlyOffersSlots = /\b(?:disponivel|disponibilidade|livre|encaixes?)\b/u.test(normalized)
    || asksForSlotChoice
    || /\b(?:hoje|amanha|domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/u.test(normalized)
    || (times.length > 1 && /\bou\b/u.test(normalized));
  if ((describesOperatingWindow || describesTimeWindow) && !explicitlyOffersRange) return [];
  const looksLikeOffer = /\b(?:tenho|temos|disponivel|disponibilidade|livre|horarios?|encaixes?)\b/u.test(normalized)
    || explicitlyOffersSlots
    || times.length > 1;
  return looksLikeOffer ? times : [];
}

function slotLocalTime(start: string, timeZone: string): string | undefined {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour && minute ? `${hour}:${minute}` : undefined;
}

function activeAppointmentMatchesPendingConfirmation(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  appointmentStart: string,
  timeZone: string,
  now = new Date()
): boolean {
  if (!isConfirmedSchedulingTurn(text, history)) return false;
  const previousAssistant = lastAssistantMessage(history);
  if (!previousAssistant) return false;
  const pendingTime = mentionedTimes(previousAssistant)[0];
  if (!pendingTime || slotLocalTime(appointmentStart, timeZone) !== pendingTime) return false;
  const referencedDates = referencedOfferDates(previousAssistant, now, timeZone);
  return !referencedDates.length
    || referencedDates.includes(dateKeyInTimeZone(new Date(appointmentStart), timeZone));
}

/**
 * O journal de ferramentas é idempotente por (turno, ordinal). Uma regeneração
 * de resposta reinicia os ordinais do zero com um contexto diferente, então
 * reaproveitar o turno faz o ordinal da segunda passada colidir com o da
 * primeira: o journal recusa a chamada como "ordinal reutilizado" e a
 * ferramenta de agenda passa a devolver erro até a IA desistir e transferir.
 *
 * Derivar o turno em vez de sortear preserva a outra garantia do campo: o
 * retry do job repete as mesmas gerações e reencontra os mesmos turnos, então
 * uma ação transacional já efetivada continua não sendo executada de novo.
 */
export function generationTurnId(rootTurnId: string, generation: number): string {
  if (generation === 0) return rootTurnId;
  const bytes = createHash("sha256").update(`${rootTurnId}:${generation}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface MeetingAvailabilityEvidence {
  agendaId: string;
  date: string;
  timezone: string;
  slots: Array<{ start: string; end?: string }>;
  requestedTime?: string;
  requestedTimeAvailable?: boolean;
  /** false quando a agenda comprovou que o período pedido não tem vaga nos próximos dias. */
  periodSatisfied?: boolean;
}

function explicitlyRejectsRequestedTime(text: string, evidence: MeetingAvailabilityEvidence | undefined): boolean {
  const requestedTime = evidence?.requestedTime;
  if (!requestedTime || evidence.requestedTimeAvailable !== false) return false;
  return text.split(/[.!?;\n]+/u).some((segment) =>
    mentionedTimes(segment).includes(requestedTime) && SLOT_REJECTION.test(segment)
  );
}

function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addCalendarDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function referencedOfferDates(text: string, now: Date, timeZone: string): string[] {
  const normalized = normalizeForEchoCheck(text);
  const today = dateKeyInTimeZone(now, timeZone);
  const relative = [
    ...(/\bhoje\b/u.test(normalized) ? [today] : []),
    ...(/\bamanha\b/u.test(normalized) ? [addCalendarDays(today, 1)] : [])
  ];
  const explicit = [...normalized.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/gu)].map((match) => {
    const yearText = match[3];
    const year = yearText ? (yearText.length === 2 ? `20${yearText}` : yearText) : today.slice(0, 4);
    return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  });
  return [...new Set([...relative, ...explicit])];
}

export function schedulingOfferEvidenceCorrection(
  text: string,
  evidence: MeetingAvailabilityEvidence | undefined,
  options: { now: Date; minimumLeadTimeMinutes: number; fallbackTimeZone: string }
): string | undefined {
  const requestedTimeExplicitlyUnavailable = explicitlyRejectsRequestedTime(text, evidence);
  const offeredTimes = offeredSchedulingTimes(text).filter((time) =>
    !(requestedTimeExplicitlyUnavailable && time === evidence?.requestedTime)
  );
  if (!offeredTimes.length) return undefined;
  const earliestStart = options.now.getTime() + options.minimumLeadTimeMinutes * 60_000;
  const evidenceTimeZone = evidence?.timezone || options.fallbackTimeZone;
  const offeredDates = referencedOfferDates(text, options.now, evidenceTimeZone);
  const everyDateReferenceMatches = offeredDates.length === 0
    || offeredDates.every((date) => date === evidence?.date);
  const everyOfferedTimeIsVerifiedAndSafe = offeredTimes.every((time) => evidence?.slots.some((slot) =>
    slotLocalTime(slot.start, evidenceTimeZone) === time
    && new Date(slot.start).getTime() > earliestStart
  ));
  if (evidence && everyDateReferenceMatches && everyOfferedTimeIsVerifiedAndSafe) return undefined;
  return `Os horários da resposta não estão comprovados por uma consulta de agenda válida neste turno. Chame verificar_horarios_reuniao agora e ofereça somente dois ou três horários retornados que comecem com pelo menos ${options.minimumLeadTimeMinutes} minutos de antecedência. Não invente, reaproveite nem mencione horários anteriores.`;
}

function customerTime(time: string): string {
  return time.endsWith(":00") ? `${Number(time.slice(0, 2))}h` : time.replace(":", "h");
}

/** Customer-visible, evidence-only fallback used when model generation cannot finish. */
export function composeMeetingAvailabilityFallback(evidence: MeetingAvailabilityEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  if (!evidence.slots.length) {
    if (evidence.requestedTimeAvailable === false && evidence.requestedTime) {
      return `Às ${customerTime(evidence.requestedTime)} não está mais disponível e não encontrei outro horário livre nos próximos dias. Você prefere tentar outro período?`;
    }
    return "Não encontrei horários livres nos próximos dias. Você prefere tentar outro período?";
  }
  const times = [...new Set(evidence.slots.flatMap((slot) => {
    const time = slotLocalTime(slot.start, evidence.timezone);
    return time ? [time] : [];
  }))].slice(0, 3);
  if (!times.length) return undefined;
  const formattedTimes = new Intl.ListFormat("pt-BR", { style: "long", type: "disjunction" })
    .format(times.map(customerTime));
  const [, , month, day] = evidence.date.match(/^(\d{4})-(\d{2})-(\d{2})$/u) ?? [];
  const dateText = day && month ? `No dia ${day}/${month}` : "Na próxima data disponível";
  const unavailable = evidence.requestedTimeAvailable === false && evidence.requestedTime
    ? `Às ${customerTime(evidence.requestedTime)} não está mais disponível. `
    : "";
  return `${unavailable}${dateText}, tenho ${formattedTimes}. Qual fica melhor para você?`;
}

function schedulingDayReferences(text: string): string[] {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  const namedDays = normalized.match(/\b(?:hoje|amanha|domingo|segunda(?:[-\s]feira)?|terca(?:[-\s]feira)?|quarta(?:[-\s]feira)?|quinta(?:[-\s]feira)?|sexta(?:[-\s]feira)?|sabado)\b/gu) ?? [];
  const numericDates = normalized.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gu) ?? [];
  const writtenDates = normalized.match(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/gu) ?? [];
  return [...new Set([...namedDays, ...numericDates, ...writtenDates])].sort();
}

function refersToSameSchedulingMoment(first: string, second: string): boolean {
  const firstTimes = mentionedTimes(first);
  const secondTimes = mentionedTimes(second);
  if (
    !firstTimes.length
    || firstTimes.length !== secondTimes.length
    || !firstTimes.every((time, index) => time === secondTimes[index])
  ) {
    return false;
  }
  const firstDays = schedulingDayReferences(first);
  const secondDays = schedulingDayReferences(second);
  return !firstDays.length || !secondDays.length || firstDays.some((day) => secondDays.includes(day));
}

function isAppointmentConfirmation(text: string): boolean {
  if (!mentionedTimes(text).length) return false;
  const normalized = normalizeForEchoCheck(text);
  return /\b(?:agendad[oa]|marcad[oa]|confirmad[oa]|reservad[oa]|combinad[oa]|fechad[oa]|ficou|seguimos|mantemos)\b/u
    .test(normalized);
}

function callToActionKind(text: string): "schedule_choice" | "schedule_confirmation" | "reply_request" | undefined {
  const normalized = normalizeForEchoCheck(text);
  if (/\b(?:confirm|posso marcar|posso agendar|quer que eu (?:deixe|marque|agende|reserve|confirme)|fechamos)\b/u.test(normalized)) {
    return "schedule_confirmation";
  }
  if (/\b(?:qual|quais).{0,45}\b(?:melhor|prefere|funciona)|\b(?:qual deles|qual desses|pode ser)\b/u.test(normalized)) {
    return "schedule_choice";
  }
  if (/\b(?:me diz|me fala|responde|retorna|da um retorno)\b/u.test(normalized)) return "reply_request";
  return undefined;
}

const OFFER_STOP_WORDS = new Set([
  "agendar", "agenda", "confirmar", "confirma", "desses", "deles", "fica", "funciona", "horario",
  "horarios", "melhor", "pode", "prefere", "qual", "quais", "reuniao", "ser", "voce"
]);

function offerTopicWords(text: string): Set<string> {
  return new Set(contentWords(text).filter((word) => !OFFER_STOP_WORDS.has(word) && !/^\d+$/.test(word)));
}

function isSchedulingOffer(text: string): boolean {
  return Boolean(callToActionKind(text))
    || isAppointmentConfirmation(text)
    || (hasSchedulingTime(text) && (
      CONFIRMATION_QUESTION.test(text)
      || /\b(?:dispon[ií]vel|livre|funciona|pode\s+ser|serve|fica\s+bom|fechamos)\b/iu.test(text)
    ))
    || /\b(?:agenda|agendar|horario|reuniao|meet|encaixe)\b/iu.test(text);
}

/**
 * Bloqueia a mesma oferta ou cobrança ainda que o modelo troque a redação.
 * Horários diferentes sempre representam uma oferta nova; chamadas iguais só
 * são repetição quando o assunto significativo também permanece o mesmo.
 */
export function semanticOfferRepetitionCorrection(
  candidate: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): string | undefined {
  const candidateTimes = mentionedTimes(candidate);
  const candidateCta = callToActionKind(candidate);
  const candidateTopic = offerTopicWords(candidate);
  const recent = history.filter((message) => message.role === "assistant").slice(-8);
  const repeated = recent.some((message) => {
    const previousTimes = mentionedTimes(message.content);
    if (candidateTimes.length && previousTimes.length) {
      return refersToSameSchedulingMoment(candidate, message.content)
        && isSchedulingOffer(candidate)
        && isSchedulingOffer(message.content);
    }
    if (!candidateCta || candidateCta !== callToActionKind(message.content)) return false;
    const previousTopic = offerTopicWords(message.content);
    const overlap = [...candidateTopic].filter((word) => previousTopic.has(word)).length;
    return overlap >= 2 && overlap / Math.min(candidateTopic.size || 1, previousTopic.size || 1) >= 0.6;
  });
  if (!repeated) return undefined;
  return "A resposta proposta repete semanticamente uma oferta ou chamada para ação recente. Não reutilize o mesmo conjunto de horários nem faça a mesma cobrança com sinônimos. Avance o assunto, use horários realmente diferentes retornados pela agenda ou deixe de enviar a chamada repetida. Esta é uma correção interna e silenciosa: não diga ao contato que vai corrigir, ajustar, reescrever ou deixar de repetir; entregue somente a nova resposta final.";
}

export function internalCorrectionDisclosureCorrection(text: string): string | undefined {
  const normalized = normalizeForEchoCheck(text);
  // Instruções de reescrita voltam ao modelo como mensagem e podem ser ecoadas em primeira pessoa;
  // diferencie essa narração da ação concreta, como “vou falar com ela”.
  // Bloqueia anúncios em primeira pessoa de uma ação futura da própria IA, sem
  // enumerar verbos: pronomes e advérbios entre o auxiliar e o infinitivo são
  // deliberadamente aceitos. Não confundir com ações concretas em nome de
  // terceiros: "vou falar com ela" é a exceção comercial já permitida, mas
  // "vou falar sobre..." continua sendo uma narração da resposta.
  const announcesOwnFutureAction = /\b(?:eu\s+)?(?:vou|irei)\s+(?!(?:falar\s+com\s+ela)\b)(?:(?:te|lhe|me|nos|para\s+voce|pra\s+voce|so|apenas|agora|primeiro)\s+)*(?:[a-záàâãéêíóôõúç]+(?:ar|er|ir))\b/iu.test(normalized);
  const acknowledgesCorrection = announcesOwnFutureAction
    || /\b(?:passo\s+a|pretendo)\s+explicar\b/u.test(normalized)
    || /\b(?:resposta|mensagem)\s+anterior\b.{0,80}\b(?:corrig|ajust|reescrev|viola)\w*/u.test(normalized)
    || /\b(?:politica|instrucao|regra)\s+(?:interna|de\s+agenda)\b/u.test(normalized)
    || /\bvoce\s+tem\s+razao\b/u.test(normalized)
    || /\bdeixa\s+(?:eu|me)\s+(?:corrigir|ajustar|consertar)\b/u.test(normalized)
    || /\b(?:agora\s+)?(?:o\s+)?proximo\s+passo\b/u.test(normalized)
    || /\b(?:a\s+)?proxima\s+etapa(?:\s+(?:do|no)\s+(?:fluxo|processo))?\b/u.test(normalized);
  if (!acknowledgesCorrection) return undefined;
  const agendaDisclosure = /\bconsultar\s+a\s+agenda\b/u.test(normalized)
    ? "Não diga que vai consultar a agenda. "
    : "";
  return `${agendaDisclosure}Não exponha nem reconheça a correção interna ou o fluxo interno. Não narre o que vai dizer, explicar, mostrar ou perguntar: execute isso diretamente na resposta. Reescreva silenciosamente e entregue somente a mensagem final que o contato deveria receber, sem introduções como ‘vou deixar claro’, ‘vou explicar’, ‘vou mostrar’, ‘vou perguntar’ ou ‘irei detalhar’. Proponha a ação comercial de forma natural, sem anunciá-la como próximo passo ou próxima etapa e sem mencionar resposta anterior, erro, regra, política, fluxo, processo, ajuste, correção, repetição ou reescrita.`;
}

export function isConfirmedSchedulingTurn(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const normalized = normalizeForEchoCheck(text);
  const previousAssistant = lastAssistantMessage(history);
  const pendingTimes = previousAssistant ? mentionedTimes(previousAssistant) : [];
  return Boolean(
    SHORT_AFFIRMATIVE.test(normalized)
    && previousAssistant
    && pendingTimes.length === 1
    && hasSchedulingTime(previousAssistant)
    && isSchedulingOffer(previousAssistant)
  );
}

export function isAmbiguousSchedulingConfirmation(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const previousAssistant = lastAssistantMessage(history);
  return Boolean(
    SHORT_AFFIRMATIVE.test(normalizeForEchoCheck(text))
    && previousAssistant
    && mentionedTimes(previousAssistant).length > 1
    && isSchedulingOffer(previousAssistant)
  );
}

export function turnConcernsScheduling(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const normalized = normalizeForEchoCheck(text);
  const explicitScheduling = /\b(?:agenda|agendar|agendamento|horario|horarios|vaga|encaixe|reuniao|meet|marcar|remarcar|reagendar|reservar|cancelar)\b/u.test(normalized);
  const explicitMoment = hasSchedulingTime(text)
    || /\b(?:hoje|amanha|domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/u.test(normalized)
    || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u.test(normalized);
  if (explicitScheduling || explicitMoment) return true;

  const lastAssistant = lastAssistantMessage(history) ?? "";
  const assistantWasScheduling = /\b(?:agenda|agendar|agendamento|horario|reuniao|meet|marcar|reservar)\b/u
    .test(normalizeForEchoCheck(lastAssistant)) || hasSchedulingTime(lastAssistant);
  if (assistantWasScheduling && (SHORT_AFFIRMATIVE.test(normalized)
    || TERMINAL_ACKNOWLEDGEMENT.test(normalized)
    || /^(?:quero|vamos|pode|prefiro|esse|essa|o primeiro|o segundo)$/u.test(normalized))) return true;

  if (isCommercialInformationTurn(text)) return false;
  return !isPureSocialTurn(text);
}

function isPureSocialTurn(text: string): boolean {
  const normalized = normalizeForEchoCheck(text);
  return /^(?:fala(?:\s+[\p{Letter}\p{Number}_-]+){0,2}|como vai(?: voce)?|(?:tudo|td) (?:bem|bom|certo)|(?:oi+|ola+|oie|opa) (?:tudo|td) (?:bem|bom|certo)|e ai)$/u.test(normalized);
}

function isCommercialInformationTurn(text: string): boolean {
  const normalized = normalizeForEchoCheck(text);
  const asksForInformation = /\?/u.test(text)
    || /\b(?:como funciona|gostaria de saber|queria saber|quanto custa|qual (?:e|o|a)|quais (?:sao|os|as)|voces (?:cobram|atendem|oferecem|trabalham)|tem (?:custo|taxa)|ha (?:custo|taxa))\b/u.test(normalized);
  const commercialSubject = /\b(?:cobr|custo|custos|preco|precos|valor|valores|taxa|taxas|servico|servicos|financeira|financiamento|credito|crediario|boleto|boletos|credenciamento|produto|produtos|plano|planos|atendem|atendimento|adquirir)\w*\b/u.test(normalized);
  return asksForInformation && commercialSubject;
}

export function classifySchedulingPeriodPreference(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): "morning" | "afternoon" | undefined {
  const normalized = normalizeForEchoCheck(text);
  const period = /\b(?:de\s+)?manha\b/u.test(normalized)
    ? "morning"
    : /\b(?:a\s+)?tarde\b/u.test(normalized)
      ? "afternoon"
      : undefined;
  if (!period) return undefined;

  const recentAssistantContext = history
    .filter((message) => message.role === "assistant")
    .slice(-3)
    .map((message) => normalizeForEchoCheck(message.content))
    .join(" ");
  const asksForPeriod = /\b(?:periodo|manha|tarde)\b/u.test(recentAssistantContext);
  const identifiesScheduling = /\b(?:agenda|agendar|horario|reuniao|meet|marcar|reservar)\b/u.test(recentAssistantContext);
  return asksForPeriod && identifiesScheduling ? period : undefined;
}

export function pendingSchedulingPeriodPreference(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): "morning" | "afternoon" | undefined {
  const requestsSlots = /\b(?:me\s+(?:passa|manda|envia)|vai\s+passar|manda\s+(?:os\s+)?horarios|quais\s+(?:sao\s+)?(?:os\s+)?horarios)\b/u.test(normalizeForEchoCheck(text));
  if (!requestsSlots) return undefined;

  const latestAvailabilityReply = [...history].reverse().find((message) =>
    message.role === "assistant"
    && /\b(?:agenda|horarios?|opcoes?|disponibilidade|confirmad[oa]s?)\b/u.test(normalizeForEchoCheck(message.content))
    && /\b(?:manha|tarde)\b/u.test(normalizeForEchoCheck(message.content))
  )?.content;
  if (!latestAvailabilityReply) return undefined;

  const normalized = normalizeForEchoCheck(latestAvailabilityReply);
  return /\bmanha\b/u.test(normalized) ? "morning" : "afternoon";
}

export function schedulingPeriodOfferCorrection(
  text: string,
  preference: "morning" | "afternoon"
): string | undefined {
  const offeredTimes = offeredSchedulingTimes(text);
  if (!offeredTimes.length) return undefined;

  const matchesPreference = (time: string) => {
    const hour = Number(time.slice(0, 2));
    return preference === "morning" ? hour < 12 : hour >= 12 && hour < 18;
  };
  if (offeredTimes.every(matchesPreference)) return undefined;
  return `O contato escolheu ${preference === "morning" ? "a manhã" : "a tarde"}. Ofereça somente horários desse período que tenham sido retornados pela agenda, sem mencionar horários de outro período.`;
}

/**
 * A consulta de agenda é síncrona dentro do turno: prometer enviar horários
 * "assim que houver" ou alegar não ter opções confirmadas é sempre falso
 * quando a ferramenta já devolveu horários reais neste turno. Sem esta
 * verificação a resposta vaga passa por todos os demais validadores, porque
 * ela não cita nenhum horário.
 */
export function deferredAvailabilityPromiseCorrection(
  text: string,
  evidence: MeetingAvailabilityEvidence | undefined
): string | undefined {
  if (!evidence?.slots.length) return undefined;
  if (offeredSchedulingTimes(text).length) return undefined;
  const normalized = normalizeForEchoCheck(text);
  const defersAvailability = /\b(?:preciso|vou|irei|deixa\s+eu)\s+(?:consultar|verificar|checar|ver)\b/u.test(normalized)
    || /\bassim\s+que\b[^.]{0,60}\b(?:tiver|houver|souber|abrir)\b/u.test(normalized)
    || /\bnao\s+tenho\b[^.]{0,60}\b(?:horarios?|opcoes?|disponibilidade)\b/u.test(normalized)
    || /\b(?:horarios?|opcoes?)\b[^.]{0,40}\b(?:confirmad[oa]s?|concretos?)\b/u.test(normalized)
    || /\bte\s+(?:envio|passo|mando)\b[^.]{0,60}\b(?:opcoes?|horarios?)\b/u.test(normalized);
  if (!defersAvailability) return undefined;
  return "A agenda já foi consultada neste turno e retornou horários reais. Não diga que precisa consultar, que enviará depois nem que não tem opções confirmadas. Ofereça agora, em uma frase curta e natural, dois ou três dos horários retornados pela ferramenta, informando o dia correspondente.";
}

export function unsolicitedSchedulingOfferCorrection(text: string): string | undefined {
  const normalized = normalizeForEchoCheck(text);
  const proposesScheduling = /\b(?:agenda|agendar|agendamento|horario|horarios|reuniao|meet|marcar|reservar)\b/u.test(normalized)
    && (/\b(?:quer|podemos|posso|vamos|prefere|disponivel|tenho|temos|que tal)\b/u.test(normalized)
      || hasSchedulingTime(text));
  if (!proposesScheduling) return undefined;
  return "A mensagem atual do contato é casual e não trata de agenda. Reescreva a resposta de forma curta e natural, respondendo somente ao que ele disse. Não ofereça reunião, horários ou agendamento, não consulte agenda, não transfira o atendimento e não mencione esta correção.";
}

export function isTerminalAppointmentAcknowledgement(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const previousAssistant = lastAssistantMessage(history);
  return Boolean(
    TERMINAL_ACKNOWLEDGEMENT.test(normalizeForEchoCheck(text))
    && previousAssistant
    && !previousAssistant.includes("?")
    && CONFIRMED_APPOINTMENT.test(previousAssistant)
  );
}

function repeatedSchedulingConfirmationCorrection(text: string): string | undefined {
  if (!text.includes("?")) return undefined;
  const normalized = normalizeForEchoCheck(text);
  const asksAgain = CONFIRMATION_QUESTION.test(text)
    || /\b(?:quer\s+que\s+eu|prefere\s+mudar|mudar\s+o?\s*horario|mantemos|fica\s+combinado)\b/u.test(normalized);
  if (!asksAgain) return undefined;
  return "O contato já confirmou explicitamente o horário proposto. Não peça confirmação novamente e não repita a pergunta. Prossiga agora com as ferramentas de agenda necessárias para efetivar o agendamento; só confirme ao contato depois do sucesso da ferramenta.";
}

function ambiguousSchedulingChoiceCorrection(text: string): string | undefined {
  const normalized = normalizeForEchoCheck(text);
  const asksForOneChoice = text.includes("?")
    && /\b(?:qual(?:\s+(?:deles|desses|horario))?|que\s+horario).{0,45}\b(?:prefere|escolhe|fica\s+melhor|funciona)|\bqual\s+(?:deles|desses)\b/u.test(normalized);
  if (asksForOneChoice && !CONFIRMED_APPOINTMENT.test(text)) return undefined;
  return "A confirmação curta é ambígua porque havia vários horários oferecidos. Não escolha nem agende um deles. Faça somente uma pergunta curta para saber qual horário o contato prefere.";
}

function contextSearchDisclosureCorrection(text: string): string | undefined {
  if (!/\b(?:pesquisei|fiz\s+uma\s+pesquisa|na\s+(?:minha\s+)?pesquisa|encontrei\s+(?:na|pela)\s+(?:internet|web)|segundo\s+(?:a|uma)\s+pesquisa)\b/iu.test(text)) {
    return undefined;
  }
  return "A pesquisa contextual é interna. Responda sem mencionar que pesquisou, sem atribuir ao contato fatos externos e sem inventar detalhes; se ainda houver dúvida, confirme somente o termo.";
}

export function shouldForceLeadRegistration(
  text: string,
  facebookAttribution: Record<string, unknown>
): boolean {
  if (Object.keys(facebookAttribution).length > 0) return true;
  return /\b(?:agend|hor[aá]rio|reuni[aã]o|qualific|fatur|tempo\s+de\s+mercado|nicho|instagram|perd[ao]\s+de\s+vendas|investimento|proposta|atendente|especialista|transfer)\b/iu.test(text);
}

export function repeatedRecentQuestionCorrection(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): string | undefined {
  const proposedQuestions = text.split(/\n+/).filter((part) => part.includes("?"));
  if (!proposedQuestions.length) return undefined;
  const recentAssistantMessages = history
    .filter((item) => item.role === "assistant")
    .slice(-10)
    .map((item) => item.content);
  if (!proposedQuestions.some((question) => isNearDuplicateBubble(question, recentAssistantMessages))) return undefined;
  return "A resposta proposta repete uma pergunta recente do agente. Releia o histórico, aproveite o que o contato já informou e avance para o próximo ponto útil. Se a pergunta antiga ainda estiver sem resposta e for indispensável, explique em uma frase por que precisa dela e reformule sem repetir a mesma construção.";
}

export class ConversationBusyRetryError extends Error {
  constructor(
    readonly externalId: string,
    readonly conversationId: string
  ) {
    super("Conversation is busy; retry inbound message later");
    this.name = "ConversationBusyRetryError";
  }
}

export function ensureMeetingLinkInReply(text: string, meetLink?: string): string {
  const normalized = text.trim();
  if (!meetLink || normalized.includes(meetLink)) return normalized;
  return `${normalized}\n\nLink da reunião: ${meetLink}`;
}

function normalizeForEchoCheck(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentWords(text: string): string[] {
  return normalizeForEchoCheck(text).split(" ").filter((word) => word.length > 2);
}

function isEchoOfRecentUserMessage(candidate: string, recentUserMessages: string[]): boolean {
  const normalizedCandidate = normalizeForEchoCheck(candidate);
  if (!normalizedCandidate) return true;

  const candidateWords = contentWords(candidate);
  return recentUserMessages.some((message) => {
    const normalizedMessage = normalizeForEchoCheck(message);
    if (!normalizedMessage) return false;
    if (normalizedMessage.includes(normalizedCandidate)) return true;
    if (SHORT_PLEASANTRY.test(candidate) && SHORT_PLEASANTRY.test(message) && candidateWords.length <= 3) return true;

    const messageWords = new Set(contentWords(message));
    if (!candidateWords.length || candidateWords.length > messageWords.size) return false;
    const overlap = candidateWords.filter((word) => messageWords.has(word)).length;
    return candidateWords.length <= 4 && overlap === candidateWords.length;
  });
}

// After a mid-sequence restart the model regenerates the whole reply, so the
// new bubbles often restate what was already sent. Drops a bubble when it is
// textually equivalent or repeats the same appointment confirmation / URL.
export function isNearDuplicateBubble(candidate: string, sentBubbles: string[]): boolean {
  const normalizedCandidate = normalizeForEchoCheck(candidate);
  if (!normalizedCandidate) return true;
  const candidateWords = new Set(contentWords(candidate));
  const candidateUrls = new Set(
    candidate.match(/https?:\/\/[^\s]+/giu)?.map((url) => url.replace(/[.,;:!?]+$/u, "").toLocaleLowerCase("en-US")) ?? []
  );
  const candidateTimes = mentionedTimes(candidate);
  return sentBubbles.some((sentText) => {
    const normalizedSent = normalizeForEchoCheck(sentText);
    if (!normalizedSent) return false;
    if (normalizedSent.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedSent)) return true;
    if (candidateUrls.size) {
      const sentUrls = sentText.match(/https?:\/\/[^\s]+/giu)
        ?.map((url) => url.replace(/[.,;:!?]+$/u, "").toLocaleLowerCase("en-US")) ?? [];
      if (sentUrls.some((url) => candidateUrls.has(url))) return true;
    }
    if (
      candidateTimes.length
      && refersToSameSchedulingMoment(candidate, sentText)
      && isAppointmentConfirmation(candidate)
      && isAppointmentConfirmation(sentText)
    ) {
      return true;
    }
    const sentWords = new Set(contentWords(sentText));
    if (!candidateWords.size || !sentWords.size) return false;
    let overlap = 0;
    for (const word of candidateWords) if (sentWords.has(word)) overlap += 1;
    return overlap / (candidateWords.size + sentWords.size - overlap) >= 0.8;
  });
}

export function deduplicateReplyBubbles(bubbles: string[], sentBubbles: string[] = []): string[] {
  const accepted = [...sentBubbles];
  return bubbles.filter((bubble) => {
    if (isNearDuplicateBubble(bubble, accepted)) return false;
    accepted.push(bubble);
    return true;
  });
}

function stripRecentUserEchoes(text: string, history: Array<{ role: "user" | "assistant"; content: string }>): string {
  const recentUserMessages = history
    .filter((item) => item.role === "user")
    .slice(-RECENT_USER_ECHO_WINDOW)
    .map((item) => item.content);
  if (!recentUserMessages.length) return text;

  const segments = text.match(/[^.!?\n]+[.!?]?|\n+/g) ?? [text];
  const kept = segments.filter((segment) => {
    if (/^\s*\n+\s*$/.test(segment)) return true;
    return !isEchoOfRecentUserMessage(segment, recentUserMessages);
  });
  return kept.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function mentionsSpecificProductModel(history: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  const recentUserText = history
    .filter((item) => item.role === "user")
    .slice(-3)
    .map((item) => item.content)
    .join("\n");
  return textMentionsSpecificProductModel(recentUserText);
}

export function textMentionsSpecificProductModel(text: string): boolean {
  return SPECIFIC_PRODUCT_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

const AUTOMATIC_AI_RECOVERY_CODES = new Set([
  "empty_final_response",
  "empty_sanitized_response",
  "policy_retry_exhausted",
  "truncation_retry_exhausted",
  "unverified_slot_offer",
  "unauthorized_handoff"
]);

const AI_GENERATED_RECOVERY_CODES = new Set([
  ...AUTOMATIC_AI_RECOVERY_CODES,
  "final_synthesis_exhausted",
  "turn_budget_exceeded"
]);

export function isAutomaticAiRecoveryError(error: unknown): error is NonRetryableAiError {
  return isNonRetryableAiError(error) && AUTOMATIC_AI_RECOVERY_CODES.has(error.code);
}

function isAiGeneratedRecoveryError(error: unknown): error is NonRetryableAiError {
  return isNonRetryableAiError(error) && AI_GENERATED_RECOVERY_CODES.has(error.code);
}

export class MessageProcessor {
  constructor(
    private readonly repository: MessageRepository,
    private readonly gateway: MessageGateway,
    private readonly ai: AiRouter,
    private readonly dispatchHandoff: (notification: HandoffNotification) => Promise<void> = async (notification) => {
      const sent = await gateway.sendText(notification.sessionId, notification.attendantPhone, notification.message);
      await repository.markHandoffNotificationSent(notification.id, sent.externalId);
    },
    private readonly schedulingMinimumLeadMinutes = 15,
    private readonly aiTurnProgress?: AiTurnProgressPublisher,
    /**
     * Injetado como função para não acoplar o processamento de mensagens ao
     * módulo de scheduling. Opcional: quando ausente, o turno segue normal e
     * apenas o registro de confirmação deixa de acontecer.
     */
    private readonly registerContactConfirmation?: (
      tenantId: string,
      appointmentId: string,
      response: string
    ) => Promise<boolean>
  ) {}

  async process(
    message: SessionMessage,
    processing: { attempt?: number; requestId?: string; automaticRecoveryAttempt?: number } = {}
  ): Promise<"answered" | "fallback" | "handoff" | "human_recorded" | "ignored" | "duplicate"> {
    const requestId = processing.requestId ?? randomUUID();
    const processingAttempt = processing.attempt ?? 1;
    const automaticRecoveryAttempt = processing.automaticRecoveryAttempt ?? 0;
    if (message.kind === "human") {
      const result = await this.repository.recordHuman(message);
      return result === "recorded" ? "human_recorded" : "duplicate";
    }
    const initialContext = await this.repository.recordInboundAndLoadContext(message);
    if (!initialContext) return "duplicate";
    const turnBudget = await this.repository.getAiUsageTotals({
      tenantId: message.tenantId,
      conversationId: initialContext.conversationId,
      messageId: initialContext.messageId,
      requestId
    });
    const aiTrace = (reason: string) => ({
      conversationId: initialContext.conversationId,
      messageId: initialContext.messageId,
      requestId,
      processingAttempt,
      reason,
      turnBudget,
      tenantId: message.tenantId,
      contactPhone: message.contactPhone
    });
    logger.info({
      event: "ai_message_processing",
      conversationId: initialContext.conversationId,
      messageId: initialContext.messageId,
      requestId,
      model: initialContext.model,
      attempt: processingAttempt,
      reason: "inbound_message"
    }, "AI message processing started");
    if (message.channel !== "instagram") {
      void this.gateway.refreshContactAvatar?.(message.sessionId, message.contactPhone).catch(() => undefined);
    }
    let context = initialContext;
    try {
    if (!context.aiActive) {
      logger.info({ externalId: message.externalId, conversationId: context.conversationId, reason: "ai_inactive" }, "Inbound message ignored");
      await this.repository.markInboundProcessed(message);
      return "ignored";
    }

    let effectiveMessage = message;
    const config = context.humanizer;
    const destination = message.channel === "instagram"
      ? `ig:${message.instagramContactId}`
      : message.contactJid ?? message.contactPhone;
    await this.gateway.setPresence(message.sessionId, "available");
    const conversationKey = `${message.tenantId}:${destination}`;
    const remoteJid = message.channel === "instagram"
      ? destination
      : message.contactJid ?? `${message.contactPhone}@s.whatsapp.net`;
    const readReceiptExternalIds = new Set<string>();
    const allReceipts: Array<{ id: string; remoteJid: string; fromMe: false }> = [];
    const markContactMessagesRead = async (externalIds: string[]) => {
      const ids = Array.from(new Set(externalIds)).filter((id) => id && !readReceiptExternalIds.has(id));
      if (!ids.length) return [] as Array<{ id: string; remoteJid: string; fromMe: false }>;
      const receipts = ids.map(id => ({ id, remoteJid, fromMe: false as const }));
      await this.gateway.markMessageAsRead(message.sessionId, receipts);
      await this.repository.markContactMessagesRead(context.conversationId, ids);
      ids.forEach((id) => readReceiptExternalIds.add(id));
      allReceipts.push(...receipts);
      return receipts;
    };

    // A held lock means this contact is already seeing "typing". Acknowledge
    // the new message before debounce so WhatsApp shows both blue ticks
    // immediately while the active turn absorbs it.
    if (await isConversationLocked(conversationKey)) {
      await markContactMessagesRead([message.externalId]);
    }

    if (config && !message.mediaType) {
      const debounceCfg = config.debounce;
      const debounced = await debounceInbound(`${message.tenantId}:${destination}`, message.text, {
        initialWindowMs: humanizedDelay(randomBetween(debounceCfg.initialWindowMs), config),
        silenceWindowMs: humanizedDelay(randomBetween(debounceCfg.silenceWindowMs), config),
        extensionMs: humanizedDelay(randomBetween(debounceCfg.extensionMs), config),
      });
      if (!debounced.process) {
        logger.info({ externalId: message.externalId, conversationId: context.conversationId, reason: "debounce_superseded" }, "Inbound message ignored");
        await this.repository.markInboundProcessed(message);
        return "ignored";
      }
      effectiveMessage = { ...message, text: debounced.text };

      // Other fragments from this contact may have been persisted while this
      // processor waited for the debounce window. Refresh the snapshot so the
      // model sees those messages and any replies that completed meanwhile.
      const refreshedContext = await this.repository.recordInboundAndLoadContext(message, { claim: false });
      if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
    }

    // Debounce only coalesces fragments that arrive within the same silence
    // window. A message that arrives while a prior AI turn for this contact
    // is still in flight (network latency, humanized delays) starts its own
    // debounce cycle and would otherwise call the model concurrently with
    // that turn, producing two independent, contradictory replies. Serialize
    // everything from here on per conversation so only one reply is generated
    // and sent at a time.
    const conversationLock = await acquireConversationLock(conversationKey);
    if (!conversationLock) {
      await markContactMessagesRead([message.externalId]);
      logger.warn({ externalId: message.externalId, conversationId: context.conversationId, reason: "conversation_locked" }, "Inbound message will be retried");
      throw new ConversationBusyRetryError(message.externalId, context.conversationId);
    }
    let aiProgress: AiTurnProgressSession | null = null;
    try {
      aiProgress = await this.aiTurnProgress?.start({
        tenantId: message.tenantId,
        conversationId: context.conversationId,
        turnId: requestId,
        attempt: processingAttempt,
        phase: "reading",
        label: "Lendo a conversa…"
      }) ?? null;
    } catch (error) {
      logger.warn({
        err: error,
        conversationId: context.conversationId,
        turnId: requestId,
        phase: "reading"
      }, "AI turn progress start failed");
    }
    const publishAiProgress = async (
      input: Parameters<AiTurnProgressSession["publish"]>[0]
    ): Promise<void> => {
      if (!aiProgress) return;
      try {
        await aiProgress.publish(input);
      } catch (error) {
        logger.warn({
          err: error,
          conversationId: context.conversationId,
          turnId: requestId,
          phase: input.phase
        }, "AI turn progress update failed");
      }
    };
    // A humanized turn (read pauses + composing per bubble + tool iterations,
    // all multiplied off-hours) can outlast the 60s lock TTL; when it expires,
    // a BullMQ retry acquires the lock mid-turn and sends a second full reply.
    // Keep the TTL alive for as long as this turn is running.
    const lockHeartbeat = setInterval(() => {
      void extendConversationLock(conversationLock).then((extended) => {
        if (!extended) logger.warn({ externalId: message.externalId, conversationId: context.conversationId }, "Conversation lock lost mid-turn");
      }).catch((err) => logger.error({ err, conversationId: context.conversationId }, "Failed to extend conversation lock"));
    }, 20_000);
    try {
    if (config) await sleep(humanizedDelay(randomBetween(config.readDelay), config));

    let mediaUnderstood = false;
    if (message.mediaType) {
      await publishAiProgress({
        phase: "analyzing_media",
        label: message.mediaType === "audio" ? "Analisando o áudio…" : "Analisando a mídia…"
      });
    }
    if (message.mediaType === "audio") {
      const persistedTranscription = await this.repository.findAudioTranscription(message);
      if (persistedTranscription) {
        effectiveMessage = { ...message, text: persistedTranscription };
        mediaUnderstood = true;
      } else if (this.gateway.downloadMedia && this.ai.transcribe) {
        try {
          const media = await this.gateway.downloadMedia(message.sessionId, message.externalId);
          const recordUsage = (usage: Parameters<NonNullable<Parameters<typeof this.ai.complete>[0]["onUsage"]>>[0]) =>
            this.repository.recordAiUsage({
              tenantId: message.tenantId,
              conversationId: context.conversationId,
              messageId: context.messageId,
              requestId,
              ...usage
            });
          const transcription = await this.ai.transcribe({
            audioBase64: media.base64,
            format: transcriptionAudioFormat(media.mimeType, media.fileName),
            apiKey: context.openRouterApiKey,
            language: "pt",
            prompt: audioTranscriptionPrompt(context.systemPrompt, context.history),
            trace: aiTrace("audio_transcription"),
            onUsage: recordUsage
          });
          await this.repository.recordAudioTranscription(message, transcription.text);
          effectiveMessage = { ...message, text: transcription.text };
          const refreshedContext = await this.repository.recordInboundAndLoadContext(effectiveMessage, { claim: false });
          if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
          mediaUnderstood = true;
        } catch (error) {
          logger.warn({ err: error, externalId: message.externalId, conversationId: context.conversationId }, "Audio transcription failed; using media fallback");
          await this.repository.createSystemAlertOnce(message.tenantId, mediaFailureAlert("audio", error))
            .catch((alertError) => logger.error({ err: alertError, tenantId: message.tenantId }, "Failed to create audio transcription alert"));
        }
      }
    } else if (message.mediaType === "image" || message.mediaType === "document") {
      const persistedAnalysis = await this.repository.findMediaAnalysis(message);
      if (persistedAnalysis) {
        effectiveMessage = { ...message, text: persistedAnalysis };
        mediaUnderstood = true;
      } else if (this.gateway.downloadMedia && this.ai.analyzeMedia) {
        try {
          const media = await this.gateway.downloadMedia(message.sessionId, message.externalId);
          const recordUsage = (usage: Parameters<NonNullable<Parameters<typeof this.ai.complete>[0]["onUsage"]>>[0]) =>
            this.repository.recordAiUsage({
              tenantId: message.tenantId,
              conversationId: context.conversationId,
              messageId: context.messageId,
              requestId,
              ...usage
            });
          const analysis = await this.ai.analyzeMedia({
            model: context.model,
            mediaType: message.mediaType,
            base64: media.base64,
            mimeType: media.mimeType !== "application/octet-stream" ? media.mimeType : message.mediaMimeType ?? media.mimeType,
            fileName: media.fileName ?? message.mediaFileName,
            caption: message.text,
            mediaIsSticker: message.mediaIsSticker,
            apiKey: context.openRouterApiKey,
            provider: context.provider,
            trace: aiTrace("media_analysis"),
            onUsage: recordUsage
          });
          const analyzedText = mediaAnalysisContext(message.mediaType, analysis.text, message.text, message.mediaIsSticker);
          await this.repository.recordMediaAnalysis(message, analyzedText);
          effectiveMessage = { ...message, text: analyzedText };
          const refreshedContext = await this.repository.recordInboundAndLoadContext(effectiveMessage, { claim: false });
          if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
          mediaUnderstood = true;
        } catch (error) {
          logger.warn({ err: error, externalId: message.externalId, conversationId: context.conversationId, mediaType: message.mediaType }, "Media analysis failed; using media fallback");
          await this.repository.createSystemAlertOnce(message.tenantId, mediaFailureAlert(message.mediaType, error))
            .catch((alertError) => logger.error({ err: alertError, tenantId: message.tenantId }, "Failed to create media analysis alert"));
        }
      }
    }

    // A figurinha é uma reação conversacional, não um motivo para interromper
    // o atendimento. Se a visão estiver indisponível, ainda deixamos o agente
    // principal responder naturalmente sem inventar ou verbalizar seu conteúdo.
    if (message.mediaIsSticker && !mediaUnderstood) {
      effectiveMessage = {
        ...message,
        text: mediaAnalysisContext(
          "image",
          "O contato enviou uma reação visual; o conteúdo específico não pôde ser analisado.",
          message.text,
          true
        )
      };
      await this.repository.recordMediaAnalysis(message, effectiveMessage.text);
      const refreshedContext = await this.repository.recordInboundAndLoadContext(effectiveMessage, { claim: false });
      if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
      mediaUnderstood = true;
    }

    let processingExternalIds = [message.externalId];
    const refreshPendingTextMessages = async (): Promise<"consumed" | "unchanged" | "updated"> => {
      if (message.mediaType) return "unchanged";
      const pendingTextMessages = await this.repository.findPendingContactTextMessages(context.conversationId, message.externalId);
      if (!pendingTextMessages.length) return "consumed";
      const nextExternalIds = pendingTextMessages.map((item) => item.externalId);
      const hasNewMessages = nextExternalIds.some((id) => !processingExternalIds.includes(id));
      if (!hasNewMessages) return "unchanged";

      processingExternalIds = nextExternalIds;
      effectiveMessage = { ...effectiveMessage, text: pendingTextMessages.map((item) => item.text).join("\n") };
      const refreshedContext = await this.repository.recordInboundAndLoadContext(message, { claim: false });
      if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
      return "updated";
    };
    if (await refreshPendingTextMessages() === "consumed") {
      logger.info({
        externalId: message.externalId,
        conversationId: context.conversationId,
        reason: "already_consumed_by_previous_turn"
      }, "Inbound message already included in an earlier AI reply");
      return "duplicate";
    }

    const readThroughExternalId = processingExternalIds.at(-1) ?? message.externalId;
    const unreadIds = await this.repository.findUnreadContactMessages(context.conversationId, readThroughExternalId);
    const receiptIds = [...processingExternalIds, ...unreadIds.filter(id => !processingExternalIds.includes(id))];
    await markContactMessagesRead(receiptIds);
    const receipts = allReceipts;
    const capabilityEnabled = async (key: CapabilityKey): Promise<boolean> => {
      try {
        // Lightweight unit doubles created before the capability catalog do not
        // implement this method. Production always uses MessageRepository.
        if (typeof this.repository.capabilityEnabled !== "function") return true;
        return await this.repository.capabilityEnabled(message.tenantId, key);
      } catch (error) {
        logger.error({ err: error, tenantId: message.tenantId, capability: key }, "Capability lookup failed during AI turn");
        return false;
      }
    };
    const [leadsCapabilityEnabled, appointmentsCapabilityEnabled] = await Promise.all([
      capabilityEnabled("leads_v1"),
      capabilityEnabled("appointments_v1")
    ]);
    // Registro anti no-show: uma resposta afirmativa do contato promove o
    // agendamento a CONFIRMADO. Fica antes de qualquer ramo que encerre o
    // turno (inclusive o de reação com 👍), senão um "sim" seguido de "ok"
    // seria lido como confirmação e nunca chegaria aqui.
    if (appointmentsCapabilityEnabled && context.activeAppointment && this.registerContactConfirmation) {
      try {
        await this.registerContactConfirmation(
          message.tenantId,
          context.activeAppointment.id,
          effectiveMessage.text
        );
      } catch (error) {
        // Confirmação é sinal comercial, não parte do fluxo de resposta:
        // uma falha aqui nunca pode derrubar o atendimento.
        logger.error(
          { err: error, tenantId: message.tenantId, appointmentId: context.activeAppointment.id },
          "Falha ao registrar confirmação de presença do contato"
        );
      }
    }
    if (
      appointmentsCapabilityEnabled
      && context.activeAppointment
      && this.gateway.sendReaction
      && isTerminalAppointmentAcknowledgement(effectiveMessage.text, context.history)
    ) {
      const acknowledgementExternalId = processingExternalIds.at(-1) ?? message.externalId;
      const acknowledgementReceipt = receipts.find((receipt) => receipt.id === acknowledgementExternalId) ?? receipts.at(-1);
      if (acknowledgementReceipt) {
        await this.gateway.sendReaction(message.sessionId, destination, acknowledgementReceipt, "👍");
        await this.repository.markInboundProcessed(message, processingExternalIds);
        logger.info({
          externalId: message.externalId,
          conversationId: context.conversationId,
          reason: "terminal_appointment_acknowledgement"
        }, "Appointment acknowledgement handled with reaction only");
        return "answered";
      }
    }
    const absorbMessagesReceivedWhileComposing = async (): Promise<boolean> => {
      // Se este turno já persistiu uma ação de agenda, conclua e comunique esse
      // fato antes de absorver uma mensagem nova. Regenerar com o snapshot que
      // existia antes do commit fazia a IA tentar criar o mesmo compromisso de
      // novo; a falha "já possui agendamento" então escondia o sucesso real.
      // A nova mensagem permanece pendente e será processada no próprio job,
      // já com o agendamento ativo carregado do banco.
      if (successfulCustomerTransactionalOutcomeExists(transactionalOutcomes)) return false;
      if (await refreshPendingTextMessages() !== "updated") return false;

      const latestExternalId = processingExternalIds.at(-1) ?? message.externalId;
      const latestUnreadIds = await this.repository.findUnreadContactMessages(context.conversationId, latestExternalId);
      const newReceiptIds = [...processingExternalIds, ...latestUnreadIds]
        .filter((id, index, ids) => ids.indexOf(id) === index && !readReceiptExternalIds.has(id));
      if (newReceiptIds.length) {
        await markContactMessagesRead(newReceiptIds);
      }
      return true;
    };
    const refreshContextSnapshot = async (): Promise<void> => {
      const refreshedContext = await this.repository.recordInboundAndLoadContext(message, { claim: false });
      if (refreshedContext) context = refreshContextWithinTurn(initialContext, refreshedContext);
    };
    if (config) await sleep(humanizedDelay(randomBetween(config.readingPause), config));

    const tripzZuluAgent = isTripzZuluAgent(context.systemPrompt, context.tripzZuluEnabled === true);
    // context.history always includes the current inbound turn (repository.ts
    // unions in the just-inserted row), so a brand-new conversation has
    // length 1, never 0 — this never fired in production before.
    const freshTripzOwnerReferral = context.history.length <= 1
      && tripzZuluAgent
      && tripzZuluDetectsOwnerNameReferral(effectiveMessage.text);
    const tripzOwnerRequested = tripzZuluAgent
      && tripzZuluRequestsOwnerHandoff(effectiveMessage.text);
    if (freshTripzOwnerReferral || tripzOwnerRequested) {
      const sent = await this.gateway.sendText(message.sessionId, destination, TRIPZ_ZULU_OWNER_REFERRAL_REPLY);
      await this.repository.recordAgentReply({
        tenantId: message.tenantId, sessionId: message.sessionId, conversationId: context.conversationId,
        agentConfigVersionId: context.agentConfigVersionId, text: TRIPZ_ZULU_OWNER_REFERRAL_REPLY,
        model: "owner-referral-guard", externalId: sent.externalId,
        inboundExternalId: message.externalId, inboundExternalIds: processingExternalIds
      });
      const notificationText = tripzOwnerRequested
        ? `AtendON: ${message.contactName ?? context.contactIdentifier ?? message.contactPhone} pediu para falar com o Lucas, assuma o atendimento.`
        : `AtendON: ${message.contactName ?? context.contactIdentifier ?? message.contactPhone} chegou já falando o nome do Lucas, assuma o atendimento.`;
      const notification = await this.repository.pauseForHandoff({
        tenantId: message.tenantId,
        conversationId: context.conversationId,
        sessionId: message.sessionId,
        reason: "contact_requested",
        assigneeName: TRIPZ_ZULU_OWNER_NAME,
        idempotencyKey: `${message.sessionId}:${message.externalId}:${tripzOwnerRequested ? "owner_requested" : "owner_referral"}`,
        notificationText
      });
      if (notification) await this.dispatchHandoff(notification);
      await this.repository.markInboundProcessed(message, processingExternalIds);
      return "handoff";
    }

    if (
      contactRequestsHandoff(effectiveMessage.text)
      || contactAcceptsOfferedHandoff(effectiveMessage.text, context.history)
    ) {
      const notificationText = `AtendON: ${message.contactName ?? context.contactIdentifier ?? message.contactPhone} pediu atendimento humano.`;
      const notification = await this.repository.pauseForHandoff({
        tenantId: message.tenantId,
        conversationId: context.conversationId,
        sessionId: message.sessionId,
        reason: "contact_requested",
        idempotencyKey: `${message.sessionId}:${message.externalId}:contact_requested`,
        notificationText
      });
      if (notification) await this.dispatchHandoff(notification);
      await this.repository.markInboundProcessed(message, processingExternalIds);
      return "handoff";
    }

    if (message.mediaType && !mediaUnderstood) {
      const text = context.mediaFallback?.[message.mediaType] ?? mediaFallback(message.mediaType);
      const sent = await this.gateway.sendText(message.sessionId, destination, text);
      await this.repository.recordFallback({ tenantId: message.tenantId, sessionId: message.sessionId,
        conversationId: context.conversationId, agentConfigVersionId: context.agentConfigVersionId,
        mediaType: message.mediaType, text, externalId: sent.externalId });
      await this.repository.markInboundProcessed(message, processingExternalIds);
      return "fallback";
    }

    if (isPromptInjection(effectiveMessage.text)) {
      const sent = await this.gateway.sendText(message.sessionId, destination, PROMPT_INJECTION_REPLY);
      await this.repository.recordAgentReply({ tenantId: message.tenantId, sessionId: message.sessionId,
        conversationId: context.conversationId, agentConfigVersionId: context.agentConfigVersionId,
        text: PROMPT_INJECTION_REPLY, model: "security-guard",
        externalId: sent.externalId, inboundExternalId: message.externalId, inboundExternalIds: processingExternalIds });
      return "answered";
    }

    if (config && !await consumeRateLimitRedis(`${message.tenantId}:${destination}`, config.rateLimit.maxMessagesPerContactPerMinute)) {
      logger.warn({ externalId: message.externalId, conversationId: context.conversationId, reason: "rate_limited" }, "Inbound message ignored");
      await this.repository.markInboundProcessed(message, processingExternalIds);
      return "ignored";
    }
    await publishAiProgress({ phase: "generating", label: "Preparando uma resposta…" });
    const composingRefreshMs = config?.composing.resendIntervalMs ?? 8_000;
    const refreshComposing = () => this.gateway.sendPresence(
      message.sessionId, destination, "composing", composingRefreshMs + 1_000
    );
    const withCustomerComposing = async <T>(operation: () => Promise<T>): Promise<T> => {
      await refreshComposing();
      try {
        return await withComposingRefresh(composingRefreshMs, refreshComposing, operation);
      } finally {
        await this.gateway.sendPresence(message.sessionId, destination, "paused", 500);
      }
    };
    let latestPreview: ReturnType<typeof buildAiTurnPreview> | null = null;
    const publishPreview = async (previewBubbles: readonly string[]): Promise<void> => {
      latestPreview = buildAiTurnPreview(previewBubbles);
      await publishAiProgress({
        phase: "preview",
        label: "Prévia · ainda não enviada",
        ...latestPreview
      });
    };
    const publishSending = async (): Promise<void> => {
      await publishAiProgress({
        phase: "sending",
        label: "Enviando resposta…",
        ...(latestPreview ?? {})
      });
    };
    const previewDelay = (text: string): number => {
      const typingDelay = config ? composingDuration(text, config) : 0;
      return aiProgress ? Math.max(1_500, typingDelay) : typingDelay;
    };

    const recordUsage = (usage: Parameters<NonNullable<Parameters<typeof this.ai.complete>[0]["onUsage"]>>[0]) =>
      this.repository.recordAiUsage({
        tenantId: message.tenantId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        requestId,
        ...usage
      });

    if (appointmentsCapabilityEnabled && context.activeAppointment && activeAppointmentMatchesPendingConfirmation(
      effectiveMessage.text,
      context.history,
      context.activeAppointment.start,
      context.timeZone
    )) {
      const appointmentFacts = composeActiveAppointmentConfirmation(context.activeAppointment, context.timeZone);
      const validatePersistedAppointmentText = (candidate: string): string | undefined => {
        const parsedCandidate = parseAgentHandoff(sanitizeOutbound(candidate, ""));
        if (parsedCandidate.handoff || !parsedCandidate.text) {
          return "Confirme diretamente o compromisso existente sem transferência ou marcador interno.";
        }
        const expectedTime = slotLocalTime(context.activeAppointment!.start, context.timeZone);
        const mentioned = mentionedTimes(parsedCandidate.text);
        if ((expectedTime && !mentioned.includes(expectedTime))
          || (context.activeAppointment!.meetLink && !parsedCandidate.text.includes(context.activeAppointment!.meetLink))) {
          return `Reescreva com seus próprios termos, mas confirme exatamente estes fatos persistidos: ${appointmentFacts}.`;
        }
        return meetingDurationDisclosureCorrection(parsedCandidate.text)
          ?? internalCorrectionDisclosureCorrection(parsedCandidate.text);
      };
      const completion = await this.ai.complete({
        model: context.model,
        provider: context.provider,
        systemPrompt: [
          "Você é o atendente configurado para esta conversa. O compromisso abaixo já existe no banco; responda ao contato com uma confirmação curta, natural e original.",
          `FATOS OBRIGATÓRIOS DO COMPROMISSO: ${appointmentFacts}`,
          "Não chame ferramentas, não peça confirmação novamente e não mencione sistema, correção, erro ou transferência.",
          "CONFIGURAÇÃO DO AGENTE:",
          context.systemPrompt
        ].join("\n\n"),
        temperature: context.temperature,
        maxTokens: Math.min(context.maxTokens, 300),
        reasoningEffort: context.reasoningEffort ?? "low",
        apiKey: context.openRouterApiKey,
        history: context.history.slice(-8),
        trace: aiTrace("persisted_appointment_confirmation"),
        onUsage: recordUsage,
        validateFinalText: validatePersistedAppointmentText
      });
      const parsedCompletion = parseAgentHandoff(
        sanitizeOutbound(stripRecentUserEchoes(completion.text, context.history), "")
      );
      if (parsedCompletion.handoff || !parsedCompletion.text
        || validatePersistedAppointmentText(parsedCompletion.text)) {
        throw new NonRetryableAiError(
          "persisted_appointment_confirmation_invalid",
          "AI did not produce a valid persisted appointment confirmation"
        );
      }
      const text = parsedCompletion.text;
      await publishPreview([text]);
      const createdAt = new Date();
      const sent = await withCustomerComposing(async () => {
        await sleep(previewDelay(text));
        await publishSending();
        return this.gateway.sendText(message.sessionId, destination, text);
      });
      await this.repository.recordAgentReply({
        tenantId: message.tenantId,
        sessionId: message.sessionId,
        conversationId: context.conversationId,
        agentConfigVersionId: context.agentConfigVersionId,
        text,
        model: context.model,
        externalId: sent.externalId,
        createdAt,
        bubbles: [{ text, externalId: sent.externalId, createdAt }],
        inboundExternalId: message.externalId,
        inboundExternalIds: [...processingExternalIds]
      });
      logger.info({
        event: "ai_message_processing",
        conversationId: context.conversationId,
        messageId: context.messageId,
        requestId,
        reason: "appointment_already_matches_confirmation"
      }, "Persisted appointment already matched the pending confirmation; delivered AI-generated confirmation");
      return "answered";
    }

    // Web search on demand: the model's own knowledge of device lineups goes
    // stale, so existence checks must come from a live lookup, never memory.
    const pesquisarModelo = async (modelo: string) => {
      const search = await this.ai.complete({
        model: context.model,
        provider: context.provider,
        systemPrompt: "Você verifica na web se modelos de eletrônicos existem como produto real já anunciado oficialmente ou vendido. Ignore rumores, vazamentos, conceitos, previsões e páginas sem fonte confiável. Responda em uma linha, apenas 'encontrado' ou 'não encontrado'. É um dado interno de sistema: nunca escreva frases de atendimento nem texto para cliente.",
        temperature: 0,
        maxTokens: 300,
        apiKey: context.openRouterApiKey,
        history: [{ role: "user", content: `O modelo "${modelo}" existe como produto real já anunciado oficialmente ou vendido?` }],
        plugins: [{ id: "web", max_results: 3 }],
        trace: aiTrace("product_search"),
        onUsage: recordUsage
      });
      // Normaliza para o binário: ano/fabricante/especificações nunca chegam ao
      // agente principal, então não têm como vazar para o cliente.
      return normalizeModelSearchResult(search.text);
    };
    const pesquisarContexto = async (termo: string) => {
      const search = await this.ai.complete({
        model: context.model,
        provider: context.provider,
        systemPrompt: "Pesquise para desambiguar um termo comercial possivelmente mal transcrito em uma conversa brasileira. Resuma em até 3 frases factuais e curtas, priorizando fontes oficiais e correspondência fonética/contextual. Se não houver confirmação confiável, responda apenas 'inconclusivo'. Este resultado é interno e não é uma mensagem ao cliente.",
        temperature: 0,
        maxTokens: 400,
        apiKey: context.openRouterApiKey,
        history: [{ role: "user", content: `Verifique o termo: "${termo}"` }],
        plugins: [{ id: "web", max_results: 3 }],
        trace: aiTrace("business_context_search"),
        onUsage: recordUsage
      });
      return search.text;
    };
    // Explicit human requests are handled deterministically above. Never expose
    // the old autonomous transfer tool, even when a persisted agent version
    // still contains it in enabled_tools.
    const configuredToolNames = await filterAiToolsByCapabilities(
      (context.enabledToolNames?.length ? context.enabledToolNames : DEFAULT_ENABLED_TOOL_NAMES)
        .filter((name) => name !== "transferir_atendente"),
      (key) => Promise.resolve(key === "leads_v1" ? leadsCapabilityEnabled : appointmentsCapabilityEnabled)
    );
    // Sem nenhuma ferramenta de agenda configurada para o tenant, classificar
    // intenção/confirmação de agendamento só produziria instruções de prompt
    // apontando para ferramentas inexistentes (caso do Zulu/Tripz).
    const schedulingToolsConfigured = configuredToolNames.some((name) => PROACTIVE_SCHEDULING_TOOL_NAMES.has(name));
    const stickerCatalog = await this.repository.listAiStickerCatalog?.(message.tenantId, context.conversationId) ?? [];
    const allowedStickerIds = new Set(stickerCatalog.map((sticker) => sticker.id.toLocaleLowerCase("en-US")));
    let selectedStickerId: string | undefined;
    const leadReadyForScheduling = leadsCapabilityEnabled && (context.leadQualificationStars !== undefined
      || context.leadStatus === "qualificado"
      || context.leadStatus === "agendado");
    const hasRegisteredLead = leadsCapabilityEnabled && Boolean(context.registeredLead || context.leadStatus);
    const hasActiveAppointment = appointmentsCapabilityEnabled && Boolean(context.activeAppointment);
    const leadRegistrationRequired = !hasRegisteredLead
      && configuredToolNames.includes("registrar_lead")
      && shouldForceLeadRegistration(
        `${lastAssistantMessage(context.history) ?? ""}\n${effectiveMessage.text}`,
        context.facebookAttribution ?? {}
      );
    const commercialInformationTurn = isCommercialInformationTurn(effectiveMessage.text);
    const pureSocialTurn = isPureSocialTurn(effectiveMessage.text);
    // A form lead and a lead already qualified remain in their commercial
    // progression, except when the customer has asked a concrete informational
    // question. That question must be answered before agenda tools are exposed.
    const schedulingRelevantTurn = (leadRegistrationRequired && !pureSocialTurn)
      || turnConcernsScheduling(effectiveMessage.text, context.history)
      || (leadReadyForScheduling && !commercialInformationTurn);
    const objectionRecoveryTurn = needsObjectionRecovery(context.history);
    const ambiguousSchedulingTurn = !hasActiveAppointment
      && isAmbiguousSchedulingConfirmation(effectiveMessage.text, context.history);
    const confirmedSchedulingTurn = leadReadyForScheduling
      && schedulingToolsConfigured
      && !hasActiveAppointment
      && isConfirmedSchedulingTurn(effectiveMessage.text, context.history);
    const specificSchedulingIntent = leadReadyForScheduling && schedulingToolsConfigured
      ? classifySpecificSchedulingIntent(effectiveMessage.text)
      : undefined;
    const confirmedSchedulingTime = confirmedSchedulingTurn
      ? mentionedTimes(lastAssistantMessage(context.history) ?? "")[0]
      : undefined;
    const effectiveSchedulingIntent: SpecificSchedulingIntent | undefined = specificSchedulingIntent
      ?? (confirmedSchedulingTime
        ? { kind: "direct_schedule", time: confirmedSchedulingTime }
        : undefined);
    const schedulingPeriodPreference = leadReadyForScheduling && schedulingToolsConfigured
      ? classifySchedulingPeriodPreference(effectiveMessage.text, context.history)
        ?? pendingSchedulingPeriodPreference(effectiveMessage.text, context.history)
      : undefined;
    const canonicalState = deriveCanonicalConversationState({
      aiActive: context.aiActive,
      leadRegistered: hasRegisteredLead,
      leadStatus: context.leadStatus,
      commercialOverrideActive: context.commercialAutomationOverride,
      qualificationRequired: configuredToolNames.includes("qualificar_lead"),
      qualificationCompleted: leadReadyForScheduling,
      activeAppointment: hasActiveAppointment,
      schedulingIntent: effectiveSchedulingIntent?.kind,
      confirmedSchedulingTurn,
      ambiguousSchedulingTurn,
      persistedSlotOffer: hasPersistedSlotOffer(context.history)
    });
    // Com reunião marcada, reler a disponibilidade só faz sentido se o contato
    // pediu mudança ou citou um horário: sem isso o modelo consultava a agenda a
    // cada "ok" e reabria a oferta de horários sobre um agendamento já fechado.
    // Reagendar e cancelar continuam à mão, pois exigem um horário explícito e
    // não produzem lista de opções.
    const keepsExistingAppointment = hasActiveAppointment
      && !APPOINTMENT_CHANGE_REQUEST.test(effectiveMessage.text)
      && !hasSchedulingTime(effectiveMessage.text);
    // Qualification is a one-time transition. Once persisted, hiding the tool
    // prevents a simple slot selection/confirmation from spending tool rounds
    // rewriting the same qualification instead of creating the appointment.
    const legacyEnabledToolNames = configuredToolNames.filter((name) => {
      if (!schedulingRelevantTurn && PROACTIVE_SCHEDULING_TOOL_NAMES.has(name)) return false;
      if (objectionRecoveryTurn && OBJECTION_RECOVERY_BLOCKED_TOOLS.has(name)) return false;
      if (leadReadyForScheduling && name === "qualificar_lead") return false;
      if (hasActiveAppointment && (name === "agendar_reuniao" || name === "agendar_visita")) return false;
      if (keepsExistingAppointment && AVAILABILITY_TOOL_NAMES.has(name)) return false;
      if (ambiguousSchedulingTurn && [
        "verificar_horarios", "verificar_horarios_reuniao",
        "agendar_visita", "agendar_reuniao", "reagendar_visita", "reagendar_reuniao"
      ].includes(name)) return false;
      return true;
    });
    const enabledToolNames = context.stateToolGatingEnabled
      ? gateToolsForCanonicalState(
        configuredToolNames.filter((name) => {
          if (!schedulingRelevantTurn && PROACTIVE_SCHEDULING_TOOL_NAMES.has(name)) return false;
          if (keepsExistingAppointment && AVAILABILITY_TOOL_NAMES.has(name)) return false;
          return !objectionRecoveryTurn || !OBJECTION_RECOVERY_BLOCKED_TOOLS.has(name);
        }),
        canonicalState
      )
      : legacyEnabledToolNames;
    const canSearchModels = enabledToolNames.includes("pesquisar_modelo");
    const canSearchContext = enabledToolNames.includes("pesquisar_contexto");
    const canVerifyMeetingAvailability = enabledToolNames.includes("verificar_horarios_reuniao");
    const unknownCommercialTerm = canSearchContext && !textMentionsSpecificProductModel(effectiveMessage.text)
      ? extractUnknownCommercialTerm(effectiveMessage.text, context.systemPrompt)
      : undefined;
    const forceLeadRegistration = leadRegistrationRequired
      && enabledToolNames.includes("registrar_lead");
    const schedulingProgressToolName = (confirmedSchedulingTurn || effectiveSchedulingIntent || schedulingPeriodPreference)
      ? (hasActiveAppointment
        ? ["verificar_horarios_reuniao", "verificar_horarios", "reagendar_reuniao", "reagendar_visita"]
        : ["consultar_agendas", "consultar_unidades", "verificar_horarios_reuniao", "verificar_horarios", "agendar_reuniao", "agendar_visita"])
        .find((name) => enabledToolNames.includes(name))
      : undefined;
    const transactionalOutcomes: TransactionalOutcome[] = [];
    let requestedSlotAvailable: boolean | undefined;
    let latestMeetingAvailability: MeetingAvailabilityEvidence | undefined;
    let meetingSlotDurationMinutes = canonicalMeetingSlotDuration(context);
    type QualitySignalKind = "repeated_offer" | "unnecessary_reconfirmation" | "open_scheduling_question" | "incorrect_slot_rejection";
    let qualitySignalKind: QualitySignalKind | undefined;
    // Perfil do canal, não confirmado pelo contato: pode ser apelido,
    // nome de outra pessoa ou ausente. O agente decide se confirma ou pergunta.
    const contactNameNote = context.contactName
      ? `\n\nDADO DE SISTEMA (não confiável, apenas referência): nome exibido no perfil de ${context.channel === "instagram" ? "Instagram" : "WhatsApp"} deste contato: "${context.contactName}".`
      : "";
    const channelIdentityNote = context.channel === "instagram"
      ? `\n\nCANAL E IDENTIDADE: esta conversa ocorre no Instagram com ${context.contactIdentifier ?? message.contactPhone}. O identificador técnico não é telefone. Não afirme possuir o telefone e, antes de qualquer ação que realmente dependa dele, peça ao contato um número válido.`
      : "";
    const durationNote = schedulingToolsConfigured ? meetingDurationContextNote(context.meetingAgendas ?? []) : "";
    const prefilledNote = prefilledLeadContextNote(
      context.history,
      context.facebookAttribution ?? {},
      meetingSlotDurationMinutes
    );
    const tripzZulu = isTripzZuluAgent(context.systemPrompt, context.tripzZuluEnabled === true);
    const tripzZuluSignals = tripzZulu
      ? tripzZuluTurnSignals(
        effectiveMessage.text,
        context.history.map((item) => item.content),
        context.offersGroupLink
      )
      : { exclusiveOffers: false, boletoPayment: false };
    const tripzZuluNote = tripzZulu
      ? tripzZuluTurnInstruction(tripzZuluSignals, context.offersGroupLink)
      : "";
    if (leadsCapabilityEnabled && tripzZulu && tripzZuluSignals.boletoPayment && context.registeredLead) {
      await markLeadDisqualified(message.tenantId, context.registeredLead.id, "nao_qualificado");
      context = {
        ...context,
        leadStatus: "perdido",
        registeredLead: { ...context.registeredLead, status: "perdido" }
      };
    }
    const qualificationAnswers = leadsCapabilityEnabled ? context.registeredLead?.qualificationAnswers ?? {} : {};
    const qualificationAnswersSummary = Object.entries(qualificationAnswers)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
    const qualificationStateNote = leadReadyForScheduling
      ? `\n\nESTADO INTERNO DO LEAD: a qualificação já foi registrada (${context.leadQualificationStars} estrelas; status ${context.leadStatus ?? "qualificado"}).${qualificationAnswersSummary ? ` Dados já coletados nesta qualificação, use-os e não pergunte de novo: ${qualificationAnswersSummary}.` : ""} Não chame qualificar_lead novamente.${schedulingToolsConfigured ? " Em mensagens de escolha ou confirmação de horário, não repita cadastro nem qualificação: prossiga diretamente com as ferramentas de agenda necessárias para concluir a ação." : ""}`
      : "";
    const appointmentStateNote = appointmentsCapabilityEnabled && context.activeAppointment
      ? `\n\nESTADO INTERNO DA AGENDA: já existe um agendamento ativo (${context.activeAppointment.status}) com início em ${context.activeAppointment.start}, na agenda ${context.activeAppointment.unitId}${context.activeAppointment.meetLink ? `, com link ${context.activeAppointment.meetLink}` : ""}. Não tente criar outro agendamento. Conforme o pedido do contato, confirme o compromisso existente ou use apenas reagendamento/cancelamento.`
      : "";
    const qualificationResponsivenessNote = enabledToolNames.includes("qualificar_lead")
      ? "\n\nQUALIFICAÇÃO SILENCIOSA: qualificar_lead é uma ferramenta interna e não gera nenhuma mensagem para o contato por conta própria. Qualquer texto que acompanhar essa chamada é descartado. Chame qualificar_lead e, no mesmo turno, continue normalmente até escrever a resposta final ao contato depois do resultado da ferramenta; não anuncie a classificação nem trate a chamada como se já tivesse respondido."
      : "";
    const confirmedSchedulingNote = confirmedSchedulingTurn
      ? `\n\nCONFIRMAÇÃO JÁ RECEBIDA: a mensagem curta atual confirma de forma inequívoca o horário ${confirmedSchedulingTime} perguntado na mensagem anterior. Não peça confirmação outra vez. Consulte o que for necessário e efetive o agendamento agora; só anuncie a conclusão após o sucesso da ferramenta.`
      : "";
    const specificSchedulingNote = specificSchedulingIntent
      ? specificSchedulingIntent.kind === "direct_schedule"
        ? hasActiveAppointment
          ? `\n\nINTENÇÃO CONFIRMADA DE AGENDA: o contato pediu para mudar o compromisso ativo para ${specificSchedulingIntent.time}. Não peça confirmação e não use outro horário. Consulte verificar_horarios_reuniao com horario_solicitado="${specificSchedulingIntent.time}" e, se estiver livre, chame reagendar_reuniao imediatamente. Se estiver indisponível, mantenha o compromisso atual e ofereça somente os dois ou três horarios_proximos retornados.`
          : `\n\nINTENÇÃO CONFIRMADA DE AGENDA: o contato autorizou diretamente o agendamento às ${specificSchedulingIntent.time}. Não peça confirmação e não volte à grade completa. Resolva a agenda, consulte verificar_horarios_reuniao com horario_solicitado="${specificSchedulingIntent.time}" e, se estiver livre, chame agendar_reuniao imediatamente. Se estiver indisponível, informe isso naturalmente e ofereça somente os dois ou três horarios_proximos retornados.`
        : `\n\nCONSULTA EXATA DE AGENDA: o contato apenas perguntou se ${specificSchedulingIntent.time} está livre. Não volte à grade completa. Resolva a agenda e consulte verificar_horarios_reuniao com horario_solicitado="${specificSchedulingIntent.time}". Se estiver livre, peça uma única confirmação antes de agendar. Se não estiver, ofereça somente os dois ou três horarios_proximos retornados.`
      : "";
    const schedulingPeriodNote = schedulingPeriodPreference
      ? `\n\nPERÍODO DE AGENDA CONFIRMADO: o contato prefere ${schedulingPeriodPreference === "morning" ? "a manhã" : "a tarde"}. Não envie uma mensagem intermediária nem diga que consultará a agenda depois. Chame verificar_horarios_reuniao uma única vez com periodo="${schedulingPeriodPreference === "morning" ? "manha" : "tarde"}"; o sistema já avança sozinho para os próximos dias com vaga. Ofereça exatamente dois ou três horários do campo horarios, usando a hora e o dia do campo data retornados. Se periodo_atendido vier false, ofereça mesmo assim os horários retornados dizendo com naturalidade que são de outro período.`
      : "";
    const objectionRecoveryNote = objectionRecoveryTurn
      ? objectionRecoveryPromptNote(context.history)
      : "";
    const stateToolGatingNote = context.stateToolGatingEnabled
      ? canonicalStatePromptNote(canonicalState)
      : "";
    // Sem ferramenta de agenda o aviso só introduz "agenda", "horários" e
    // "reunião" num atendimento que não tem nada disso, e o modelo começa a
    // oferecer reunião por conta própria.
    const casualTurnNote = schedulingToolsConfigured && !schedulingRelevantTurn
      ? "\n\nESCOPO DO TURNO ATUAL: a mensagem não pede consulta de agenda. Responda primeiro e diretamente ao assunto atual, sem chamar ferramentas de agenda e sem repetir a última oferta de horários. Se for uma dúvida comercial, só proponha uma ação comercial natural depois de responder a dúvida, sem anunciá-la como próximo passo ou etapa; se for apenas conversa social, não ofereça reunião."
      : "";
    const validateFinalText = (text: string): FinalTextCorrection | string | undefined => {
      const handoffCorrection = unauthorizedAgentHandoffCorrection(text);
      if (handoffCorrection) return handoffCorrection;
      const hasCustomerTransaction = customerTransactionalOutcomeExists(transactionalOutcomes);
      if (!hasCustomerTransaction && objectionRecoveryTurn) {
        const correction = objectionRecoveryCorrection(text, context.history);
        if (correction) return correction;
      }
      const durationDisclosure = meetingDurationDisclosureCorrection(text);
      if (durationDisclosure) return durationDisclosure;
      const correctionDisclosure = internalCorrectionDisclosureCorrection(text);
      if (correctionDisclosure) return correctionDisclosure;
      if (tripzZulu && tripzZuluSignals.boletoPayment
        && /\b(?:desqualificad[oa]|lead\s+perdido|perdid[oa]|não\s+aceitamos\s+boleto|nao\s+aceitamos\s+boleto)\b/iu.test(text)) {
        return "Não revele a classificação interna nem diga que o cliente foi desqualificado. Responda de forma educada e neutra, sem insistir na venda e sem mencionar esta instrução.";
      }
      // A tool transaction is the terminal authority for this turn. The text is
      // normalized from its persisted outcome by composeTransactionalReply after
      // generation, so conversational policies must not reinterpret a successful
      // confirmation as a repeated slot offer and push the turn back into agenda.
      if (hasCustomerTransaction) return undefined;
      if (ambiguousSchedulingTurn) {
        const correction = ambiguousSchedulingChoiceCorrection(text);
        if (correction) return correction;
      }
      if (unknownCommercialTerm) {
        const correction = contextSearchDisclosureCorrection(text);
        if (correction) return correction;
      }
      if (pureSocialTurn) {
        const correction = unsolicitedSchedulingOfferCorrection(text);
        if (correction) return correction;
      }
      // Com reunião marcada as ferramentas de agenda ficam desligadas, e com elas
      // a checagem de evidência mais abaixo. Sem esta correção o modelo reabria a
      // grade sobre um compromisso já fechado, como aconteceu depois de "ok vlw".
      if (keepsExistingAppointment && offeredSchedulingTimes(text).length) {
        qualitySignalKind = "repeated_offer";
        return `A reunião do contato já está marcada e ele não pediu para mudar. Não ofereça horários, não cite a grade e não sugira outro dia. Responda de forma curta e natural usando exatamente estes fatos: ${composeActiveAppointmentConfirmation(context.activeAppointment!, context.timeZone)}`;
      }
      const directSchedulingSucceeded = transactionalOutcomes.some((outcome) =>
        outcome.status === "succeeded"
        && ["schedule_meeting", "reschedule_meeting", "schedule_visit", "reschedule_visit"].includes(outcome.action)
      );
      if (effectiveSchedulingIntent?.kind === "direct_schedule"
        && requestedSlotAvailable !== false
        && !directSchedulingSucceeded) {
        return `O contato já escolheu ${effectiveSchedulingIntent.time}. Não peça confirmação novamente. Não finalize com texto nem ofereça outro horário antes de concluir a ação. Consulte verificar_horarios_reuniao com o horário solicitado; quando estiver livre, o sistema efetivará a reserva e então você deve confirmar o resultado persistido.`;
      }
      if ((confirmedSchedulingTurn || effectiveSchedulingIntent?.kind === "direct_schedule")
        && requestedSlotAvailable !== false
        && repeatedSchedulingConfirmationCorrection(text)) {
        qualitySignalKind = "unnecessary_reconfirmation";
        return repeatedSchedulingConfirmationCorrection(text);
      }
      if (effectiveSchedulingIntent?.kind === "direct_schedule" && requestedSlotAvailable === true
        && SLOT_REJECTION.test(text)) {
        qualitySignalKind = "incorrect_slot_rejection";
        return `A agenda confirmou que ${effectiveSchedulingIntent.time} está livre. Não rejeite esse encaixe nem ofereça outra grade. Efetive o agendamento sem pedir nova confirmação e só então comunique o sucesso.`;
      }
      if (schedulingPeriodPreference && !latestMeetingAvailability) {
        return `O contato já informou que prefere ${schedulingPeriodPreference === "morning" ? "a manhã" : "a tarde"}. Não diga que vai consultar a agenda nem envie uma resposta intermediária. Consulte consultar_agendas e verificar_horarios_reuniao agora; só então ofereça dois ou três horários reais do período escolhido.`;
      }
      const deferredAvailability = deferredAvailabilityPromiseCorrection(text, latestMeetingAvailability);
      if (deferredAvailability) {
        qualitySignalKind = "open_scheduling_question";
        return deferredAvailability;
      }
      const schedulingCorrection = canVerifyMeetingAvailability ? schedulingAvailabilityPolicyCorrection(text) : undefined;
      if (schedulingCorrection) {
        qualitySignalKind = "open_scheduling_question";
        return schedulingCorrection;
      }
      const offeredTimes = offeredSchedulingTimes(text);
      // Só exige o período preferido enquanto a agenda não provou que ele não
      // existe. Sem isso o turno entra em impasse: os únicos horários reais são
      // de outro período, a correção rejeita qualquer oferta e o modelo acaba
      // respondendo que "não tem horários confirmados".
      if (schedulingPeriodPreference && latestMeetingAvailability?.periodSatisfied !== false) {
        const correction = schedulingPeriodOfferCorrection(text, schedulingPeriodPreference);
        if (correction) {
          qualitySignalKind = "open_scheduling_question";
          return correction;
        }
      }
      if (offeredTimes.length && canVerifyMeetingAvailability) {
        const correction = schedulingOfferEvidenceCorrection(text, latestMeetingAvailability, {
          now: new Date(),
          minimumLeadTimeMinutes: this.schedulingMinimumLeadMinutes,
          fallbackTimeZone: context.timeZone
        });
        if (correction) {
          qualitySignalKind = "open_scheduling_question";
          return correction;
        }
      }
      // When the requested slot became unavailable, repeating the still-valid
      // alternatives is progress, not spam. The old repetition rule made the
      // only truthful reply impossible after a contact insisted on the occupied
      // time, causing policy retries until the provider ceiling was exhausted.
      const verifiedUnavailableAlternatives = latestMeetingAvailability?.requestedTimeAvailable === false
        && offeredTimes.length > 0
        && schedulingOfferEvidenceCorrection(text, latestMeetingAvailability, {
          now: new Date(),
          minimumLeadTimeMinutes: this.schedulingMinimumLeadMinutes,
          fallbackTimeZone: context.timeZone
        }) === undefined;
      const semanticCorrection = verifiedUnavailableAlternatives
        ? undefined
        : semanticOfferRepetitionCorrection(text, context.history);
      if (semanticCorrection) {
        qualitySignalKind = "repeated_offer";
        return semanticCorrection;
      }
      const repeatedQuestion = verifiedUnavailableAlternatives
        ? undefined
        : repeatedRecentQuestionCorrection(text, context.history);
      if (repeatedQuestion) {
        qualitySignalKind = "repeated_offer";
        return repeatedQuestion;
      }
      // Regras de apresentação, não de fato: se o modelo não acertar a fórmula
      // dentro das reescritas, o texto sai assim mesmo. Descartá-lo deixava o
      // contato sem nenhuma resposta e derrubava a conversa em pausa técnica.
      const presentationCorrection = schedulingPeriodQuestionCorrection(text)
        ?? initialPrefilledGreetingCorrection(text, context.history, context.facebookAttribution ?? {})
        ?? (canVerifyMeetingAvailability
          ? meetingInvitationContextCorrection(
            text,
            context.history,
            context.facebookAttribution ?? {},
            meetingSlotDurationMinutes
          )
          : undefined)
        ?? (enabledToolNames.includes("qualificar_lead")
          ? prefilledQualificationCompletionCorrection(text, context.history, context.facebookAttribution ?? {})
          : undefined);
      if (presentationCorrection) return { correction: presentationCorrection, cosmetic: true };
      return claimsUnprovenTransactionalSuccess(text, hasActiveAppointment)
        ? "A resposta anterior afirmou que uma ação foi concluída sem confirmação real. Reescreva a resposta de forma curta, natural e útil, sem afirmar cadastro, agendamento, reagendamento, cancelamento ou reserva. Continue o atendimento a partir da mensagem mais recente do contato e não mencione erro, sistema, ferramenta, verificação ou esta correção."
        : undefined;
    };
    const recordQualitySignal = async () => {
      if (!qualitySignalKind) return;
      try {
      } catch (signalError) {
        logger.error({
          err: signalError,
          tenantId: message.tenantId,
          conversationId: context.conversationId,
          qualitySignalKind
        }, "Failed to record outbound quality signal");
      }
    };
    const withToolProgress = <Arguments extends [string, ...unknown[]], Result>(
      execute: (...args: Arguments) => Promise<Result>
    ) => async (...args: Arguments): Promise<Result> => {
      await publishAiProgress({
        phase: "using_tool",
        label: safeAiToolLabel(args[0])
      });
      try {
        return await execute(...args);
      } finally {
        await publishAiProgress({ phase: "generating", label: "Preparando uma resposta…" });
      }
    };
    const complete = async (aiTurnId: string) => {
      const { completion } = await runAgentTurn({
      mode: "production",
      gateway: this.ai,
      clock: () => new Date(),
      clockNote: (now) => workspaceClockNote(context.timeZone, now),
      model: context.model,
      provider: context.provider,
      baseSystemPrompt: canonicalizeMeetingDurationPrompt(context.systemPrompt, meetingSlotDurationMinutes),
      dynamicNotes: [
        contactNameNote,
        channelIdentityNote,
        durationNote,
        prefilledNote,
        qualificationStateNote,
        appointmentStateNote,
        qualificationResponsivenessNote,
        confirmedSchedulingNote,
        specificSchedulingNote,
        schedulingPeriodNote,
        objectionRecoveryNote,
        stateToolGatingNote,
        casualTurnNote,
        stickerCatalogPrompt(stickerCatalog),
        tripzZuluNote
      ],
      temperature: context.temperature,
      maxTokens: context.maxTokens,
      reasoningEffort: context.reasoningEffort ?? "medium",
      apiKey: context.openRouterApiKey,
      history: context.history,
      enabledToolNames,
      canonicalState,
      stateToolGatingEnabled: context.stateToolGatingEnabled,
      ambiguousSchedulingTurn,
      executeTool: withToolProgress(createSchedulingToolExecutor(message.tenantId, message.contactPhone, pesquisarModelo, {
        conversationId: context.conversationId,
        inboundExternalId: message.externalId,
        aiTurnId,
        journal: (input, execute) => this.repository.executeToolCallOnceDetailed(input, execute),
        enabledToolNames,
        capabilityEnabled: (name) => {
          const capability = capabilityForAiTool(name);
          return capability
            ? capabilityEnabled(capability)
            : Promise.resolve(true);
        },
        canonicalState: context.stateToolGatingEnabled ? canonicalState : undefined,
        schedulingIntent: effectiveSchedulingIntent,
        // O classificador determinístico, e não o argumento criado pelo
        // modelo, é a autoridade para restringir a busca a manhã ou tarde.
        // Undefined aqui significa que o contato não escolheu período.
        schedulingPeriodPreferenceResolved: true,
        ...(schedulingPeriodPreference
          ? { schedulingPeriodPreference: schedulingPeriodPreference === "morning" ? "manha" as const : "tarde" as const }
          : {}),
        directSchedulingAction: effectiveSchedulingIntent?.kind === "direct_schedule"
          ? hasActiveAppointment ? "reagendar_reuniao" : "agendar_reuniao"
          : undefined,
        facebookAttribution: context.facebookAttribution ?? {},
        existingLead: context.registeredLead,
        tripzBoletoPaymentSignal: tripzZulu && tripzZuluSignals.boletoPayment,
        searchBusinessContext: pesquisarContexto,
        onTransactionalOutcome: (outcome) => {
          const previous = transactionalOutcomes.findIndex((item) => item.journalId === outcome.journalId);
          if (previous >= 0) transactionalOutcomes[previous] = outcome;
          else transactionalOutcomes.push(outcome);
        },
        onMeetingAvailabilityChecked: (availability) => {
          if (availability.durationMinutes) {
            meetingSlotDurationMinutes = availability.durationMinutes;
          }
          if (!effectiveSchedulingIntent || availability.requestedTime === effectiveSchedulingIntent.time) {
            requestedSlotAvailable = availability.available;
          }
          latestMeetingAvailability = {
            agendaId: availability.agendaId,
            date: availability.date,
            timezone: availability.timezone ?? context.timeZone,
            slots: availability.slots,
            ...(availability.requestedTime ? { requestedTime: availability.requestedTime } : {}),
            ...(availability.available === undefined ? {} : { requestedTimeAvailable: availability.available }),
            ...(availability.periodSatisfied === undefined ? {} : { periodSatisfied: availability.periodSatisfied })
          };
        },
        minimumLeadTimeMinutes: this.schedulingMinimumLeadMinutes,
      })),
      toolChoice: canSearchModels && textMentionsSpecificProductModel(effectiveMessage.text)
        ? MODEL_SEARCH_TOOL_CHOICE
        : unknownCommercialTerm
          ? CONTEXT_SEARCH_TOOL_CHOICE
          : tripzZulu && tripzZuluSignals.boletoPayment && context.registeredLead
            && enabledToolNames.includes("atualizar_status_lead")
            ? { type: "function" as const, function: { name: "atualizar_status_lead" } }
          : tripzZulu && tripzZuluSignals.boletoPayment && !context.registeredLead
            && enabledToolNames.includes("registrar_lead")
            ? REGISTER_LEAD_TOOL_CHOICE
          : forceLeadRegistration
            ? REGISTER_LEAD_TOOL_CHOICE
        : schedulingProgressToolName
          ? { type: "function" as const, function: { name: schedulingProgressToolName } }
          : undefined,
      validateFinalText,
      onUsage: recordUsage,
      trace: aiTrace("inbound_reply")
      });
      const stickerSelection = extractStickerDirective(completion.text, allowedStickerIds);
      selectedStickerId = stickerSelection.stickerId;
      return { ...completion, text: stickerSelection.text };
    };
    const revalidateOfferedMeetingSlots = async (text: string): Promise<string> => {
      const explicitlyUnavailableRequestedTime = explicitlyRejectsRequestedTime(text, latestMeetingAvailability);
      const offeredTimes = offeredSchedulingTimes(text).filter((time) =>
        !(explicitlyUnavailableRequestedTime && time === latestMeetingAvailability?.requestedTime)
      );
      if (!offeredTimes.length) return text;
      if (!latestMeetingAvailability) {
        throw new NonRetryableAiError(
          "unverified_slot_offer",
          "The final response contains meeting slots without current-turn availability evidence"
        );
      }
      const offeredStarts = offeredTimes.flatMap((time) => latestMeetingAvailability?.slots
        .filter((slot) => slotLocalTime(slot.start, latestMeetingAvailability?.timezone ?? context.timeZone) === time)
        .map((slot) => slot.start) ?? []);
      const revalidated = await Promise.all(offeredStarts.map(async (start) => {
        const requestedTime = slotLocalTime(start, latestMeetingAvailability?.timezone ?? context.timeZone);
        if (!requestedTime) return false;
        const refreshed = await verificarHorarios(
          message.tenantId,
          latestMeetingAvailability!.agendaId,
          latestMeetingAvailability!.date,
          {
            requestedTime,
            excludeStartedSlots: true,
            now: new Date(),
            minimumLeadTimeMinutes: this.schedulingMinimumLeadMinutes,
            excludeLeadId: context.registeredLead?.id,
            capacitySource: "available_attendants"
          }
        );
        return refreshed.horarios.some((slot) => slot.start === start);
      }));
      if (offeredStarts.length === offeredTimes.length
        && revalidated.every((available) => available)) return text;

      // Availability races are expected operational events, not technical AI
      // failures. Refresh from the same attendant-pool capacity source used by
      // verificar_horarios_reuniao and replace the stale offer with current,
      // deterministic evidence instead of pausing the whole conversation.
      const previousEvidence = latestMeetingAvailability;
      const refreshed = await buscarDisponibilidade(
        message.tenantId,
        previousEvidence.agendaId,
        previousEvidence.date,
        {
          ...(schedulingPeriodPreference
            ? { periodo: schedulingPeriodPreference === "morning" ? "manha" as const : "tarde" as const }
            : {}),
          now: new Date(),
          minimumLeadTimeMinutes: this.schedulingMinimumLeadMinutes
        }
      );
      const requestedTimeAvailable = Boolean(
        previousEvidence.requestedTime
        && refreshed.data === previousEvidence.date
        && refreshed.horarios.some((slot) =>
          slotLocalTime(slot.start, refreshed.timezone) === previousEvidence.requestedTime
        )
      );
      latestMeetingAvailability = {
        agendaId: refreshed.agenda_id,
        date: refreshed.data,
        timezone: refreshed.timezone,
        slots: refreshed.horarios.map((slot) => ({ start: slot.start, end: slot.end })),
        ...(previousEvidence.requestedTime
          ? { requestedTime: previousEvidence.requestedTime, requestedTimeAvailable }
          : {}),
        periodSatisfied: refreshed.periodo_atendido
      };
      if (previousEvidence.requestedTime) requestedSlotAvailable = requestedTimeAvailable;
      const replacement = composeMeetingAvailabilityFallback(latestMeetingAvailability);
      if (!replacement) {
        throw new NonRetryableAiError(
          "availability_changed_before_send",
          "A meeting slot became invalid and no safe current availability reply could be composed"
        );
      }
      logger.warn({
        event: "ai_slot_offer_refreshed",
        conversationId: context.conversationId,
        messageId: context.messageId,
        requestId,
        offeredTimes,
        replacementTimes: offeredSchedulingTimes(replacement),
        agendaId: refreshed.agenda_id,
        date: refreshed.data
      }, "Meeting availability changed before delivery; refreshed the offer without handoff");
      return replacement;
    };
    const deliverCompactAiRecovery = async (): Promise<boolean> => {
      if (customerTransactionalOutcomeExists(transactionalOutcomes)) {
        // Never fall back to the availability snapshot after a mutating agenda
        // tool has already produced a durable outcome. This branch is deliberately
        // tool- and model-free: even a policy/provider failure cannot reopen the
        // scheduling question or omit the persisted Meet link.
        const composed = composeTransactionalReply("", transactionalOutcomes, hasActiveAppointment);
        const text = composed.text.trim();
        if (!text) return false;
        await publishPreview([text]);
        const createdAt = new Date();
        const sent = await withCustomerComposing(async () => {
          await sleep(previewDelay(text));
          await publishSending();
          return this.gateway.sendText(message.sessionId, destination, text);
        });
        await this.repository.recordAgentReply({
          tenantId: message.tenantId,
          sessionId: message.sessionId,
          conversationId: context.conversationId,
          agentConfigVersionId: context.agentConfigVersionId,
          text,
          model: context.model,
          externalId: sent.externalId,
          createdAt,
          bubbles: [{ text, externalId: sent.externalId, createdAt }],
          inboundExternalId: message.externalId,
          inboundExternalIds: [...processingExternalIds],
          transactionClaims: composed.claims
        });
        return true;
      }
      const deterministicAvailability = schedulingRelevantTurn
        ? composeMeetingAvailabilityFallback(latestMeetingAvailability)
        : undefined;
      if (deterministicAvailability) {
        // Availability is structured, current-turn evidence. Prefer a bounded
        // deterministic reply over spending more provider calls after the model
        // has already failed to express that same evidence safely.
        let safeAvailability = aiProgress
          ? await revalidateOfferedMeetingSlots(deterministicAvailability)
          : deterministicAvailability;
        await publishPreview([safeAvailability]);
        const createdAt = new Date();
        const sent = await withCustomerComposing(async () => {
          await sleep(previewDelay(safeAvailability));
          for (let availabilityRevision = 0; availabilityRevision < 4; availabilityRevision += 1) {
            const revalidatedAvailability = await revalidateOfferedMeetingSlots(safeAvailability);
            if (revalidatedAvailability === safeAvailability) break;
            safeAvailability = revalidatedAvailability;
            await publishPreview([safeAvailability]);
            if (aiProgress) await sleep(1_500);
          }
          await publishSending();
          return this.gateway.sendText(message.sessionId, destination, safeAvailability);
        });
        await this.repository.recordAgentReply({
          tenantId: message.tenantId,
          sessionId: message.sessionId,
          conversationId: context.conversationId,
          agentConfigVersionId: context.agentConfigVersionId,
          text: safeAvailability,
          model: context.model,
          externalId: sent.externalId,
          createdAt,
          bubbles: [{ text: safeAvailability, externalId: sent.externalId, createdAt }],
          inboundExternalId: message.externalId,
          inboundExternalIds: [...processingExternalIds],
          transactionClaims: []
        });
        return true;
      }
      const compactHistory: ConversationContext["history"] = [];
      let remainingCharacters = 6_000;
      for (const item of [...context.history].reverse()) {
        if (remainingCharacters <= 0) break;
        const content = item.content.length <= remainingCharacters
          ? item.content
          : item.content.slice(-remainingCharacters);
        compactHistory.unshift({ role: item.role, content });
        remainingCharacters -= content.length;
      }
      const persistedOutcomeContext = customerTransactionalOutcomeExists(transactionalOutcomes)
        ? `RESULTADOS PERSISTIDOS DESTE TURNO (fonte factual obrigatória):\n${JSON.stringify(transactionalOutcomes)}`
        : "";
      const availabilityContext = latestMeetingAvailability?.slots.length
        ? `DISPONIBILIDADE COMPROVADA NESTE TURNO (use somente estes dados):\n${JSON.stringify(latestMeetingAvailability)}`
        : "";
      const compactSystemPrompt = [
        "Você é o atendente de WhatsApp configurado abaixo. Gere uma nova resposta original, natural e útil para a mensagem mais recente do contato.",
        "Responda em português brasileiro, em até 90 palavras. Não use ferramentas, não mencione erro, recuperação, sistema, automação, limite ou transferência.",
        "Não invente ações concluídas. Se o contato enviou um formulário, aproveite os dados já fornecidos e avance o atendimento sem repetir perguntas.",
        "Sem disponibilidade comprovada abaixo, não apresente horas como slots livres nem ofereça opções de agendamento. Uma faixa de contato informada pelo cliente pode ser apenas reconhecida como faixa, sem transformá-la em oferta da agenda.",
        persistedOutcomeContext,
        availabilityContext,
        hasRegisteredLead ? "O cadastro interno desse contato já existe; responda ao cliente sem anunciar o cadastro." : "",
        "CONFIGURAÇÃO RESUMIDA DO AGENTE:",
        context.systemPrompt
      ].filter(Boolean).join("\n\n");
      const completion = await this.ai.complete({
        model: context.model,
        provider: context.provider,
        systemPrompt: compactSystemPrompt,
        temperature: context.temperature,
        maxTokens: Math.min(context.maxTokens, 512),
        reasoningEffort: context.reasoningEffort ?? "low",
        apiKey: context.openRouterApiKey,
        history: compactHistory,
        onUsage: recordUsage,
        trace: aiTrace("inbound_reply_compact_recovery"),
        validateFinalText: (text) => {
          const candidate = parseAgentHandoff(sanitizeOutbound(text, ""));
          if (candidate.handoff || !candidate.text) {
            return "Responda diretamente ao contato, sem transferência, marcador interno ou explicação de falha.";
          }
          return validateFinalText(candidate.text);
        }
      });
      const parsed = parseAgentHandoff(
        sanitizeOutbound(stripRecentUserEchoes(completion.text, context.history), "")
      );
      if (parsed.handoff || !parsed.text.trim()) {
        throw new NonRetryableAiError(
          "compact_recovery_invalid_response",
          "The compact AI recovery did not produce customer-visible text"
        );
      }
      const composed = composeTransactionalReply(parsed.text, transactionalOutcomes, hasActiveAppointment);
      const text = await revalidateOfferedMeetingSlots(composed.text.trim());
      if (!text) return false;
      await publishPreview([text]);
      const createdAt = new Date();
      const sent = await withCustomerComposing(async () => {
        await sleep(previewDelay(text));
        await publishSending();
        return this.gateway.sendText(message.sessionId, destination, text);
      });
      await this.repository.recordAgentReply({
        tenantId: message.tenantId,
        sessionId: message.sessionId,
        conversationId: context.conversationId,
        agentConfigVersionId: context.agentConfigVersionId,
        text,
        model: context.model,
        externalId: sent.externalId,
        createdAt,
        bubbles: [{ text, externalId: sent.externalId, createdAt }],
        inboundExternalId: message.externalId,
        inboundExternalIds: [...processingExternalIds],
        transactionClaims: composed.claims
      });
      return true;
    };
    const sendReply = async () => {
      const internalOnlyFallback = "Tô por aqui! Me conta o que você tá procurando e eu te ajudo a encontrar a melhor opção.";
      let completion: Awaited<ReturnType<typeof complete>>;
      let parsed: ReturnType<typeof parseAgentHandoff>;
      let replyText = "";
      let bubbles: string[] = [];
      let replyClaims: TransactionalClaim[] = [];
      const bubblesSentThisTurn: string[] = [];
      let generation = 0;
      while (true) {
        completion = await complete(generationTurnId(requestId, generation++));
        await recordQualitySignal();
        if (completion.toolLimitReached) {
          await this.repository.createSystemAlertOnce(
            message.tenantId,
            "A IA atingiu o limite de ferramentas em um atendimento. Revise a conversa para confirmar se a ação solicitada foi concluída."
          );
          try {
          } catch (signalError) {
            logger.error({
              err: signalError,
              tenantId: message.tenantId,
              conversationId: context.conversationId,
              agentConfigVersionId: context.agentConfigVersionId
            }, "Failed to record tool-limit evaluation signal");
          }
        }
        parsed = parseAgentHandoff(sanitizeOutbound(stripRecentUserEchoes(completion.text, context.history), internalOnlyFallback));
        // The explicit-request guard runs before model generation. A marker at
        // this point is therefore an unauthorized model decision, never a state
        // transition. Route it through the bounded compact recovery instead of
        // abandoning the conversation.
        if (parsed.handoff && !customerTransactionalOutcomeExists(transactionalOutcomes)) {
          throw new NonRetryableAiError(
            "unauthorized_handoff",
            "The model attempted human handoff without an explicit contact request"
          );
        }
        const composed = composeTransactionalReply(parsed.text, transactionalOutcomes, hasActiveAppointment);
        replyClaims = composed.claims;
        parsed = { handoff: false, text: composed.text || internalOnlyFallback };
        if (tripzZulu && tripzZuluSignals.exclusiveOffers) {
          parsed = {
            handoff: false,
            text: appendTripzOffersInvitation(parsed.text, context.offersGroupLink)
          };
        }
        replyText = parsed.text;
        // Claims are anchored to the persisted provider message. Keep the complete
        // deterministic transaction confirmation (including its exact Meet URL)
        // in one atomic bubble so every claimed fact belongs to that message.
        // Qualification claims carry no textual fact, so the continuation can
        // still be split into humanized bubbles.
        bubbles = customerTransactionalOutcomeExists(transactionalOutcomes)
          ? [replyText]
          : config
            ? splitResponse(replyText, config.messageSplit.maxWordsPerBubble)
            : [replyText];
        // Regenerated replies (after an inbound interrupted the bubble sequence)
        // restate what was already sent; only forward the genuinely new bubbles.
        bubbles = deduplicateReplyBubbles(bubbles, bubblesSentThisTurn);
        if (!bubbles.length) {
          logger.info({
            externalId: message.externalId,
            conversationId: context.conversationId,
            processingExternalIds
          }, "Regenerated reply only repeated already-sent bubbles; nothing new to send");
          return {
            completion,
            parsed,
            sent: undefined,
            sentAt: undefined,
            sentBubbles: undefined,
            replyInboundExternalIds: [...processingExternalIds],
            transactionClaims: replyClaims
          };
        }

        // The preview is made public only after every customer-facing
        // transformation and the first availability pre-check. If that check
        // replaces a stale offer, later model bubbles were generated against
        // obsolete evidence and are intentionally discarded.
        if (aiProgress) {
          const previewBubbles: string[] = [];
          let previewChanged = false;
          for (const bubble of bubbles) {
            const safeBubble = await revalidateOfferedMeetingSlots(bubble);
            previewBubbles.push(safeBubble);
            if (safeBubble !== bubble) {
              previewChanged = true;
              break;
            }
          }
          bubbles = previewBubbles;
          if (previewChanged) parsed = { ...parsed, text: bubbles.join("\n\n") };
        }
        await publishPreview(bubbles);

        // Only expose "composing" once a final customer-visible reply exists.
        // Model generation and every internal tool iteration remain silent.
        const sendAttempt = await withCustomerComposing(async () => {
          // The model may finish before the simulated typing delay. Recheck after
          // that delay so a message received while "composing" is included before
          // any stale reply reaches WhatsApp.
          await sleep(previewDelay(bubbles[0]));
          if (await absorbMessagesReceivedWhileComposing()) {
            await publishAiProgress({
              phase: "generating",
              label: "Analisando novas mensagens…"
            });
            logger.info({
              externalId: message.externalId,
              conversationId: context.conversationId,
              processingExternalIds
            }, "Regenerating AI reply with messages received while composing");
            return { restartReply: true as const };
          }

          const replyInboundExternalIds = [...processingExternalIds];
          if (config && this.gateway.sendReaction && config.reaction.probability > 0) {
            const emoji = selectContextualReaction(effectiveMessage.text, config.reaction.emojis);
            if (emoji) await this.gateway.sendReaction(message.sessionId, destination, receipts[0], emoji);
          }
          // Each WhatsApp bubble keeps its own provider ID so delivery receipts and
          // the panel history mirror what the contact actually received.
          let sent: { externalId: string } | undefined;
          let sentAt: Date | undefined;
          const sentBubbles: Array<{ text: string; externalId: string; createdAt: Date }> = [];
          for (const [index, bubble] of bubbles.entries()) {
            if (index > 0 && config) {
              await refreshComposing();
              await sleep(humanizedDelay(randomBetween(config.messageSplit.pauseBetweenBubblesMs), config) + composingDuration(bubble, config));
              if (await absorbMessagesReceivedWhileComposing()) {
                if (sent && sentAt && sentBubbles.length) {
                  await this.repository.recordAgentReply({
                    tenantId: message.tenantId,
                    sessionId: message.sessionId,
                    conversationId: context.conversationId,
                    agentConfigVersionId: context.agentConfigVersionId,
                    text: sentBubbles.map((item) => item.text).join("\n\n"),
                    model: context.model,
                    externalId: sent.externalId,
                    createdAt: sentAt,
                    bubbles: sentBubbles,
                    inboundExternalId: message.externalId,
                    inboundExternalIds: replyInboundExternalIds,
                    transactionClaims: replyClaims
                  });
                  await refreshContextSnapshot();
                }
                logger.info({
                  externalId: message.externalId,
                  conversationId: context.conversationId,
                  processingExternalIds,
                  replyBubblesSent: sentBubbles.length
                }, "Restarting AI reply after inbound interrupted bubble sequence");
                await publishAiProgress({
                  phase: "generating",
                  label: "Analisando novas mensagens…"
                });
                return { restartReply: true as const };
              }
            }
            let safeBubble = bubble;
            for (let availabilityRevision = 0; availabilityRevision < 4; availabilityRevision += 1) {
              const revalidatedBubble = await revalidateOfferedMeetingSlots(safeBubble);
              if (revalidatedBubble === safeBubble) break;
              safeBubble = revalidatedBubble;
              bubbles = [safeBubble];
              parsed = { ...parsed, text: safeBubble };
              await publishPreview([safeBubble]);
              if (aiProgress) await sleep(1_500);
              if (await absorbMessagesReceivedWhileComposing()) {
                await publishAiProgress({
                  phase: "generating",
                  label: "Analisando novas mensagens…"
                });
                return { restartReply: true as const };
              }
            }
            if (!sent) await publishSending();
            const bubbleSentAt = new Date();
            const bubbleSent = await this.gateway.sendText(message.sessionId, destination, safeBubble);
            sent ??= bubbleSent;
            sentAt ??= bubbleSentAt;
            sentBubbles.push({ text: safeBubble, externalId: bubbleSent.externalId, createdAt: bubbleSentAt });
            bubblesSentThisTurn.push(safeBubble);
            // A refreshed availability response is complete by itself. Do not
            // append later bubbles generated against the now-stale snapshot.
            if (safeBubble !== bubble) break;
          }
          if (selectedStickerId && this.gateway.sendSticker) {
            const sticker = await this.repository.findEnabledAiSticker?.(message.tenantId, selectedStickerId);
            if (sticker) {
              try {
                const stickerSent = await this.gateway.sendSticker(message.sessionId, destination, { dataBase64: sticker.dataBase64 });
                await this.repository.recordAiStickerSend?.({
                  tenantId: message.tenantId,
                  conversationId: context.conversationId,
                  stickerId: sticker.id,
                  externalId: stickerSent.externalId
                });
              } catch (error) {
                logger.warn({ err: error, conversationId: context.conversationId, stickerId: selectedStickerId }, "AI sticker send failed after text reply");
                await this.repository.createSystemAlertOnce(
                  message.tenantId,
                  "A IA respondeu ao contato, mas não conseguiu enviar a figurinha selecionada. Verifique a conexão do WhatsApp."
                );
              }
            }
          }
          return { restartReply: false as const, sent, sentAt, sentBubbles, replyInboundExternalIds };
        });
        if (sendAttempt.restartReply) continue;
        return {
          completion,
          parsed,
          sent: sendAttempt.sent,
          sentAt: sendAttempt.sentAt,
          sentBubbles: sendAttempt.sentBubbles,
          replyInboundExternalIds: sendAttempt.replyInboundExternalIds,
          transactionClaims: replyClaims
        };
      }
    };
    let result: Awaited<ReturnType<typeof sendReply>>;
    try {
      // Reserva atômica: lê o saldo e grava o consumo na MESMA transação,
      // serializada por tenant. Uma checagem solta permitiria que duas mensagens
      // simultâneas do mesmo tenant lessem o mesmo saldo e estourassem a franquia.
      // A chave é derivada do turno lógico, então retentativa do mesmo job não
      // consome duas vezes.
      const consumption = await consumeAiInteraction(message.tenantId, "inbound_reply", requestId, { conversationId: context.conversationId, messageId: context.messageId });
      if (!consumption.allowed) {
        logger.warn({ event: "ai_interaction_blocked", tenantId: message.tenantId, conversationId: context.conversationId, purpose: "inbound_reply", reason: consumption.reason }, consumption.reason === "BILLING_UNAVAILABLE" ? "AI inbound reply skipped because billing is unavailable" : "AI inbound reply skipped because the billing quota was reached");
        await this.repository.markInboundProcessed(message);
        return "fallback";
      }
      result = await sendReply();
      void reconcileAiTurnFromUsageLogs(message.tenantId, "inbound_reply", requestId).catch(() => {});
    } catch (error) {
      await recordQualitySignal();
      try {
      } catch (signalError) {
        logger.error({
          err: signalError,
          tenantId: message.tenantId,
          conversationId: context.conversationId,
          agentConfigVersionId: context.agentConfigVersionId
        }, "Failed to record AI evaluation signal");
      }
      if (isNonRetryableAiError(error)) {
        const directSchedulingStillPending = effectiveSchedulingIntent?.kind === "direct_schedule"
          && requestedSlotAvailable !== false
          && !transactionalOutcomes.some((outcome) =>
            outcome.status === "succeeded"
            && ["schedule_meeting", "reschedule_meeting", "schedule_visit", "reschedule_visit"].includes(outcome.action)
          );
        if (isAiGeneratedRecoveryError(error) && !directSchedulingStillPending) {
          try {
            if (await deliverCompactAiRecovery()) {
              logger.warn({
                event: "ai_message_processing",
                conversationId: context.conversationId,
                messageId: context.messageId,
                requestId,
                attempt: processingAttempt,
                reason: error.code
              }, "Primary AI generation failed; delivered a compact AI-generated reply");
              return "answered";
            }
          } catch (recoveryError) {
            logger.error({
              err: recoveryError,
              event: "ai_message_processing",
              conversationId: context.conversationId,
              messageId: context.messageId,
              requestId,
              attempt: processingAttempt,
              reason: error.code
            }, "Compact AI recovery failed");
          }
        }
        if (isAutomaticAiRecoveryError(error) && automaticRecoveryAttempt < 1) {
          logger.warn({
            event: "ai_message_processing",
            conversationId: context.conversationId,
            messageId: context.messageId,
            requestId,
            attempt: processingAttempt,
            reason: error.code
          }, "AI final response failed; releasing the lease for one automatic recovery attempt");
          throw error;
        }
        const notification = await this.repository.pauseForHandoff({
          tenantId: message.tenantId,
          conversationId: context.conversationId,
          sessionId: message.sessionId,
          reason: "technical_failure",
          errorCode: error.code,
          idempotencyKey: `${message.sessionId}:${message.externalId}:ai_failure:${error.code}`,
          notificationText: "AtendON: a IA não conseguiu produzir uma resposta segura. Continue este atendimento manualmente."
        });
        if (notification) await this.dispatchHandoff(notification);
        await this.repository.markInboundProcessed(message, processingExternalIds);
        logger.error({
          event: "ai_message_processing",
          conversationId: context.conversationId,
          messageId: context.messageId,
          requestId,
          model: context.model,
          attempt: processingAttempt,
          reason: error.code
        }, "AI message processing stopped without retry and handed off safely");
        return "handoff";
      }
      throw error;
    }
    const {
      parsed,
      sent,
      sentAt,
      sentBubbles,
      replyInboundExternalIds,
      transactionClaims
    } = result;
    if (!sent) {
      logger.warn({ externalId: message.externalId, conversationId: context.conversationId, reason: "no_reply_bubble_sent" }, "Inbound message ignored");
      await this.repository.markInboundProcessed(message, processingExternalIds);
      return "ignored";
    }
    await this.repository.recordAgentReply({
      tenantId: message.tenantId,
      sessionId: message.sessionId,
      conversationId: context.conversationId,
      agentConfigVersionId: context.agentConfigVersionId,
      text: parsed.text,
      model: context.model,
      externalId: sent.externalId,
      createdAt: sentAt,
      bubbles: sentBubbles,
      inboundExternalId: message.externalId,
      inboundExternalIds: replyInboundExternalIds,
      transactionClaims
    });
    return "answered";
    } finally {
      if (aiProgress) {
        try {
          await aiProgress.clear();
        } catch (error) {
          logger.warn({
            err: error,
            conversationId: context.conversationId,
            turnId: requestId,
            phase: "cleared"
          }, "AI turn progress clear failed");
        }
      }
      clearInterval(lockHeartbeat);
      await releaseConversationLock(conversationLock);
    }
    } catch (error) {
      await this.repository.releaseInboundProcessing(message).catch((releaseError) => {
        logger.error({ err: releaseError, externalId: message.externalId }, "Failed to release inbound processing lease");
      });
      throw error;
    }
  }
}

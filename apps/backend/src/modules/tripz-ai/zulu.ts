/**
 * Motor genérico de guardrails operacionais por agente (encaminhamento por
 * nome do responsável, convite a grupo de ofertas, sinais de desqualificação).
 * Os VALORES (nome do responsável, texto de retorno, link/rótulo do grupo)
 * vivem na configuração do tenant em agent_config_versions.guardrails — nunca
 * codificados no produto. O conteúdo de prompt de um agente específico (Zulu/
 * Tripz) é provisionado por src/db/provision-tripz.ts e mantido em
 * src/db/zulu-provision.ts; este arquivo só contém o motor.
 */
import { z } from "zod";

// Sem .strict(): chaves desconhecidas (ex.: campo novo escrito por uma versão
// mais nova do editor) são ignoradas em vez de invalidar a config inteira.
export const agentGuardrailsSchema = z.object({
  enabled: z.boolean().optional(),
  owner_name: z.string().trim().min(1).max(80).optional(),
  owner_referral_reply: z.string().trim().min(1).max(1000).optional(),
  offers_group_link: z.string().trim().url().max(500).optional(),
  offers_group_label: z.string().trim().min(1).max(120).optional()
}).default({});

export interface AgentGuardrails {
  enabled: boolean;
  /** Responsável para quem o agente encaminha contatos indicados. */
  ownerName: string;
  /** Resposta automática ao encaminhar o responsável; vazia desliga o envio. */
  ownerReferralReply: string;
  /** Link oficial do grupo de ofertas; sem link, o convite não é enviado. */
  offersGroupLink?: string;
  /** Rótulo do grupo nas mensagens ao cliente (ex.: "da empresa X"). */
  offersGroupLabel: string;
}

export const DEFAULT_OFFERS_GROUP_LABEL = "";

/**
 * Falha-fechado sem derrubar o atendimento: guardrails sem os dados
 * operacionais obrigatórios ficam SEM EFEITO (nunca enviam texto vazio ao
 * contato) e uma config malformada apenas desliga o guard — não pode quebrar
 * o carregamento de contexto do inbound inteiro.
 */
export function normalizeAgentGuardrails(value: unknown): AgentGuardrails {
  const parsed = agentGuardrailsSchema.safeParse(value ?? {});
  const data = parsed.success ? parsed.data : {};
  const ownerName = data.owner_name ?? "";
  const ownerReferralReply = data.owner_referral_reply ?? "";
  return {
    enabled: data.enabled === true && ownerName.length > 0 && ownerReferralReply.length > 0,
    ownerName,
    ownerReferralReply,
    offersGroupLink: data.offers_group_link,
    offersGroupLabel: data.offers_group_label ?? DEFAULT_OFFERS_GROUP_LABEL
  };
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keep Zulu behavior scoped to a Tripz agent; the copilot prompt is separate. */
export function isTripzZuluAgent(systemPrompt: string, tripzTenantScoped: boolean): boolean {
  if (!tripzTenantScoped) return false;
  const value = normalized(systemPrompt);
  return /\bzulu\b/.test(value) && /\btripz(?:\s+turismo)?\b/.test(value);
}

/**
 * A very first message (no prior turns) that already names the owner —
 * referral, saved contact, mutual acquaintance — skips the agent script
 * entirely: it goes straight to a human handoff instead of qualification.
 */
export function tripzZuluDetectsOwnerNameReferral(text: string, ownerName: string): boolean {
  if (!ownerName.trim()) return false;
  return new RegExp(`\\b${escapeRegExp(normalized(ownerName))}\\b`, "u").test(normalized(text));
}

/** Explicit requests for the owner are handoffs even after triage has started. */
export function tripzZuluRequestsOwnerHandoff(text: string, ownerName: string): boolean {
  if (!ownerName.trim()) return false;
  const value = normalized(text);
  const owner = escapeRegExp(normalized(ownerName));
  return new RegExp(
    `\\b(?:quero|queria|gostaria|preciso|prefiro|posso|pode|poderia|consigo|consegue)\\b[\\s\\S]{0,80}\\b(?:falar|conversar|chamar|transferir|passar|contato)\\b[\\s\\S]{0,50}\\b${owner}\\b`,
    "u"
  ).test(value)
    || new RegExp(`\\b(?:falar|conversar)\\s+(?:direto\\s+)?com\\s+(?:o\\s+)?${owner}\\b`, "u").test(value);
}

export function tripzZuluDetectsBoletoPayment(text: string): boolean {
  const value = normalized(text);
  if (/\b(?:nao\s+(?:quero|vou|pretendo|prefiro)\s+(?:pagar\s+)?(?:por\s+|com\s+|no\s+)?boleto|sem\s+boleto|boleto\s+nao\s+(?:quero|serve))\b/u.test(value)) {
    return false;
  }
  const hasBoleto = /\b(?:boleto(?:\s+bancario)?|bank\s*slip)\b/.test(value);
  const contextual = /\b(?:pag(?:amento|ar)|pago|quero|aceita|aceitam|tem|trabalha(?:m)?|prefiro|gostaria)\b[^\n.!?]{0,70}\b(?:boleto(?:\s+bancario)?|bank\s*slip)\b/.test(value)
    || /\b(?:boleto(?:\s+bancario)?|bank\s*slip)\b[^\n.!?]{0,70}\b(?:pag(?:amento|ar)|pago|quero|aceita|aceitam|prefiro|gostaria)\b/.test(value);
  return hasBoleto && (contextual || /^\s*(?:boleto(?:\s+bancario)?|bank\s*slip)\s*[?.]?\s*$/u.test(value));
}

/**
 * “Vi uma promoção” is intentionally not exclusive. The detector only fires
 * when the customer limits the request to price/offers or says so in a
 * standalone turn.
 */
export function tripzZuluDetectsExclusiveOffers(text: string): boolean {
  const value = normalized(text).trim();
  if (!value) return false;
  const price = String.raw`(?:promoc(?:ao|oes)|oferta(?:s)?|barat(?:o|a|os|as)|menor\s+preco|preco\s+baixo|desconto)`;
  const exclusive = String.raw`(?:so|apenas|somente|exclusivamente|unicamente|nada\s+alem\s+de|sem\s+mais)`;
  const rejectsExclusivity = /\b(?:nao\s+(?:quero\s+)?(?:so|apenas|somente|exclusivamente)|aceito\s+(?:outras?|alternativas?|opcoes)|abert[oa]\s+a\s+(?:outras?|alternativas?|opcoes)|pode\s+ser\s+(?:outra|diferente)|com\s+(?:orientacao|consultoria|suporte))\b/u.test(value);
  if (rejectsExclusivity) return false;
  return new RegExp(`\\b${exclusive}\\b[\\s\\S]{0,60}\\b${price}\\b`, "u").test(value)
    || new RegExp(`\\b${price}\\b[\\s\\S]{0,60}\\b${exclusive}\\b`, "u").test(value)
    || new RegExp(`^(?:(?:quero|busco|procuro|tem)\\s+)?(?:${price})(?:\\s+(?:e|ou)\\s+(?:${price}))*[?.!]*$`, "u").test(value);
}

export interface TripzZuluTurnSignals {
  exclusiveOffers: boolean;
  boletoPayment: boolean;
}

export function tripzZuluTurnSignals(
  text: string,
  history: readonly string[] = [],
  groupLink?: string,
  offersGroupLabel: string = DEFAULT_OFFERS_GROUP_LABEL
): TripzZuluTurnSignals {
  const recent = [...history, text].filter(Boolean).slice(-8);
  const link = groupLink?.trim();
  const invitationAlreadySent = Boolean(link && history.some((item) => item.includes(link)))
    || history.some((item) => new RegExp(`grupo\\s+de\\s+ofertas${offersGroupLabel ? `\\s+${escapeRegExp(offersGroupLabel)}` : ""}`, "iu").test(item));
  return {
    // An offer invitation is a turn-triggered action. Looking back through
    // history would repeat the group message on every later response.
    exclusiveOffers: !invitationAlreadySent && tripzZuluDetectsExclusiveOffers(text),
    boletoPayment: recent.some(tripzZuluDetectsBoletoPayment)
  };
}

export function appendOffersInvitation(
  text: string,
  groupLink?: string,
  offersGroupLabel: string = DEFAULT_OFFERS_GROUP_LABEL
): string {
  const link = groupLink?.trim();
  if (!link || !/^https?:\/\//i.test(link) || text.includes(link)) return text;
  const groupPhrase = `grupo de ofertas${offersGroupLabel ? ` ${offersGroupLabel}` : ""}`;
  return `${text.trim()}\n\nSe você busca acompanhar promoções e condições especiais, temos um ${groupPhrase}\n${link}`;
}

export function tripzZuluTurnInstruction(signals: TripzZuluTurnSignals, groupLink?: string): string {
  return [
    signals.exclusiveOffers
      ? `SINAL INTERNO ZULU: o contato parece buscar exclusivamente promoções/viagens baratas. Convide-o naturalmente para o grupo de ofertas e envie somente este link oficial: ${groupLink?.trim() || "(link de ofertas não configurado; não invente um link)"}.`
      : "",
    signals.boletoPayment
      ? "SINAL INTERNO ZULU: pagamento por boleto bancário desqualifica este lead conforme a política do negócio. Registre internamente a perda/desqualificação e não insista em converter o cliente."
      : ""
  ].filter(Boolean).join("\n");
}

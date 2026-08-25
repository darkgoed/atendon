const EXPLICIT_CONTACT_REQUEST_PATTERNS = [
  /\b(?:quero|queria|gostaria|preciso|prefiro)\s+(?:de\s+)?(?:mesmo\s+)?(?:falar|conversar)\s+(?:direto\s+)?com\s+(?:(?:um|uma|o|a)\s+)?(?:humano|atendente|pessoa|alguem|equipe|consultor|especialista|vendedor|suporte)\b/gu,
  /\b(?:quero|queria|gostaria|preciso|prefiro)\s+(?:de\s+)?(?:(?:um|uma|o|a)\s+)?(?:atendimento\s+humano|humano|atendente|pessoa)\b/gu,
  /\b(?:me\s+)?(?:passa|passe|passar|transfere|transfira|transferir|encaminha|encaminhe|encaminhar|chama|chame|chamar|coloca|coloque|conecta|conecte)\s+(?:aqui\s+)?(?:(?:para|pra|pro|com|em\s+contato\s+com)\s+)?(?:(?:um|uma|o|a)\s+)?(?:humano|atendente|pessoa|alguem|equipe|consultor|especialista|vendedor|suporte)\b/gu,
  /\b(?:tem\s+como|da\s+para|posso|pode|poderia|consegue)\s+(?:me\s+)?(?:falar|conversar|passar|transferir|encaminhar|chamar|colocar|conectar)\s+(?:(?:para|pra|pro|com|em\s+contato\s+com)\s+)?(?:(?:um|uma|o|a)\s+)?(?:humano|atendente|pessoa|alguem|equipe|consultor|especialista|vendedor|suporte)\b/gu,
  /\b(?:humano|atendente|uma\s+pessoa),?\s+por\s+favor\b/gu
];

const NEGATED_REQUEST_PREFIX = /\b(?:nao|nem)\s*(?:(?:preciso|prefiro|precisa|precisam|posso|pode|poderia|quero|queria|gostaria|consigo|consegue)\s+)?(?:(?:que\s+)?(?:voce\s+)?)?$/u;

const HUMAN_SERVICE_OFFER = /\b(?:(?:prefere|quer|gostaria|deseja)\b.{0,80}\b(?:atendimento\s+humano|falar\s+com\s+(?:uma\s+)?pessoa|alguem\s+da\s+equipe)|(?:posso|quer\s+que\s+eu)\b.{0,80}\b(?:chamar|passar|transferir|encaminhar)\b.{0,50}\b(?:atendente|pessoa|alguem|equipe))\b/u;
const NEGATED_HUMAN_SERVICE_OFFER = /\b(?:nao|nem)\s+(?:posso|consigo|quero|prefiro|quer|gostaria|deseja)\b.{0,100}\b(?:atendimento\s+humano|atendente|pessoa|alguem|equipe)\b/u;
const HUMAN_OR_IDENTITY_TOPIC = /\b(?:atendimento\s+humano|falar\s+com\s+(?:uma\s+)?(?:pessoa|atendente|humano)|(?:voce|vc)\s+(?:e|eh|seria)\s+(?:um\s+|uma\s+)?(?:bot|robo|ia|inteligencia\s+artificial|automacao|assistente\s+virtual)|(?:estou|to)\s+falando\s+com\s+(?:um\s+|uma\s+)?(?:bot|robo|ia|inteligencia\s+artificial|automacao))\b/u;
const AFFIRMATIVE_HUMAN_OFFER_REPLY = /^(?:sim(?:[,! ]+(?:quero|prefiro|pode\s+ser|por\s+favor))?|quero|prefiro|pode\s+ser|sim\s+pode|por\s+favor)[.! ]*$/u;
const AGENT_HANDOFF_ANNOUNCEMENT = /\b(?:(?:(?:ja\s+)?(?:vou|vamos|irei|iremos)\s+(?:te\s+|lhe\s+)?(?:passar|transferir|encaminhar|conectar|direcionar|colocar))|(?:(?:ja\s+)?(?:te\s+|lhe\s+)(?:passo|transfiro|encaminho|conecto|direciono|coloco)))\b.{0,100}\b(?:humano|atendente|pessoa|alguem|equipe|consultor|especialista|vendedor|suporte)\b/u;

export const AI_HANDOFF_MARKER = "[[HANDOFF]]";

function normalizedHandoffText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

export function contactRequestsHandoff(text: string): boolean {
  const normalized = normalizedHandoffText(text);

  return EXPLICIT_CONTACT_REQUEST_PATTERNS.some((pattern) => {
    for (const match of normalized.matchAll(pattern)) {
      const prefix = normalized.slice(Math.max(0, match.index - 32), match.index);
      if (!NEGATED_REQUEST_PREFIX.test(prefix)) return true;
    }
    return false;
  });
}

/**
 * Um aceite curto só é explícito no contexto de uma oferta humana inequívoca.
 * Exigimos também que a oferta tenha vindo após uma pergunta do contato sobre
 * identidade ou atendimento humano, impedindo que o modelo crie sozinho uma
 * transferência ao oferecer atendente em resposta a frustração ou objeção.
 */
export function contactAcceptsOfferedHandoff(
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  if (!AFFIRMATIVE_HUMAN_OFFER_REPLY.test(normalizedHandoffText(text))) return false;

  let lastAssistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex < 0) return false;
  let previousUser: { role: "user" | "assistant"; content: string } | undefined;
  for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      previousUser = history[index];
      break;
    }
  }
  if (!previousUser) return false;

  const assistantOffer = normalizedHandoffText(history[lastAssistantIndex]!.content);
  return HUMAN_SERVICE_OFFER.test(assistantOffer)
    && !NEGATED_HUMAN_SERVICE_OFFER.test(assistantOffer)
    && HUMAN_OR_IDENTITY_TOPIC.test(normalizedHandoffText(previousUser.content));
}

export function parseAgentHandoff(text: string): { handoff: boolean; text: string } {
  const handoff = text.includes(AI_HANDOFF_MARKER);
  return { handoff, text: text.replaceAll(AI_HANDOFF_MARKER, "").trim() };
}

/**
 * Pedidos explícitos são tratados deterministicamente antes da chamada ao
 * modelo. Portanto, qualquer marcador produzido durante a geração normal é
 * uma decisão autônoma indevida e precisa ser reescrito, não executado.
 */
export function unauthorizedAgentHandoffCorrection(text: string): string | undefined {
  const marker = parseAgentHandoff(text).handoff;
  const normalized = normalizedHandoffText(text);
  const announcement = AGENT_HANDOFF_ANNOUNCEMENT.test(normalized)
    && !(HUMAN_SERVICE_OFFER.test(normalized) && normalized.includes("?"));
  if (!marker && !announcement) return undefined;
  return "O contato não pediu atendimento humano de forma explícita. Não use [[HANDOFF]], não interrompa a conversa e não anuncie transferência. Se ele pedir apenas mais informações ou mencionar um assunto sem contexto suficiente, pergunte em uma frase curta qual informação ou necessidade deseja esclarecer. Dúvida, resposta incompleta, objeção, frustração, mudança de assunto, informação inesperada ou dificuldade de interpretação são situações normais: responda ao que estiver claro e faça no máximo uma pergunta curta para entender o restante.";
}

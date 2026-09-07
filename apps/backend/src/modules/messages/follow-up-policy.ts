import { protectedSystemPrompt } from "../ai-router/prompt-guard.js";
import { AI_HANDOFF_MARKER } from "./handoff.js";
import type { FollowUpDelivery } from "./follow-up-media.js";

export type FollowUpPolicyHistory = Array<{ role: "user" | "assistant"; content: string }> ;
export type FollowUpPolicyClaim = {
  systemPrompt: string; followUpCount: number; maxCount: number; history: FollowUpPolicyHistory;
  delivery?: FollowUpDelivery & { name?: string; description?: string };
};
export const AI_FOLLOW_UP_NOT_NEEDED_MARKER = "[[NO_FOLLOW_UP_NEEDED]]";

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

function lastUserMessageIndex(history: FollowUpPolicyHistory): number {
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

function unansweredAssistantMessages(history: FollowUpPolicyHistory): string[] {
  const lastContactIndex = lastUserMessageIndex(history);
  return history
    .slice(lastContactIndex + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter(Boolean);
}

export function hasAlreadyRetriedSameTopic(history: FollowUpPolicyHistory): boolean {
  const unanswered = unansweredAssistantMessages(history);
  if (unanswered.length < 2) return false;
  return isSameFollowUpTopic(unanswered.at(-2)!, unanswered.at(-1)!);
}

function compactContextText(text: string, maxCharacters = 500): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxCharacters ? compact : `${compact.slice(0, maxCharacters - 1).trimEnd()}…`;
}

/** Factual continuity snapshot; it deliberately contains no behavioral instruction. */
export function followUpContinuityContext(history: FollowUpPolicyHistory): string {
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

export function followUpSystemPrompt(claim: FollowUpPolicyClaim): string {
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


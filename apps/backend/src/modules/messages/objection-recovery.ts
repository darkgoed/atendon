type ChatHistory = Array<{ role: "user" | "assistant"; content: string }>;

function normalizedText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

const LISTENING_BREAKDOWN = /\b(?:ja\s+(?:te\s+)?(?:falei|disse|respondi)|(?:pergunta|perguntando|perguntou).{0,35}(?:de\s+novo|novamente|repetid)|ninguem\s+(?:me\s+)?(?:ouve|escuta)|nao\s+(?:me\s+)?(?:ouviu|escutou|entendeu)|voce\s+(?:nem\s+)?(?:leu|viu).{0,25}(?:respondi|falei|disse)|parece\s+(?:um\s+)?(?:bot|robo)|voce\s+e\s+(?:um\s+)?(?:bot|robo|ia)|atendimento.{0,30}(?:cansativo|robotizado)|(?:muito|so)\s+questionario)\b/u;
const REQUESTS_USEFUL_EXPLANATION = /\b(?:me\s+mostra|mostra\s+(?:ai|entao|pra\s+mim)|me\s+explica|explica\s+(?:ai|entao|pra\s+mim)|quero\s+(?:ver|entender)|como\s+isso\s+funciona)\b/u;
const QUALIFICATION_TOPIC = /\b(?:faturamento|instagram|ramo|nicho|segmento|tempo\s+(?:de|no)\s+mercado|quanto\s+tempo|ano\s+de\s+abertura|cnpj|ticket\s+medio|volume\s+de\s+vendas)\b/u;
const DIRECT_IDENTITY_QUESTION = /\b(?:(?:voce|vc)\s+(?:e|eh|seria)\s+(?:(?:um|uma)\s+)?(?:bot|robo|ia|inteligencia\s+artificial|automacao|assistente\s+virtual)|(?:estou|to)\s+falando\s+com\s+(?:(?:um|uma)\s+)?(?:bot|robo|ia|inteligencia\s+artificial|automacao))\b/u;
const BOT_OR_HUMAN = /\b(?:bot|robo|inteligencia\s+artificial|\bia\b|automacao|automatizado|assistente\s+digital|humano)\b/u;
const SCHEDULING_INVITATION = /\b(?:agend|marc|reserv|horario|agenda|google\s+meet|reuniao)\w*/u;
const ACKNOWLEDGES_BREAKDOWN = /\b(?:voce\s+tem\s+razao|tem\s+razao|desculp|foi\s+repetitivo|repetimos|perguntamos\s+de\s+novo|atendimento\s+ficou|entendo\s+(?:o\s+)?(?:incomodo|desgaste|cansaco)|nao\s+te\s+ouvimos)\b/u;
const PROVIDES_USEFUL_EXPLANATION = /\b(?:funciona|solucao|servico|produto|processo|ajud|atend|oferta)\w*/u;
const IDENTIFIES_AS_DIGITAL_ASSISTANT = /\bassistente\s+digital\b/u;
const OFFERS_HUMAN_SERVICE = /\b(?:atendimento\s+humano|pessoa\s+da\s+equipe|alguem\s+da\s+equipe|atendente)\b/u;

export const OBJECTION_RECOVERY_BLOCKED_TOOLS = new Set([
  "qualificar_lead",
  "consultar_agendas",
  "consultar_unidades",
  "verificar_horarios",
  "verificar_horarios_reuniao",
  "agendar_visita",
  "agendar_reuniao",
  "reagendar_visita",
  "reagendar_reuniao"
]);

/**
 * Detecta uma ruptura recente de escuta seguida de abertura do contato para
 * receber uma explicação. A janela curta evita carregar esse modo para o resto
 * da conversa depois que a confiança já foi recuperada.
 */
export function needsObjectionRecovery(history: ChatHistory): boolean {
  const recentUserMessages = history
    .filter((message) => message.role === "user")
    .slice(-4)
    .map((message) => normalizedText(message.content));
  const latestUserMessage = recentUserMessages.at(-1);
  if (!latestUserMessage) return false;

  if (DIRECT_IDENTITY_QUESTION.test(latestUserMessage)) return true;
  const hasRecentBreakdown = recentUserMessages.some((message) => LISTENING_BREAKDOWN.test(message));
  return hasRecentBreakdown
    && (LISTENING_BREAKDOWN.test(latestUserMessage) || REQUESTS_USEFUL_EXPLANATION.test(latestUserMessage));
}

export function objectionRecoveryPromptNote(history: ChatHistory): string {
  if (!needsObjectionRecovery(history)) return "";
  const latestUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");
  if (latestUserMessage && DIRECT_IDENTITY_QUESTION.test(normalizedText(latestUserMessage.content))) {
    return `\n\nTRANSPARÊNCIA DE IDENTIDADE OBRIGATÓRIA NESTE TURNO:
- O contato perguntou diretamente se está falando com um robô, bot, IA ou automação
- Responda com transparência que você é o assistente digital da empresa descrita no prompt ativo e atua no atendimento configurado
- Não finja ser humano e não desvie da pergunta
- Ofereça atendimento humano caso a pessoa prefira, sem anunciar que já transferiu e sem produzir marcador de handoff
- Não faça pergunta de qualificação, não ofereça reunião, agenda ou horários neste turno
- Uma eventual aceitação do atendimento humano será processada pelo sistema na próxima mensagem do contato`;
  }
  return `\n\nRECUPERAÇÃO DE ESCUTA OBRIGATÓRIA NESTE TURNO:
- O contato sinalizou que não foi ouvido, recebeu perguntas repetidas ou desconfiou do atendimento, e ainda abriu espaço para entender a oferta
- Reconheça o problema sem revelar espontaneamente nem discutir se o atendimento é bot, IA ou humano e peça desculpas de forma breve
- Recupere em uma frase os fatos que ele já informou, inclusive respostas dadas fora de ordem, sem perguntar nem pedir confirmação novamente
- Entregue agora uma explicação concreta no WhatsApp sobre a solução, serviço ou processo descrito no prompt ativo do tenant; use somente os fatos presentes nesse contexto
- Não invente benefício, condição comercial, aprovação, preço, prazo ou resultado
- Não faça handoff apenas por essa reclamação, não faça pergunta de qualificação e não ofereça reunião, agenda ou horários neste turno
- Depois da explicação útil, você pode oferecer somente a continuação por texto, com um passo a passo, ou por áudio curto; a reunião fica para uma etapa posterior`;
}

/**
 * Garante que a primeira resposta após a ruptura realmente repare a conversa,
 * em vez de voltar ao questionário ou transformar "me mostra" em agendamento.
 */
export function objectionRecoveryCorrection(text: string, history: ChatHistory): string | undefined {
  if (!needsObjectionRecovery(history)) return undefined;
  const normalized = normalizedText(text);
  const latestUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");
  const directIdentityQuestion = Boolean(
    latestUserMessage && DIRECT_IDENTITY_QUESTION.test(normalizedText(latestUserMessage.content))
  );
  const asksQualificationQuestion = text
    .split(/\n+/u)
    .filter((part) => part.includes("?"))
    .some((question) => QUALIFICATION_TOPIC.test(normalizedText(question)));

  if (directIdentityQuestion) {
    if (
      !IDENTIFIES_AS_DIGITAL_ASSISTANT.test(normalized)
      || !OFFERS_HUMAN_SERVICE.test(normalized)
    ) {
      return "A pergunta de identidade precisa ser respondida diretamente e com transparência. Diga que você é o assistente digital da empresa descrita no prompt ativo e ofereça atendimento humano caso a pessoa prefira, sem fingir ser humano, anunciar transferência ou produzir marcador de handoff.";
    }
    if (SCHEDULING_INVITATION.test(normalized) || asksQualificationQuestion) {
      return "Neste turno, responda somente à pergunta de identidade: diga que você é o assistente digital da empresa descrita no prompt ativo e ofereça atendimento humano caso a pessoa prefira. Não faça qualificação e não ofereça reunião, agenda ou horários.";
    }
    return undefined;
  }

  if (
    BOT_OR_HUMAN.test(normalized)
    || SCHEDULING_INVITATION.test(normalized)
    || asksQualificationQuestion
  ) {
    return "A resposta ainda não recupera a ruptura de escuta. Como não houve pergunta direta de identidade, não revele espontaneamente nem discuta se o atendimento é bot, IA ou humano, não repita perguntas de qualificação e não ofereça reunião, agenda ou horários. Reconheça o erro, aproveite os fatos já informados e explique concretamente a solução ou o processo descrito no prompt ativo do tenant, sem inventar fatos.";
  }

  if (
    !ACKNOWLEDGES_BREAKDOWN.test(normalized)
    || !PROVIDES_USEFUL_EXPLANATION.test(normalized)
  ) {
    return "A resposta precisa primeiro reconhecer de forma breve que o contato tem razão e que as perguntas foram repetidas, e então entregar uma explicação útil da solução descrita no prompt ativo do tenant. Use apenas os fatos daquele contexto e só depois ofereça continuar por texto ou áudio curto.";
  }

  return undefined;
}

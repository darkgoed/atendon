import { z } from "zod";

export const flowStepKind = z.enum([
  "years", "revenue", "options", "boolean", "text", "final",
  // R22 (fluxos de robô determinísticos) — kinds aditivos:
  "message", // envia mensagem e segue (sem pergunta)
  "delay", // espera wait_minutes e segue
  "wait_for_reply", // aguarda resposta do contato até timeout_minutes
  "action" // efeito determinístico (tag/estágio/agente/webhook)
]);
export type FlowStepKind = z.infer<typeof flowStepKind>;

const flowOptionSchema = z.object({
  value: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().min(1).max(200)).optional()
});
export type FlowOption = z.infer<typeof flowOptionSchema>;

export const flowActionType = z.enum(["tag_add", "tag_remove", "stage_move", "assign_agent", "webhook"]);
export type FlowActionType = z.infer<typeof flowActionType>;

// SSRF: webhook de fluxo só sai por https para host público. IPv4/IPv6 privados,
// link-local, CGNAT e hostnames internos são negados (snapshot obsoleto é
// reforçado em runtime por assertPublicWebhookUrl em fireFlowWebhooks).
function isInternalIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) {
    // IPv6 literal: ::1, ULA fc00::/7, link-local fe80::/10, mapeado ::ffff:IPv4.
    // URL normaliza o mapeado para hex (ex.: ::ffff:a00:1) — qualquer forma
    // ::ffff: é negada (fail-closed; não é endereço público legítimo).
    if (/^::ffff:/i.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isInternalIPv4(mapped[1]);
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe80/.test(host);
  }
  if (!host.includes(".")) return true; // label única sem sufixo público (ex.: localhost)
  const parts = host.split(".");
  const looksLikeIPv4 = parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
  if (!looksLikeIPv4) return false; // hostname público pontilhado (ex.: api.example.com)
  return isInternalIPv4(host); // parecido com IPv4 mas malformado → fail-closed
}

export const webhookUrlSchema = z.string().url().max(2_000).superRefine((value, context) => {
  if (!value.startsWith("https://")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Webhook precisa usar https://" });
    return;
  }
  if (isInternalHost(new URL(value).hostname)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Webhook não pode apontar para host interno" });
  }
});

/** Guarda runtime: snapshots de fluxo anteriores podem carregar URL hoje proibida. */
export function assertPublicWebhookUrl(url: string): void {
  if (!url.startsWith("https://") || isInternalHost(new URL(url).hostname)) {
    throw new Error(`Webhook bloqueado (https obrigatório, host público): ${url}`);
  }
}

const flowStepSchema = z.object({
  kind: flowStepKind,
  question: z.string().trim().min(1).max(2_000).optional(),
  field: z.string().trim().regex(/^[a-z0-9_]+$/).max(100).optional(),
  options: z.array(flowOptionSchema).max(20).optional(),
  next: z.string().optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  message: z.string().trim().min(1).max(4_000).optional(),
  classificacao: z.string().trim().max(200).optional(),
  // delay
  wait_minutes: z.number().int().min(1).max(1_440).optional(),
  // wait_for_reply
  timeout_minutes: z.number().int().min(1).max(1_440).optional(),
  variable_name: z.string().trim().regex(/^[a-z0-9_]+$/).max(100).optional(),
  on_timeout: z.string().optional(),
  on_invalid_reply: z.string().optional(),
  // action
  action_type: flowActionType.optional(),
  tag_ids: z.array(z.string().uuid()).max(50).optional(),
  stage_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  webhook_url: webhookUrlSchema.optional(),
  method: z.enum(["GET", "POST", "PUT"]).optional(),
  template: z.string().trim().max(8_000).optional()
});
export type FlowStep = z.infer<typeof flowStepSchema>;

export const QUESTION_KINDS: readonly FlowStepKind[] = ["years", "revenue", "options", "boolean", "text"];

/** Etapas destino de uma etapa (todas as saídas possíveis do grafo). */
export function stepTargets(step: FlowStep): string[] {
  return [...new Set([
    step.next,
    step.on_timeout,
    step.on_invalid_reply,
    ...Object.values(step.transitions ?? {})
  ])].filter((target): target is string => Boolean(target));
}

export const flowDefinitionSchema = z.object({
  start: z.string(),
  intro: z.string().trim().max(2_000).optional(),
  origem: z.string().trim().min(1).max(200).default("facebook"),
  triggers: z.object({
    ctwa: z.boolean().default(false),
    session_ids: z.array(z.string().uuid()).max(100).default([]),
    keywords: z.array(z.string().trim().min(1).max(100)).max(100).default([])
      .transform((items) => [...new Set(items.map((item) => item.toLocaleLowerCase("pt-BR")))])
  }).default({ ctwa: false, session_ids: [], keywords: [] }),
  steps: z.record(z.string(), flowStepSchema)
}).superRefine((definition, context) => {
  const stepIds = new Set(Object.keys(definition.steps));
  if (!stepIds.has(definition.start)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa inicial "${definition.start}" não existe`, path: ["start"] });
  }
  for (const [id, step] of Object.entries(definition.steps)) {
    for (const target of stepTargets(step)) {
      if (!stepIds.has(target)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" aponta para etapa inexistente "${target}"`, path: ["steps", id] });
      }
    }
    if (step.kind === "final") {
      if (!step.message) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa final "${id}" precisa de message`, path: ["steps", id] });
      continue;
    }
    if (step.kind === "message") {
      if (!step.message) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de mensagem "${id}" precisa de message`, path: ["steps", id] });
      if (!step.next) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de mensagem "${id}" precisa de next`, path: ["steps", id] });
      continue;
    }
    if (step.kind === "delay") {
      if (!step.wait_minutes) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de espera "${id}" precisa de wait_minutes (1-1440)`, path: ["steps", id] });
      if (!step.next) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de espera "${id}" precisa de next`, path: ["steps", id] });
      continue;
    }
    if (step.kind === "wait_for_reply") {
      if (!step.timeout_minutes) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de timeout_minutes (1-1440)`, path: ["steps", id] });
      if (!step.on_timeout) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de on_timeout (etapa destino do tempo esgotado)`, path: ["steps", id] });
      if (!step.next) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de next (destino quando o contato responde)`, path: ["steps", id] });
      continue;
    }
    if (step.kind === "action") {
      if (!step.next) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" precisa de next`, path: ["steps", id] });
      if (!step.action_type) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" precisa de action_type`, path: ["steps", id] });
      } else if ((step.action_type === "tag_add" || step.action_type === "tag_remove") && !step.tag_ids?.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" (${step.action_type}) precisa de tag_ids`, path: ["steps", id] });
      } else if (step.action_type === "stage_move" && !step.stage_id) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" (stage_move) precisa de stage_id`, path: ["steps", id] });
      } else if (step.action_type === "assign_agent" && !step.agent_id) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" (assign_agent) precisa de agent_id`, path: ["steps", id] });
      } else if (step.action_type === "webhook" && !step.webhook_url) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa de ação "${id}" (webhook) precisa de webhook_url`, path: ["steps", id] });
      }
      continue;
    }
    // kinds de pergunta (years/revenue/options/boolean/text)
    if (!step.question) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de question`, path: ["steps", id] });
    if (!step.next && !step.transitions) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de next ou transitions`, path: ["steps", id] });
    if (step.kind !== "text" && !step.options?.length) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de options`, path: ["steps", id] });
    for (const option of step.options ?? []) {
      if (!(step.transitions?.[option.value] ?? step.next)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Opção "${option.value}" da etapa "${id}" não tem etapa seguinte`, path: ["steps", id] });
      }
    }
  }
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

/** Variáveis disponíveis para interpolação {{variavel}} em message/question. */
export type FlowVars = Record<string, string>;

const TEMPLATE_VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Substitui {{chave}} pelos valores; variável ausente vira string vazia. */
export function renderTemplate(template: string, vars: FlowVars = {}): string {
  return template.replace(TEMPLATE_VAR, (match, key: string) => {
    const value = vars[key] ?? vars[key.toLocaleLowerCase("pt-BR")];
    return value === undefined ? "" : value;
  });
}

/**
 * Detecção de ciclo na ativação (lição do legado: loop de bifurcação sem saída).
 * Rejeita qualquer etapa alcançável a partir do início que não consegue chegar
 * a uma etapa "final" — cobre loops sem saída e caminhos mortos.
 */
export function activationIssues(definition: FlowDefinition): string[] {
  const issues: string[] = [];
  if (!definition.triggers.ctwa && !definition.triggers.session_ids.length && !definition.triggers.keywords.length) {
    issues.push("Configure ao menos um gatilho: CTWA, sessão ou palavra-chave");
  }
  const reverse = new Map<string, string[]>();
  for (const [id, step] of Object.entries(definition.steps)) {
    for (const target of stepTargets(step)) {
      const list = reverse.get(target) ?? [];
      list.push(id);
      reverse.set(target, list);
    }
  }
  const reachFinal = new Set<string>();
  const queue = Object.entries(definition.steps).filter(([, step]) => step.kind === "final").map(([id]) => id);
  while (queue.length) {
    const current = queue.pop() as string;
    if (reachFinal.has(current)) continue;
    reachFinal.add(current);
    queue.push(...reverse.get(current) ?? []);
  }
  const reachable = new Set<string>();
  const stack = [definition.start];
  while (stack.length) {
    const current = stack.pop() as string;
    if (reachable.has(current) || !definition.steps[current]) continue;
    reachable.add(current);
    stack.push(...stepTargets(definition.steps[current]));
  }
  for (const id of reachable) {
    if (!reachFinal.has(id)) issues.push(`Etapa "${id}" faz parte de um caminho que nunca encerra o fluxo (loop sem saída)`);
    if (issues.length >= 5) {
      issues.push("...");
      break;
    }
  }
  return issues;
}

export function renderQuestion(step: FlowStep, vars: FlowVars = {}): string {
  const question = renderTemplate(step.question ?? "", vars);
  if (step.kind === "boolean") return `${question} (Sim ou Não)`;
  if (step.kind === "text" || !step.options?.length) return question;
  return `${question}\n${step.options.map((option) => `• ${renderTemplate(option.value, vars)}`).join("\n")}`;
}

export function renderFinalMessage(step: FlowStep, vars: FlowVars = {}): string {
  const message = step.message ?? "";
  if (!/\{\{whatsapp_(?:principal|secundario)\}\}|wa\.me|especialista|falar com (?:a )?nossa equipe/i.test(message)) return renderTemplate(message, vars);
  if (step.classificacao === "Perfil qualificado — alto faturamento") {
    return "Perfeito! Formulário concluído com sucesso. Pelo que você me contou, sua loja tem exatamente o perfil que a oferta configurada procura. Obrigado por compartilhar essas informações! 🚀";
  }
  return "Obrigado pelas respostas! Formulário concluído com sucesso. As informações já ficaram registradas por aqui. 💪";
}

export function nextStepId(step: FlowStep, value: string): string | undefined {
  return step.transitions?.[value] ?? step.next;
}

/** Maior quantidade de perguntas em qualquer caminho a partir do início (para exibir progresso). */
export function totalQuestions(definition: FlowDefinition, from = definition.start, seen: Set<string> = new Set()): number {
  const step = definition.steps[from];
  if (!step || step.kind === "final" || seen.has(from)) return 0;
  const nextSeen = new Set(seen).add(from);
  const deepest = stepTargets(step).reduce((max, target) => Math.max(max, totalQuestions(definition, target, nextSeen)), 0);
  return (QUESTION_KINDS.includes(step.kind) ? 1 : 0) + deepest;
}

export function remainingQuestions(definition: FlowDefinition, from: string): number {
  return totalQuestions(definition, from);
}

// O formulário é conduzido e encerrado integralmente pela IA nesta conversa.
// A ativação exige apenas ao menos um gatilho configurado por organização.
export const DEFAULT_QUALIFICATION_FLOW = {
  start: "P1_TEMPO_DE_MERCADO",
  origem: "facebook",
  intro: "Oi! Que bom te ver por aqui 😊 Vou te fazer algumas perguntas rápidas pra entender o momento da sua loja, tudo bem?",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    P1_TEMPO_DE_MERCADO: {
      kind: "years",
      field: "tempo_mercado",
      question: "Pra começar: há quanto tempo a sua loja está no mercado?",
      options: [
        { value: "Menos de 1 ano", keywords: ["recem", "acabei de abrir", "abrindo agora", "comecando"] },
        { value: "De 1 a 3 anos" },
        { value: "De 3 a 5 anos" },
        { value: "Mais de 5 anos", keywords: ["muito tempo", "bastante tempo", "ha anos"] }
      ],
      next: "P2_FATURAMENTO"
    },
    P2_FATURAMENTO: {
      kind: "revenue",
      field: "faturamento",
      question: "E qual é o faturamento mensal médio da loja hoje?",
      options: [
        { value: "Até R$ 10 mil" },
        { value: "De R$ 10 mil a R$ 20 mil" },
        { value: "De R$ 20 mil a R$ 30 mil" },
        { value: "De R$ 30 mil a R$ 50 mil" },
        { value: "De R$ 50 mil a R$ 100 mil" },
        { value: "Acima de R$ 100 mil" }
      ],
      transitions: {
        "Até R$ 10 mil": "P5_INVESTIMENTO",
        "De R$ 10 mil a R$ 20 mil": "P5_INVESTIMENTO",
        "De R$ 20 mil a R$ 30 mil": "P5_INVESTIMENTO",
        "De R$ 30 mil a R$ 50 mil": "P3_NICHO",
        "De R$ 50 mil a R$ 100 mil": "P3_NICHO",
        "Acima de R$ 100 mil": "P3_NICHO"
      }
    },
    P3_NICHO: {
      kind: "options",
      field: "nicho",
      question: "Qual é o principal nicho da sua loja?",
      options: [
        { value: "Smartphones e eletrônicos", keywords: ["celular", "smartphone", "eletronic", "iphone", "samsung", "telefone", "notebook", "informatica", "\\btv\\b", "tablet"] },
        { value: "Scooters", keywords: ["scooter", "patinete", "bike eletrica", "bicicleta eletrica"] },
        { value: "Ótica", keywords: ["otica", "oculos", "lente"] },
        { value: "Outros", keywords: ["\\boutro"] }
      ],
      next: "P4_PERDA_DE_VENDAS"
    },
    P4_PERDA_DE_VENDAS: {
      kind: "options",
      field: "motivo_perda_vendas",
      question: "Hoje, qual é o principal motivo de perda de vendas na loja?",
      options: [
        { value: "Clientes não conseguem pagar à vista", keywords: ["a vista", "nao consegue(m)? pagar", "sem dinheiro", "nao tem (o )?dinheiro", "credito negado", "nome sujo", "na hora"] },
        { value: "Poucas opções de pagamento", keywords: ["opc(ao|oes) de pagamento", "forma(s)? de pagamento", "maquininha", "parcel", "so aceito"] },
        { value: "Empresa sem diferencial competitivo", keywords: ["diferencial", "concorrenc", "concorrente", "destaca"] },
        { value: "Margem de lucro muito baixa", keywords: ["margem", "lucro (muito )?baix", "ganho pouco", "sobra pouco"] }
      ],
      next: "P6A_INSTAGRAM"
    },
    P5_INVESTIMENTO: {
      kind: "boolean",
      field: "investimento",
      question: "Se fizesse sentido pra loja, você teria possibilidade de investir pra destravar esse crescimento?",
      options: [{ value: "SIM" }, { value: "NÃO" }],
      transitions: { "SIM": "P6B_INSTAGRAM", "NÃO": "E3_ENCERRAMENTO" }
    },
    P6A_INSTAGRAM: {
      kind: "text",
      field: "instagram",
      question: "Última pergunta: qual é o @ do Instagram da sua loja?",
      next: "E1_PAGINA_FINAL"
    },
    P6B_INSTAGRAM: {
      kind: "text",
      field: "instagram",
      question: "Última pergunta: qual é o @ do Instagram da sua loja?",
      next: "E2_PAGINA_FINAL"
    },
    E1_PAGINA_FINAL: {
      kind: "final",
      classificacao: "Perfil qualificado — alto faturamento",
      message: "Perfeito! Formulário concluído com sucesso. Pelo que você me contou, sua loja tem exatamente o perfil que a oferta configurada procura. Obrigado por compartilhar essas informações! 🚀"
    },
    E2_PAGINA_FINAL: {
      kind: "final",
      classificacao: "Perfil qualificado — potencial com investimento",
      message: "Obrigado pelas respostas! Formulário concluído com sucesso. Sua loja tem muito potencial de crescimento, e as informações já ficaram registradas por aqui. 💪"
    },
    E3_ENCERRAMENTO: {
      kind: "final",
      classificacao: "Sem perfil oferta configurada no momento",
      message: "Obrigado pelas respostas! No momento a gente não tem uma solução que encaixe no perfil da sua loja, mas vamos guardar seu contato pra futuras novidades. Sucesso por aí! 🙌"
    }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

/** @deprecated Use DEFAULT_QUALIFICATION_FLOW; retained for client provisioners. */
export const NEWAVE_FLOW = DEFAULT_QUALIFICATION_FLOW;

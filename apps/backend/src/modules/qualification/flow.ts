import { z } from "zod";

export const flowStepKind = z.enum(["years", "revenue", "options", "boolean", "text", "final"]);
export type FlowStepKind = z.infer<typeof flowStepKind>;

const flowOptionSchema = z.object({
  value: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().min(1).max(200)).optional()
});
export type FlowOption = z.infer<typeof flowOptionSchema>;

const flowStepSchema = z.object({
  kind: flowStepKind,
  question: z.string().trim().min(1).max(2_000).optional(),
  field: z.string().trim().regex(/^[a-z0-9_]+$/).max(100).optional(),
  options: z.array(flowOptionSchema).max(20).optional(),
  next: z.string().optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  message: z.string().trim().min(1).max(4_000).optional(),
  classificacao: z.string().trim().max(200).optional()
});
export type FlowStep = z.infer<typeof flowStepSchema>;

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
    const targets = [step.next, ...Object.values(step.transitions ?? {})].filter((target): target is string => Boolean(target));
    for (const target of targets) {
      if (!stepIds.has(target)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" aponta para etapa inexistente "${target}"`, path: ["steps", id] });
      }
    }
    if (step.kind === "final") {
      if (!step.message) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa final "${id}" precisa de message`, path: ["steps", id] });
    } else {
      if (!step.question) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de question`, path: ["steps", id] });
      if (!step.next && !step.transitions) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de next ou transitions`, path: ["steps", id] });
      if (step.kind !== "text" && !step.options?.length) context.addIssue({ code: z.ZodIssueCode.custom, message: `Etapa "${id}" precisa de options`, path: ["steps", id] });
      for (const option of step.options ?? []) {
        if (!(step.transitions?.[option.value] ?? step.next)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Opção "${option.value}" da etapa "${id}" não tem etapa seguinte`, path: ["steps", id] });
        }
      }
    }
  }
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

export function activationIssues(definition: FlowDefinition): string[] {
  const issues: string[] = [];
  if (!definition.triggers.ctwa && !definition.triggers.session_ids.length && !definition.triggers.keywords.length) {
    issues.push("Configure ao menos um gatilho: CTWA, sessão ou palavra-chave");
  }
  return issues;
}

export function renderQuestion(step: FlowStep): string {
  if (step.kind === "boolean") return `${step.question} (Sim ou Não)`;
  if (step.kind === "text" || !step.options?.length) return step.question ?? "";
  return `${step.question}\n${step.options.map((option) => `• ${option.value}`).join("\n")}`;
}

export function renderFinalMessage(step: FlowStep): string {
  const message = step.message ?? "";
  if (!/\{\{whatsapp_(?:principal|secundario)\}\}|wa\.me|especialista|falar com (?:a )?nossa equipe/i.test(message)) return message;
  if (step.classificacao === "Perfil Newave — alto faturamento") {
    return "Perfeito! Formulário concluído com sucesso. Pelo que você me contou, sua loja tem exatamente o perfil que a Newave procura. Obrigado por compartilhar essas informações! 🚀";
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
  const targets = [...new Set([step.next, ...Object.values(step.transitions ?? {})])].filter((target): target is string => Boolean(target));
  const deepest = targets.reduce((max, target) => Math.max(max, totalQuestions(definition, target, nextSeen)), 0);
  return 1 + deepest;
}

export function remainingQuestions(definition: FlowDefinition, from: string): number {
  return totalQuestions(definition, from);
}

// O formulário é conduzido e encerrado integralmente pela IA nesta conversa.
// A ativação exige apenas ao menos um gatilho configurado por organização.
export const NEWAVE_FLOW = {
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
      classificacao: "Perfil Newave — alto faturamento",
      message: "Perfeito! Formulário concluído com sucesso. Pelo que você me contou, sua loja tem exatamente o perfil que a Newave procura. Obrigado por compartilhar essas informações! 🚀"
    },
    E2_PAGINA_FINAL: {
      kind: "final",
      classificacao: "Perfil Newave — potencial com investimento",
      message: "Obrigado pelas respostas! Formulário concluído com sucesso. Sua loja tem muito potencial de crescimento, e as informações já ficaram registradas por aqui. 💪"
    },
    E3_ENCERRAMENTO: {
      kind: "final",
      classificacao: "Sem perfil Newave no momento",
      message: "Obrigado pelas respostas! No momento a gente não tem uma solução que encaixe no perfil da sua loja, mas vamos guardar seu contato pra futuras novidades. Sucesso por aí! 🙌"
    }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

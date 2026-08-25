import { z } from "zod";

export const RUBRIC_VERSION = "v1";
export const EVALUATOR_PROMPT_VERSION = "v2";

export const qualityDimension = z.enum([
  "correctness",
  "task_completion",
  "continuity",
  "communication",
  "security_privacy",
  "tool_usage",
  "handoff"
]);

export const scoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string().trim().min(1).max(1_000),
  evidenceMessageIds: z.array(z.string().uuid()).max(30)
});

export const scoresSchema = z.object({
  correctness: scoreSchema,
  task_completion: scoreSchema,
  continuity: scoreSchema,
  communication: scoreSchema,
  security_privacy: scoreSchema,
  tool_usage: scoreSchema,
  handoff: scoreSchema
});

export const violationSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
  dimension: qualityDimension,
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  evidenceMessageIds: z.array(z.string().uuid()).min(1).max(30),
  detail: z.string().trim().min(1).max(1_000)
});

export const evaluationOutputSchema = z.object({
  scores: scoresSchema,
  violations: z.array(violationSchema).max(100),
  overallScore: z.number().int().min(0).max(100),
  hasCriticalFailure: z.boolean(),
  summary: z.string().trim().min(1).max(2_000)
}).superRefine((value, context) => {
  const hasCritical = value.violations.some((violation) => violation.severity === "critical");
  if (hasCritical !== value.hasCriticalFailure) {
    context.addIssue({
      code: "custom",
      path: ["hasCriticalFailure"],
      message: "hasCriticalFailure deve refletir as violações críticas"
    });
  }
});

export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;
export type EvaluationViolation = z.infer<typeof violationSchema>;

export interface EvaluationMessage {
  id: string;
  sender: "contact" | "agent" | "human";
  content: string;
}

export interface EvaluationToolCall {
  toolName: string;
  status: "pending" | "completed" | "failed";
  result?: string | null;
  errorMessage?: string | null;
  messageId?: string;
  action?: string;
  claims?: Array<{ claimType: string; normalizedValue: string }>;
}

function normalizedTokens(text: string): Set<string> {
  return new Set(text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2));
}

function similarity(left: string, right: string): number {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

function violation(
  code: string,
  dimension: EvaluationViolation["dimension"],
  severity: EvaluationViolation["severity"],
  evidenceMessageIds: string[],
  detail: string,
  confidence = 1
): EvaluationViolation {
  return { code, dimension, severity, confidence, evidenceMessageIds, detail };
}

const GREETING = /^\s*(?:oi+|ol[aá]|opa+|bom\s+dia|boa\s+tarde|boa\s+noite|fala+)(?=\s|[,.!?]|$)/iu;
const INTERNAL_MARKER = /\[\[HANDOFF\]\]|<\|(?:system|assistant|user|end)[^>]*>|ESCOPO_DO_ATENDIMENTO|POLÍTICA DE SEGURANÇA/iu;
const TRANSACTIONAL_SUCCESS = /\b(?:agendad[oa]|reagendad[oa]|cancelad[oa]|cadastrad[oa]|reservad[oa]|reuni[aã]o (?:foi )?criada|deu certo|est[aá] confirmado)\b/iu;
const MEETING_SUCCESS_TOOLS = new Set(["agendar_reuniao", "reagendar_reuniao"]);

function claimedActionForText(text: string): string | undefined {
  if (/\breagendad[oa]\b/iu.test(text)) return "reschedule";
  if (/\bcancelad[oa]\b/iu.test(text)) return "cancel";
  if (/\b(?:agendad[oa]|reservad[oa]|reuni[aã]o (?:foi )?criada|est[aá] confirmado)\b/iu.test(text)) return "schedule";
  if (/\bcadastrad[oa]\b/iu.test(text)) return "qualify";
  return undefined;
}

function toolProvesClaim(call: EvaluationToolCall, messageId: string, claimedAction: string): boolean {
  return call.messageId === messageId
    && call.status === "completed"
    && call.action?.startsWith(claimedAction) === true
    && call.claims?.some((claim) =>
      claim.claimType === "transaction_status" && claim.normalizedValue === "succeeded"
    ) === true;
}

export function deterministicChecks(input: {
  messages: EvaluationMessage[];
  toolCalls?: EvaluationToolCall[];
  handoffReason?: string | null;
  channelLimit?: number;
}): EvaluationViolation[] {
  const result: EvaluationViolation[] = [];
  const agentMessages = input.messages.filter((message) => message.sender === "agent");
  const toolCalls = input.toolCalls ?? [];
  const channelLimit = input.channelLimit ?? 4_096;

  for (let index = 1; index < agentMessages.length; index += 1) {
    const previous = agentMessages[index - 1];
    const current = agentMessages[index];
    if (previous.content.includes("?") && current.content.includes("?")
      && similarity(previous.content, current.content) >= 0.78) {
      result.push(violation(
        "NEAR_DUPLICATE_QUESTION",
        "continuity",
        "medium",
        [previous.id, current.id],
        "Perguntas consecutivas têm conteúdo quase duplicado.",
        0.9
      ));
    }
  }

  const greetings = agentMessages.filter((message) => GREETING.test(message.content));
  if (greetings.length > 1) {
    result.push(violation(
      "REPEATED_GREETING",
      "continuity",
      "medium",
      greetings.map((message) => message.id),
      "A saudação foi repetida durante a mesma conversa."
    ));
  }

  for (const message of agentMessages) {
    if (INTERNAL_MARKER.test(message.content)) {
      result.push(violation(
        "INTERNAL_MARKER_LEAK",
        "security_privacy",
        "critical",
        [message.id],
        "A resposta contém marcador ou instrução interna protegida."
      ));
    }
    if (!message.content.trim()) {
      result.push(violation("EMPTY_MESSAGE", "communication", "high", [message.id], "A resposta está vazia."));
    } else if (message.content.length > channelLimit) {
      result.push(violation(
        "CHANNEL_LIMIT_EXCEEDED",
        "communication",
        "high",
        [message.id],
        "A resposta excede o limite configurado para o canal."
      ));
    } else if (/[\uFFFD]$|(?:\.\.\.|[,;:])\s*$/.test(message.content.trim())) {
      result.push(violation(
        "POSSIBLY_TRUNCATED_MESSAGE",
        "communication",
        "medium",
        [message.id],
        "A resposta aparenta ter sido cortada antes da conclusão.",
        0.7
      ));
    }
    const claimedAction = claimedActionForText(message.content);
    if (TRANSACTIONAL_SUCCESS.test(message.content)
      && (!claimedAction || !toolCalls.some((call) => toolProvesClaim(call, message.id, claimedAction)))) {
      result.push(violation(
        "SUCCESS_WITHOUT_TOOL_JOURNAL",
        "tool_usage",
        "critical",
        [message.id],
        "A resposta afirma sucesso transacional sem journal e claim compatíveis ligados àquela mensagem."
      ));
    }
  }

  for (const call of toolCalls.filter((item) =>
    MEETING_SUCCESS_TOOLS.has(item.toolName)
    && item.status === "completed"
    && item.claims?.some((claim) =>
      claim.claimType === "transaction_status" && claim.normalizedValue === "succeeded"
    )
  )) {
    const linkedMessage = agentMessages.find((message) => message.id === call.messageId);
    const claimedUrl = call.claims?.find((claim) => claim.claimType === "meeting_url")?.normalizedValue;
    if (linkedMessage && (!claimedUrl || !linkedMessage.content.includes(claimedUrl))) {
      result.push(violation(
        "MEETING_LINK_MISSING",
        "tool_usage",
        "high",
        [linkedMessage.id],
        "A mensagem não contém exatamente o link comprovado pelo journal associado."
      ));
    }
  }

  const failedCalls = toolCalls.filter((call) => call.status === "failed");
  const failedMessageIds = [...new Set(failedCalls
    .map((call) => call.messageId)
    .filter((id): id is string => Boolean(id)))];
  if (failedCalls.length && failedMessageIds.length) {
    result.push(violation(
      "TOOL_ERROR",
      "tool_usage",
      "high",
      failedMessageIds,
      `${failedCalls.length} ferramenta(s) terminaram com erro.`
    ));
  }
  const timeoutOrLimit = failedCalls.filter((call) => /timeout|tempo limite|rate.?limit|limite/iu.test(call.errorMessage ?? ""));
  const timeoutMessageIds = [...new Set(timeoutOrLimit
    .map((call) => call.messageId)
    .filter((id): id is string => Boolean(id)))];
  if (timeoutOrLimit.length && timeoutMessageIds.length) {
    result.push(violation(
      "TOOL_TIMEOUT_OR_LIMIT",
      "tool_usage",
      "high",
      timeoutMessageIds,
      "Uma ferramenta atingiu timeout ou limite operacional."
    ));
  }

  if (input.handoffReason === "") {
    const last = agentMessages.at(-1);
    if (last) result.push(violation(
      "HANDOFF_WITHOUT_REASON",
      "handoff",
      "high",
      [last.id],
      "O handoff foi persistido sem motivo."
    ));
  }

  return result;
}

const PHONE = /(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}(?!\d)/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DOCUMENT = /(?<!\d)(?:\d[.\s-]?){10,14}(?!\d)/g;
const PRIVATE_URL = /https?:\/\/[^\s"']+/gi;
const DECLARED_NAME = /\b(meu nome (?:é|e)|me chamo)\s+[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}/giu;
const EXTERNAL_IDENTIFIER = /\b(?:wamid[.:_-][A-Za-z0-9._:-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{8,20}@s\.whatsapp\.net)\b/gi;
const DECLARED_SECRET = /\b(?:bearer|token|secret|api.?key|senha)\s*[:=]?\s*[A-Za-z0-9._~+\/-]{8,}/gi;

export function sanitizeRegressionText(value: string): string {
  return value
    // Remove structured identifiers before permissive numeric patterns. Otherwise
    // a UUID tail can be consumed as a phone number and leave most of the UUID
    // behind, defeating the identifier redaction that runs later.
    .replace(EXTERNAL_IDENTIFIER, "[IDENTIFICADOR_REMOVIDO]")
    .replace(EMAIL, "[EMAIL_REMOVIDO]")
    .replace(PHONE, "[TELEFONE_REMOVIDO]")
    .replace(DOCUMENT, "[DOCUMENTO_REMOVIDO]")
    .replace(PRIVATE_URL, "[URL_REMOVIDA]")
    .replace(DECLARED_NAME, "$1 [NOME_REMOVIDO]")
    .replace(DECLARED_SECRET, "[SEGREDO_REMOVIDO]");
}

export function sanitizeTechnicalError(value: string): string {
  return sanitizeRegressionText(value)
    .replace(/(?:bearer\s+)?[A-Za-z0-9._~+\/-]{24,}/gi, "[SEGREDO_REMOVIDO]")
    .slice(0, 1_000);
}

export function sanitizeEvaluationOutput(value: EvaluationOutput): EvaluationOutput {
  const scores = Object.fromEntries(Object.entries(value.scores).map(([dimension, score]) => [
    dimension,
    { ...score, rationale: sanitizeRegressionText(score.rationale).slice(0, 1_000) }
  ])) as EvaluationOutput["scores"];
  return {
    ...value,
    scores,
    violations: value.violations.map((item) => ({
      ...item,
      detail: sanitizeRegressionText(item.detail).slice(0, 1_000)
    })),
    summary: sanitizeRegressionText(value.summary).slice(0, 2_000)
  };
}

const SENSITIVE_SCENARIO_FIELDS = new Set([
  "name", "nome", "fullname", "contactname", "customername", "personname", "username",
  "phone", "phonenumber", "telefone", "email", "emailaddress", "document", "cpf", "cnpj"
]);

function isSensitiveScenarioField(key: string, path: string[]): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
  // `name` is structural inside expectedBehavior.simulatedTools. Everywhere else
  // a bare name remains treated as contact/person PII.
  if (normalized === "name" && path.at(-1) === "simulatedTools") return false;
  return SENSITIVE_SCENARIO_FIELDS.has(normalized)
    || /(?:token|secret|apikey|password|passphrase|credential|authorization|privatekey)/u.test(normalized)
    || /external(?:message)?id/u.test(normalized)
    || /(?:contact|customer|person)(?:phone|email|name)$/u.test(normalized);
}

function sanitizeScenarioValue<T>(value: T, path: string[]): T {
  if (typeof value === "string") return sanitizeRegressionText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeScenarioValue(item, path)) as T;
  if (value && typeof value === "object") {
    const sanitized = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveScenarioField(key, path) && sanitizeRegressionText(key) === key)
      .map(([key, item]) => [key, sanitizeScenarioValue(item, [...path, key])]));
    return sanitized as T;
  }
  return value;
}

export function sanitizeRegressionScenario<T>(value: T): T {
  return sanitizeScenarioValue(value, []);
}

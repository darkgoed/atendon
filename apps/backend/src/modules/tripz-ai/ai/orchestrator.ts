import { TRIPZ_MAX_SELECTED_MEDIA } from "../domain.js";
import type {
  TripzFlightSegment,
  TripzGenerationRequirement,
  TripzIncludedItem,
  TripzItineraryDay,
  TripzProposalIssue,
  TripzProposalMedia,
  TripzProposalState
} from "../domain.js";
import {
  TRIPZ_AI_ATTACHMENT_BOUNDARY_NOTICE,
  TRIPZ_AI_SYSTEM_PROMPT
} from "./prompt.js";
import type {
  TripzAiAttachmentContent,
  TripzAiTurnBudget,
  TripzOpenRouterUsage,
  TripzStructuredCompletion,
  TripzStructuredCompletionInput
} from "./openrouter-client.js";
import {
  detectTripzPatchConflicts,
  tripzProposalContentFingerprint,
  validateTripzProposal,
  type TripzProposalValidationResult
} from "./proposal-validator.js";
import {
  tripzExplicitCorrectionPathSchema,
  type TripzAiProposalPatch,
  type TripzAiStructuredOutput,
  type TripzExplicitCorrectionPath
} from "./schemas.js";

export interface TripzStructuredAiClient {
  completeStructured(input: TripzStructuredCompletionInput): Promise<TripzStructuredCompletion>;
}

export interface TripzAiOrchestratorOptions {
  contextBudgetCharacters?: number;
  maxHistoryMessages?: number;
}

export interface TripzAiTurnInput {
  conversationId: string;
  userMessage: string;
  proposal: TripzProposalState;
  sessionSummary?: string | null;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: TripzAiAttachmentContent[];
  requiredFields?: Array<{ path: string; label?: string; reason?: string }>;
  budget?: TripzAiTurnBudget;
  onUsage?: (usage: TripzOpenRouterUsage) => Promise<void>;
}

export interface TripzAiTurnResult {
  assistantMessage: string;
  summary: string;
  proposal: TripzProposalState;
  validation: TripzProposalValidationResult;
  requestedAction: "none" | "show_summary" | "preview" | "pdf";
  documentGenerationAllowed: boolean;
  generationBlockedReason?: "missing_or_conflicting_information" | "summary_confirmation_required";
  rejectedChanges: string[];
  usage: TripzOpenRouterUsage;
  budget: TripzAiTurnBudget;
  fileAnnotations: TripzStructuredCompletion["fileAnnotations"];
}

function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripNulls(item)) as T;
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && child !== undefined) clean[key] = stripNulls(child);
  }
  return clean as T;
}

function applyNestedPatch<T extends object>(
  current: T | undefined,
  patch: Record<string, unknown> | null
): T | undefined {
  if (patch === null) return undefined;
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = stripNulls(value);
  }
  return Object.keys(next).length > 0 ? next as T : undefined;
}

export function applyAllowlistedTripzPatch(
  current: TripzProposalState,
  patch: TripzAiProposalPatch,
  conflictingPaths: ReadonlySet<string> = new Set()
): TripzProposalState {
  const next = structuredClone(current);
  const scalarFields = ["title", "destination", "startDate", "endDate"] as const;
  for (const field of scalarFields) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if ("client" in patch) {
    const value = applyNestedPatch(next.client, patch.client ?? null);
    if (value) next.client = value;
    else delete next.client;
  }
  if ("passengers" in patch) {
    const value = applyNestedPatch(next.passengers, patch.passengers ?? null);
    if (value) next.passengers = value;
    else delete next.passengers;
  }
  if ("hotel" in patch) {
    const hotelPatch = patch.hotel && typeof patch.hotel === "object" ? { ...patch.hotel } : patch.hotel;
    if (hotelPatch && conflictingPaths.has("hotel.mealPlan")) delete hotelPatch.mealPlan;
    const value = applyNestedPatch(next.hotel, hotelPatch ?? null);
    if (value) next.hotel = value;
    else delete next.hotel;
  }
  if ("pricing" in patch) {
    const value = applyNestedPatch(next.pricing, patch.pricing ?? null);
    if (value) next.pricing = value;
    else delete next.pricing;
  }
  if (patch.flights) next.flights = patch.flights.map((flight) => stripNulls(flight) as TripzFlightSegment);
  if (patch.includedItems) next.includedItems = patch.includedItems.map((item) => stripNulls(item) as TripzIncludedItem);
  if (patch.itinerary) next.itinerary = patch.itinerary.map((day) => stripNulls(day) as TripzItineraryDay);
  if (patch.notes) next.notes = [...patch.notes];
  return next;
}

function mediaLanguagePresent(message: string): boolean {
  return /\b(?:imagem|imagens|foto|fotos|capa|cozinha|quarto|banheiro|piscina|fachada|lobby|restaurante|praia)\b/i.test(message);
}

function correctionSupported(path: TripzExplicitCorrectionPath, message: string): boolean {
  if (!message.trim()) return false;
  if (path === "hotel.mealPlan") {
    return /(?:sem|com)\s+caf[eé]|caf[eé].{0,24}(?:inclus|n[aã]o\s+inclus)|(?:regime|alimenta[cç][aã]o|refei[cç][aã]o|pens[aã]o)\s*(?:e|é|:)|(?:corrig|confirm|na\s+verdade).{0,40}caf[eé]/i.test(message);
  }
  if (path.startsWith("pricing.")) return /r\$|valor|pre[cç]o|taxa|total|moeda|usd|brl|d[oó]lar|reais?/i.test(message);
  if (path === "flights") return /voo|trecho|ida|volta|chega|sai|bagagem/i.test(message);
  if (path === "startDate" || path === "endDate" || path === "hotel.checkIn" || path === "hotel.checkOut") {
    return /data|dia|check-?in|check-?out|entrada|sa[ií]da/i.test(message)
      || /\b(?:\d{1,2}[/. -]\d{1,2}(?:[/. -]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/.test(message);
  }
  return message.trim().length >= 2;
}

function applyMediaUpdates(
  proposal: TripzProposalState,
  output: TripzAiStructuredOutput,
  attachments: readonly TripzAiAttachmentContent[],
  userMessage: string
): { proposal: TripzProposalState; rejected: string[]; changed: boolean; autoDeselected: number } {
  const currentAttachmentIds = new Set(attachments
    .filter((attachment) => attachment.mimeType.startsWith("image/"))
    .map((attachment) => attachment.attachmentId));
  const existingAttachmentIds = new Set(proposal.media.map((media) => media.attachmentId));
  const mayCorrectExisting = mediaLanguagePresent(userMessage);
  const next = structuredClone(proposal);
  const rejected: string[] = [];
  let changed = false;
  for (const update of output.mediaUpdates) {
    const allowed = currentAttachmentIds.has(update.attachmentId)
      || (mayCorrectExisting && existingAttachmentIds.has(update.attachmentId));
    if (!allowed) {
      rejected.push(`media:${update.attachmentId}`);
      continue;
    }
    const index = next.media.findIndex((media) => media.attachmentId === update.attachmentId);
    if (index >= 0) {
      next.media[index] = {
        ...next.media[index],
        category: update.category,
        confidence: update.confidence,
        ...(update.label === null ? { label: undefined } : update.label ? { label: update.label } : {}),
        ...(update.selectedForPdf !== undefined ? { selectedForPdf: update.selectedForPdf } : {}),
        ...(update.sortOrder !== undefined ? { sortOrder: update.sortOrder } : {})
      };
    } else {
      const maxSortOrder = next.media.reduce((max, media) => Math.max(max, media.sortOrder), -1);
      const media: TripzProposalMedia = {
        attachmentId: update.attachmentId,
        category: update.category,
        confidence: update.confidence,
        sortOrder: update.sortOrder ?? maxSortOrder + 1,
        selectedForPdf: update.selectedForPdf ?? true,
        ...(update.label ? { label: update.label } : {})
      };
      next.media.push(media);
    }
    changed = true;
  }
  const selected = next.media
    .filter((media) => media.selectedForPdf)
    .sort((left, right) => Number(right.category === "cover") - Number(left.category === "cover")
      || left.sortOrder - right.sortOrder || left.attachmentId.localeCompare(right.attachmentId));
  const overflow = selected.slice(TRIPZ_MAX_SELECTED_MEDIA);
  for (const media of overflow) media.selectedForPdf = false;
  return { proposal: next, rejected, changed: changed || overflow.length > 0, autoDeselected: overflow.length };
}

function requestedActionFromMessage(
  message: string,
  currentStatus: TripzProposalState["status"]
): "none" | "show_summary" | "preview" | "pdf" {
  const text = message.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const compactText = text.trim().replace(/[.!?]+$/g, "").trim();
  if ((/\bpdf\b/.test(text) && /ger|cri|faz|export|baix|pode/.test(text))
    || (currentStatus === "ready_for_pdf" && /^(?:sim|confirmo|pode\s+gerar|gera|gerar|pode)$/i.test(compactText))) {
    return "pdf";
  }
  if (/\b(?:preview|previa|visualiz)/.test(text)) return "preview";
  if (/\b(?:resumo|revisao|mostr|exib)/.test(text) && /entend|proposta|antes|tudo|dados/.test(text)) return "show_summary";
  return "none";
}

const REQUIREMENT_CATALOG: Array<TripzGenerationRequirement & { aliases: string[] }> = [
  { path: "client.name", label: "nome do cliente", aliases: ["nome do cliente", "cliente"] },
  { path: "startDate", label: "data de início", aliases: ["data de inicio", "data da viagem"] },
  { path: "endDate", label: "data de término", aliases: ["data de termino", "data de volta"] },
  { path: "flights", label: "voos", aliases: ["voo", "voos", "aereo"] },
  { path: "hotel", label: "hospedagem", aliases: ["hotel", "hospedagem"] },
  { path: "hotel.name", label: "nome do hotel", aliases: ["nome do hotel"] },
  { path: "hotel.mealPlan", label: "regime de alimentação", aliases: ["regime", "cafe", "alimentacao"] },
  { path: "includedItems.insurance", label: "seguro", aliases: ["seguro"] },
  { path: "includedItems.transfer", label: "traslado", aliases: ["traslado", "transfer"] },
  { path: "pricing.totalPrice", label: "valor total", aliases: ["valor total", "preco total", "orcamento"] },
  { path: "pricing.pricePerPerson", label: "valor por pessoa", aliases: ["valor por pessoa", "preco por pessoa"] },
  { path: "itinerary", label: "roteiro", aliases: ["roteiro", "itinerario"] }
];

function normalizedWords(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function normalizedModelIssueCode(code: string): string {
  const safeCode = code.toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(?:MODEL_)+/, "");
  return `MODEL_${safeCode || "REVIEW_NEEDED"}`.slice(0, 80);
}

function modelIssueReportsMissingInformation(issue: Pick<TripzProposalIssue, "code" | "message">): boolean {
  const code = issue.code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (/(?:^|_)(?:MISSING|ABSENT|NOT_PROVIDED|NOT_INFORMED|UNPROVIDED|OMITTED)(?:_|$)/.test(code)) {
    return true;
  }
  if (
    /(?:^|_)(?:REQUIRED|NEEDED)(?:_|$)/.test(code)
    && !/(?:^|_)(?:CONFIRMATION|CONFLICT|DIVERGENCE|MISMATCH)(?:_|$)/.test(code)
  ) {
    return true;
  }
  const message = normalizedWords(issue.message);
  return /\b(?:nao\s+(?:(?:foi|foram|esta|estao)\s+)?(?:informad\w*|fornecid\w*|preenchid\w*|enviad\w*)|ausent\w*|falt(?:a|am|ando)\w*|precisa\s+(?:de|do|da|dos|das))\b/.test(message)
    || /\b(?:missing|required|not\s+(?:provided|informed|filled)|absent)\b/.test(message);
}

function normalizedCarriedIssue(issue: TripzProposalIssue): TripzProposalIssue {
  return issue.code.startsWith("MODEL_")
    ? { ...issue, code: normalizedModelIssueCode(issue.code) }
    : issue;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateGenerationRequirements(
  current: TripzGenerationRequirement[],
  configured: TripzAiTurnInput["requiredFields"],
  userMessage: string
): TripzGenerationRequirement[] {
  const message = normalizedWords(userMessage);
  const requirements = new Map(current.map((requirement) => [requirement.path, requirement]));
  for (const required of configured ?? []) {
    const catalog = REQUIREMENT_CATALOG.find((item) => item.path === required.path);
    if (!catalog) continue;
    requirements.set(catalog.path, {
      path: catalog.path,
      label: required.label?.trim() || catalog.label,
      ...(required.reason?.trim() ? { reason: required.reason.trim() } : {})
    });
  }
  for (const candidate of REQUIREMENT_CATALOG) {
    const alias = candidate.aliases.map(escapedPattern).join("|");
    const remove = new RegExp(`(?:nao\\s+(?:precisa|e\\s+mais\\s+(?:obrigatorio|necessario))|dispens\\w*|pode\\s+gerar\\s+sem).{0,40}(?:${alias})|(?:${alias}).{0,40}(?:nao\\s+e\\s+mais\\s+(?:obrigatorio|necessario)|pode\\s+ser\\s+dispens)`, "i").test(message);
    if (remove) {
      requirements.delete(candidate.path);
      continue;
    }
    const add = new RegExp(`(?:nao\\s+gere\\s+sem|so\\s+gere\\s+com|precis\\w*\\s+(?:de|do|da)|(?:obrigatorio|necessario|essencial)).{0,40}(?:${alias})|(?:${alias}).{0,40}(?:obrigatorio|necessario|essencial)`, "i").test(message);
    if (add) requirements.set(candidate.path, {
      path: candidate.path,
      label: candidate.label,
      reason: "Declarado como necessário pelo agente na conversa."
    });
  }
  return [...requirements.values()].slice(0, 30);
}

function compactProposal(proposal: TripzProposalState): Record<string, unknown> {
  return {
    schemaVersion: proposal.schemaVersion,
    title: proposal.title,
    client: proposal.client,
    destination: proposal.destination,
    startDate: proposal.startDate,
    endDate: proposal.endDate,
    passengers: proposal.passengers,
    flights: proposal.flights.slice(0, 30),
    hotel: proposal.hotel,
    media: proposal.media.slice(0, 50).map((media) => ({
      id: media.id,
      attachmentId: media.attachmentId,
      category: media.category,
      label: media.label,
      confidence: media.confidence,
      sortOrder: media.sortOrder,
      selectedForPdf: media.selectedForPdf
    })),
    includedItems: proposal.includedItems.slice(0, 50),
    pricing: proposal.pricing,
    itinerary: proposal.itinerary.slice(0, 60),
    notes: proposal.notes.slice(-50),
    generationRequirements: proposal.generationRequirements,
    missingInformation: proposal.missingInformation,
    inconsistencies: proposal.inconsistencies
      .filter((issue) => !modelIssueReportsMissingInformation(issue))
      .map(normalizedCarriedIssue),
    status: proposal.status
  };
}

function trimTo(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 30))}\n[conteúdo anterior truncado]`;
}

function buildUserContext(input: TripzAiTurnInput, maxCharacters: number): string {
  const proposalJson = JSON.stringify(compactProposal(input.proposal));
  const attachmentManifest = (input.attachments ?? []).map((attachment) => ({
    attachmentId: attachment.attachmentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    hasRawContent: Boolean(attachment.base64),
    hasExtractedText: Boolean(attachment.extractedText)
  }));
  const fixedParts = [
    TRIPZ_AI_ATTACHMENT_BOUNDARY_NOTICE,
    `<tripz_proposal_state>${proposalJson}</tripz_proposal_state>`,
    `<tripz_attachment_manifest>${JSON.stringify(attachmentManifest)}</tripz_attachment_manifest>`,
    `<tripz_current_user_message>${input.userMessage}</tripz_current_user_message>`
  ];
  const fixedLength = fixedParts.reduce((total, part) => total + part.length + 1, 0);
  const summaryBudget = Math.max(0, Math.min(8_000, maxCharacters - fixedLength));
  const summary = input.sessionSummary?.trim()
    ? `<tripz_session_summary>${trimTo(input.sessionSummary.trim(), summaryBudget)}</tripz_session_summary>`
    : "";
  return [...fixedParts.slice(0, 1), summary, ...fixedParts.slice(1)].filter(Boolean).join("\n");
}

function selectRecentHistory(
  messages: readonly { role: "user" | "assistant"; content: string }[],
  maxMessages: number,
  availableCharacters: number
): Array<{ role: "user" | "assistant"; content: string }> {
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let used = 0;
  for (const message of messages.slice(-maxMessages).reverse()) {
    if (!message.content.trim()) continue;
    if (used + message.content.length > availableCharacters) break;
    selected.unshift({ role: message.role, content: message.content });
    used += message.content.length;
  }
  return selected;
}

function hasMaterialPatch(patch: TripzAiProposalPatch): boolean {
  return Object.keys(patch).length > 0;
}

function issueResolvedBy(issue: TripzProposalIssue, corrections: readonly TripzExplicitCorrectionPath[]): boolean {
  const issuePath = issue.path;
  if (!issuePath) return false;
  return corrections.some((path) => issuePath === path || issuePath.startsWith(`${path}.`) || path.startsWith(`${issuePath}.`));
}

function patchHasPath(patch: TripzAiProposalPatch, path: TripzExplicitCorrectionPath): boolean {
  let current: unknown = patch;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

function valueAtPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function issueCorrectedByPatch(
  issue: TripzProposalIssue,
  corrections: readonly TripzExplicitCorrectionPath[],
  patch: TripzAiProposalPatch,
  before: TripzProposalState,
  after: TripzProposalState
): boolean {
  return corrections.some((path) => issueResolvedBy(issue, [path]) && patchHasPath(patch, path)
    && JSON.stringify(valueAtPath(before, issue.path ?? path)) !== JSON.stringify(valueAtPath(after, issue.path ?? path)));
}

function issueHasResolutionPath(issue: TripzProposalIssue): boolean {
  const issuePath = issue.path;
  if (!issuePath) return false;
  return tripzExplicitCorrectionPathSchema.options.some((path) =>
    issuePath === path || issuePath.startsWith(`${path}.`) || path.startsWith(`${issuePath}.`)
  );
}

function explicitlyConfirmsIssue(message: string): boolean {
  const normalized = normalizedWords(message);
  if (/\b(?:nao|nunca)\b.{0,24}\b(?:confirm\w*|mantenh\w*|manter|corret\w*|consider\w*)\b/.test(normalized)
    || /\b(?:valor\s+total|valor\s+final|preco)\b.{0,24}\bnao\s+(?:esta\s+)?corret\w*\b/.test(normalized)) {
    return false;
  }
  return /\b(?:confirmo|confirmado|mantenha|manter|correto|correta|pode\s+considerar)\b/.test(normalized);
}

export function formatTripzProposalSummary(proposal: TripzProposalState): string {
  const passengerCount = (proposal.passengers?.adults ?? 0)
    + (proposal.passengers?.children ?? 0)
    + (proposal.passengers?.infants ?? 0);
  const lines = [
    "Proposta pronta para revisão",
    `Destino: ${proposal.destination ?? "não informado"}`,
    `Passageiros: ${passengerCount || "não informado"}`,
    `Voos: ${proposal.flights.length} trecho(s)`,
    `Hotel: ${proposal.hotel?.name ?? "não informado"}`,
    `Acomodação: ${proposal.hotel?.roomType ?? "não informada"}`,
    `Regime: ${proposal.hotel?.mealPlan ?? "não informado"}`,
    `Imagens selecionadas: ${proposal.media.filter((media) => media.selectedForPdf).length}`,
    `Valor por pessoa: ${proposal.pricing?.pricePerPerson ?? "não informado"} ${proposal.pricing?.currency ?? ""}`.trim(),
    `Taxa de embarque: ${proposal.pricing?.boardingTax ?? "não informada"} ${proposal.pricing?.currency ?? ""}`.trim(),
    `Roteiro: ${proposal.itinerary.length ? `${proposal.itinerary.length} dia(s)` : "não informado"}`
  ];
  return lines.join("\n");
}

export class TripzConversationOrchestrator {
  private readonly contextBudgetCharacters: number;
  private readonly maxHistoryMessages: number;

  constructor(
    private readonly client: TripzStructuredAiClient,
    options: TripzAiOrchestratorOptions = {}
  ) {
    this.contextBudgetCharacters = options.contextBudgetCharacters ?? 48_000;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 8;
  }

  async processTurn(input: TripzAiTurnInput): Promise<TripzAiTurnResult> {
    const userContent = buildUserContext(input, this.contextBudgetCharacters);
    const history = selectRecentHistory(
      input.recentMessages ?? [],
      this.maxHistoryMessages,
      Math.max(0, this.contextBudgetCharacters - userContent.length - TRIPZ_AI_SYSTEM_PROMPT.length)
    );
    const completion = await this.client.completeStructured({
      conversationId: input.conversationId,
      userContent,
      history,
      attachments: input.attachments,
      systemPrompt: TRIPZ_AI_SYSTEM_PROMPT,
      budget: input.budget,
      onUsage: input.onUsage
    });
    const output = completion.output;
    const acceptedCorrections = output.explicitCorrections.filter((path) => correctionSupported(path, input.userMessage));
    const conflicts = detectTripzPatchConflicts(input.proposal, output.proposalPatch, acceptedCorrections);
    let next = applyAllowlistedTripzPatch(input.proposal, output.proposalPatch, conflicts.conflictingPaths);
    const mediaResult = applyMediaUpdates(next, output, input.attachments ?? [], input.userMessage);
    next = mediaResult.proposal;
    next.generationRequirements = updateGenerationRequirements(
      next.generationRequirements,
      input.requiredFields,
      input.userMessage
    );
    const materialChange = hasMaterialPatch(output.proposalPatch) || mediaResult.changed;

    const carriedIssues = input.proposal.inconsistencies
      .filter((issue) =>
        (issue.code === "HOTEL_MEAL_PLAN_CONFLICT" || issue.code.startsWith("MODEL_"))
        && !modelIssueReportsMissingInformation(issue)
        && issue.severity === "critical" && issue.requiresConfirmation
        && issueHasResolutionPath(issue)
        && !issueCorrectedByPatch(issue, acceptedCorrections, output.proposalPatch, input.proposal, next)
      )
      .map(normalizedCarriedIssue);
    const modelIssues: TripzProposalIssue[] = output.issues
      // Missing fields are owned by validateTripzProposal. Treating a model hint as
      // a durable critical conflict can keep asking for a value that is already in state.
      .filter((issue) => !modelIssueReportsMissingInformation(issue))
      .map((issue) => ({
        code: normalizedModelIssueCode(issue.code),
        ...(issue.path ? { path: issue.path } : {}),
        message: issue.message,
        severity: issue.severity,
        requiresConfirmation: issue.severity === "critical"
      }));
    let validation = validateTripzProposal(next, {
      requiredFields: next.generationRequirements,
      additionalIssues: [...carriedIssues, ...conflicts.issues, ...modelIssues]
    });
    next = validation.proposal;
    if (acceptedCorrections.length > 0 && explicitlyConfirmsIssue(input.userMessage)) {
      const proposalFingerprint = tripzProposalContentFingerprint(next);
      const acknowledgedIssue = validation.issues.find((issue) =>
        issue.severity === "critical" && issue.requiresConfirmation
        && issueHasResolutionPath(issue) && issueResolvedBy(issue, acceptedCorrections)
      );
      const acknowledgements = acknowledgedIssue ? [{
          code: acknowledgedIssue.code,
          ...(acknowledgedIssue.path ? { path: acknowledgedIssue.path } : {}),
          proposalFingerprint
        }] : [];
      if (acknowledgements.length > 0) {
        next.issueAcknowledgements = [
          ...next.issueAcknowledgements.filter((current) =>
            !acknowledgements.some((item) => item.code === current.code && item.path === current.path)
          ),
          ...acknowledgements
        ].slice(-100);
        validation = validateTripzProposal(next, {
          requiredFields: next.generationRequirements,
          additionalIssues: [...carriedIssues, ...conflicts.issues, ...modelIssues]
        });
        next = validation.proposal;
      }
    }
    const requestedAction = requestedActionFromMessage(input.userMessage, input.proposal.status);
    let assistantMessage = output.assistantMessage;
    let documentGenerationAllowed = false;
    let generationBlockedReason: TripzAiTurnResult["generationBlockedReason"];

    const criticalIssue = validation.issues.find((issue) => issue.severity === "critical" && issue.requiresConfirmation);
    if (criticalIssue) {
      assistantMessage = `${criticalIssue.message} Qual informação devo manter?`;
    }
    if (mediaResult.autoDeselected > 0) {
      assistantMessage += `\n\nMantive ${TRIPZ_MAX_SELECTED_MEDIA} imagens selecionadas para o documento e deixei ${mediaResult.autoDeselected} fora para preservar a qualidade da prévia.`;
    }
    if (requestedAction === "show_summary") {
      if (validation.canGenerate) {
        next.status = "ready_for_pdf";
        assistantMessage = `${formatTripzProposalSummary(next)}\n\nQuer alterar alguma coisa ou posso gerar a prévia?`;
      } else {
        generationBlockedReason = "missing_or_conflicting_information";
        const first = validation.blockingReasons[0] ?? "informações críticas";
        assistantMessage = `Ainda não consigo preparar a geração. Primeiro, preciso confirmar ${first}.`;
      }
    } else if (requestedAction === "preview" || requestedAction === "pdf") {
      if (!validation.canGenerate) {
        generationBlockedReason = "missing_or_conflicting_information";
        const first = validation.blockingReasons[0] ?? "informações críticas";
        assistantMessage = `Ainda não posso gerar ${requestedAction === "pdf" ? "o PDF" : "a prévia"}. Primeiro, preciso confirmar ${first}.`;
      } else if (input.proposal.status !== "ready_for_pdf" || materialChange) {
        next.status = "ready_for_pdf";
        generationBlockedReason = "summary_confirmation_required";
        assistantMessage = `${formatTripzProposalSummary(next)}\n\nConfira o resumo e confirme se posso gerar ${requestedAction === "pdf" ? "o PDF" : "a prévia"}.`;
      } else {
        next.status = "ready_for_pdf";
        documentGenerationAllowed = true;
      }
    }

    const normalizedValidation: TripzProposalValidationResult = {
      ...validation,
      proposal: next
    };
    return {
      assistantMessage,
      summary: output.summary || input.sessionSummary?.trim() || "",
      proposal: next,
      validation: normalizedValidation,
      requestedAction,
      documentGenerationAllowed,
      generationBlockedReason,
      rejectedChanges: mediaResult.rejected,
      usage: completion.usage,
      budget: completion.budget,
      fileAnnotations: completion.fileAnnotations
    };
  }
}

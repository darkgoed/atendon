import { ApiError, api } from "./api";
import { shouldSubmitOnEnter } from "./compat";

export const TRIPZ_AI_BASE_PATH = "/tripz-ai";
export const TRIPZ_AI_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
export const TRIPZ_AI_MAX_FILES_PER_MESSAGE = 10;
export const TRIPZ_AI_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const TRIPZ_AI_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const TRIPZ_AI_MAX_TOTAL_BYTES_PER_MESSAGE = 40 * 1024 * 1024;

export const tripzConversationStatuses = [
  "collecting",
  "ready_for_review",
  "ready_for_pdf",
  "pdf_generated"
] as const;

export type TripzConversationStatus = (typeof tripzConversationStatuses)[number];
export type TripzProcessingStatus = "idle" | "queued" | "processing" | "failed";
export type TripzAttachmentStatus = "pending" | "queued" | "processing" | "processed" | "needs_review" | "failed";

export type TripzConversation = {
  id: string;
  title: string;
  status: TripzConversationStatus;
  processingStatus: TripzProcessingStatus;
  processingErrorCode?: string;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
};

export type TripzAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  processingStatus: TripzAttachmentStatus;
  category?: string;
  label?: string;
  selectedForPdf?: boolean;
};

export type TripzMessageRole = "user" | "assistant" | "system";

export type TripzMessage = {
  id: string;
  role: TripzMessageRole;
  content: string;
  createdAt: string;
  attachments: TripzAttachment[];
  metadata: Record<string, unknown>;
  processingStatus: "pending" | "queued" | "processing" | "completed" | "failed";
};

export type TripzProposal = {
  id?: string;
  revision: number;
  status: TripzConversationStatus;
  title?: string;
  clientName?: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
  missingInformation: string[];
  inconsistencies: string[];
  state: Record<string, unknown>;
  updatedAt?: string;
};

export function selectLatestTripzProposal(
  standalone: TripzProposal | undefined,
  embedded: TripzProposal | undefined
): TripzProposal | undefined {
  if (!standalone) return embedded;
  if (!embedded) return standalone;
  return embedded.revision > standalone.revision ? embedded : standalone;
}

export type TripzDocument = {
  id?: string;
  kind: "preview" | "pdf";
  proposalRevision?: number;
  status: "queued" | "processing" | "ready" | "failed";
  html?: string;
  filename?: string;
  error?: string;
};

export type TripzConversationDetail = {
  conversation: TripzConversation;
  messages?: TripzMessage[];
  proposal?: TripzProposal;
  documents?: TripzDocument[];
};

export type TripzConversationList = {
  conversations: TripzConversation[];
  nextCursor?: string;
};

export type TripzMessageList = {
  messages: TripzMessage[];
  nextCursor?: string;
};

export type TripzSendResult = {
  message?: TripzMessage;
  conversation?: TripzConversation;
  proposal?: TripzProposal;
};

export type TripzFileValidation = {
  accepted: File[];
  rejected: Array<{ file: File; reason: string }>;
};

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (isRecord(source[key])) return source[key];
  }
  return undefined;
}

function arrayValue(source: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}

function stringValue(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function booleanValue(source: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key];
  }
  return undefined;
}

function normalizeConversationStatus(value: unknown): TripzConversationStatus {
  if (value === "ready_for_review" || value === "ready_for_pdf" || value === "pdf_generated") return value;
  return "collecting";
}

function normalizeProcessingStatus(value: unknown): TripzProcessingStatus {
  if (value === "queued" || value === "processing" || value === "failed") return value;
  return "idle";
}

function normalizeAttachmentStatus(value: unknown): TripzAttachmentStatus {
  if (value === "queued" || value === "processing" || value === "processed" || value === "needs_review" || value === "failed") return value;
  return "pending";
}

function normalizeIssueList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (!isRecord(item)) return [];
    const label = stringValue(item, "label", "message", "description", "field", "code");
    return label ? [label] : [];
  });
}

function unwrapRecord(payload: unknown, ...keys: string[]): Record<string, unknown> {
  if (!isRecord(payload)) throw new ApiError("Resposta inválida da Tripz IA", 502, payload);
  return nestedRecord(payload, ...keys) ?? payload;
}

export function normalizeTripzAttachment(payload: unknown): TripzAttachment {
  const source = unwrapRecord(payload, "attachment");
  const id = stringValue(source, "id", "attachmentId", "attachment_id");
  if (!id) throw new ApiError("Anexo sem identificador", 502, payload);
  return {
    id,
    filename: stringValue(source, "filename", "fileName", "file_name", "name") ?? "Arquivo",
    mimeType: stringValue(source, "mimeType", "mime_type", "contentType", "content_type") ?? "application/octet-stream",
    size: numberValue(source, "size", "sizeBytes", "size_bytes", "byteSize", "byte_size") ?? 0,
    processingStatus: normalizeAttachmentStatus(source.processingStatus ?? source.processing_status ?? source.status),
    category: stringValue(source, "category"),
    label: stringValue(source, "label"),
    selectedForPdf: booleanValue(source, "selectedForPdf", "selected_for_pdf")
  };
}

export function normalizeTripzMessage(payload: unknown): TripzMessage {
  const source = unwrapRecord(payload, "message");
  const id = stringValue(source, "id", "messageId", "message_id");
  if (!id) throw new ApiError("Mensagem sem identificador", 502, payload);
  const rawRole = stringValue(source, "role");
  const role: TripzMessageRole = rawRole === "assistant" || rawRole === "system" ? rawRole : "user";
  return {
    id,
    role,
    content: stringValue(source, "content", "text", "message") ?? "",
    createdAt: stringValue(source, "createdAt", "created_at") ?? new Date(0).toISOString(),
    attachments: arrayValue(source, "attachments").flatMap((item) => {
      try { return [normalizeTripzAttachment(item)]; } catch { return []; }
    }),
    metadata: nestedRecord(source, "metadata") ?? {},
    processingStatus: source.processingStatus === "queued" || source.processing_status === "queued"
      ? "queued"
      : source.processingStatus === "processing" || source.processing_status === "processing"
        ? "processing"
        : source.processingStatus === "failed" || source.processing_status === "failed"
          ? "failed"
          : source.processingStatus === "pending" || source.processing_status === "pending"
            ? "pending"
            : "completed"
  };
}

export function normalizeTripzConversation(payload: unknown): TripzConversation {
  const source = unwrapRecord(payload, "conversation");
  const id = stringValue(source, "id", "conversationId", "conversation_id");
  if (!id) throw new ApiError("Proposta sem identificador", 502, payload);
  const createdAt = stringValue(source, "createdAt", "created_at") ?? new Date(0).toISOString();
  return {
    id,
    title: stringValue(source, "title") ?? "Nova proposta",
    status: normalizeConversationStatus(source.status),
    processingStatus: normalizeProcessingStatus(
      source.processingStatus ?? source.processing_status ?? source.turnStatus ?? source.turn_status
    ),
    processingErrorCode: stringValue(source, "processingErrorCode", "processing_error_code"),
    lastMessagePreview: stringValue(source, "lastMessagePreview", "last_message_preview", "preview", "summary"),
    createdAt,
    updatedAt: stringValue(source, "updatedAt", "updated_at") ?? createdAt
  };
}

export function normalizeTripzProposal(payload: unknown): TripzProposal {
  const envelope = unwrapRecord(payload, "proposal");
  const state = nestedRecord(envelope, "state", "proposalState", "proposal_state", "data") ?? envelope;
  const client = nestedRecord(state, "client");
  return {
    id: stringValue(envelope, "id", "proposalId", "proposal_id"),
    revision: numberValue(envelope, "revision", "version") ?? 0,
    status: normalizeConversationStatus(envelope.status ?? state.status),
    title: stringValue(state, "title") ?? stringValue(envelope, "title"),
    clientName: client ? stringValue(client, "name") : stringValue(state, "clientName", "client_name"),
    destination: stringValue(state, "destination"),
    startDate: stringValue(state, "startDate", "start_date"),
    endDate: stringValue(state, "endDate", "end_date"),
    missingInformation: normalizeIssueList(
      state.missingInformation ?? state.missing_information ?? envelope.missingInformation ?? envelope.missing_information
    ),
    inconsistencies: normalizeIssueList(state.inconsistencies ?? envelope.inconsistencies),
    state,
    updatedAt: stringValue(envelope, "updatedAt", "updated_at")
  };
}

export function normalizeTripzDocument(payload: unknown, fallbackKind: "preview" | "pdf"): TripzDocument {
  const envelope = unwrapRecord(payload);
  const source = nestedRecord(envelope, "document", fallbackKind) ?? envelope;
  const rawStatus = stringValue(source, "status");
  const status = rawStatus === "queued" || rawStatus === "processing" || rawStatus === "failed"
    ? rawStatus
    : "ready";
  return {
    id: stringValue(source, "id", "documentId", "document_id", `${fallbackKind}Id`, `${fallbackKind}_id`),
    kind: stringValue(source, "kind") === "pdf" ? "pdf" : fallbackKind,
    proposalRevision: numberValue(source, "proposalRevision", "proposal_revision"),
    status,
    html: stringValue(envelope, "html", "previewHtml", "preview_html")
      ?? stringValue(source, "html", "previewHtml", "preview_html", "content"),
    filename: stringValue(source, "filename", "fileName", "file_name"),
    error: stringValue(source, "error", "errorMessage", "error_message")
  };
}

export function tripzConversationStatusLabel(status: TripzConversationStatus): string {
  if (status === "ready_for_review") return "Pronta para revisão";
  if (status === "ready_for_pdf") return "Pronta para PDF";
  if (status === "pdf_generated") return "PDF gerado";
  return "Em coleta";
}

export function tripzProcessingStatusLabel(status: TripzProcessingStatus): string {
  if (status === "queued") return "Na fila";
  if (status === "processing") return "Analisando dados";
  if (status === "failed") return "Processamento interrompido";
  return "Aguardando informações";
}

export function tripzAttachmentStatusLabel(status: TripzAttachmentStatus): string {
  if (status === "queued") return "Na fila";
  if (status === "processing") return "Analisando";
  if (status === "processed") return "Processado";
  if (status === "needs_review") return "Requer revisão";
  if (status === "failed") return "Falha no processamento";
  return "Recebido";
}

export function formatTripzFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

export function formatTripzTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function validateTripzFiles(
  files: readonly File[],
  remainingSlots = TRIPZ_AI_MAX_FILES_PER_MESSAGE,
  currentBytes = 0
): TripzFileValidation {
  const accepted: File[] = [];
  const rejected: Array<{ file: File; reason: string }> = [];
  let totalBytes = currentBytes;
  for (const file of files) {
    if (accepted.length >= Math.max(0, remainingSlots)) {
      rejected.push({ file, reason: `Limite de ${TRIPZ_AI_MAX_FILES_PER_MESSAGE} anexos por mensagem.` });
      continue;
    }
    if (!allowedMimeTypes.has(file.type)) {
      rejected.push({ file, reason: "Formato não aceito. Use JPEG, PNG, WebP ou PDF." });
      continue;
    }
    const limit = file.type === "application/pdf" ? TRIPZ_AI_MAX_PDF_BYTES : TRIPZ_AI_MAX_IMAGE_BYTES;
    if (file.size <= 0) {
      rejected.push({ file, reason: "O arquivo está vazio." });
      continue;
    }
    if (file.size > limit) {
      rejected.push({
        file,
        reason: file.type === "application/pdf" ? "PDF maior que 20 MB." : "Imagem maior que 10 MB."
      });
      continue;
    }
    if (totalBytes + file.size > TRIPZ_AI_MAX_TOTAL_BYTES_PER_MESSAGE) {
      rejected.push({ file, reason: "O conjunto de anexos excede o limite total de 40 MB." });
      continue;
    }
    accepted.push(file);
    totalBytes += file.size;
  }
  return { accepted, rejected };
}

export function shouldSubmitTripzComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  compositionActive?: boolean;
  compositionJustEnded?: boolean;
}): boolean {
  return shouldSubmitOnEnter(input);
}

export function createTripzIdempotencyKey(prefix = "tripz"): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
}

export function tripzAttachmentContentPath(conversationId: string, attachmentId: string): string {
  return `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

export function tripzDocumentContentPath(conversationId: string, documentId: string): string {
  return `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}/content`;
}

export function tripzApiContentUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}${path}`;
}

export async function listTripzConversations(cursor?: string): Promise<TripzConversationList> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const payload = await api<unknown>(`${TRIPZ_AI_BASE_PATH}/conversations${query}`);
  const source = isRecord(payload) ? payload : {};
  const rawItems = Array.isArray(payload) ? payload : arrayValue(source, "conversations", "items", "data");
  return {
    conversations: rawItems.flatMap((item) => {
      try { return [normalizeTripzConversation(item)]; } catch { return []; }
    }),
    nextCursor: stringValue(source, "nextCursor", "next_cursor", "cursor")
  };
}

export async function createTripzConversation(): Promise<TripzConversation> {
  const payload = await api<unknown>(`${TRIPZ_AI_BASE_PATH}/conversations`, {
    method: "POST",
    body: JSON.stringify({})
  });
  return normalizeTripzConversation(payload);
}

export async function getTripzConversation(conversationId: string): Promise<TripzConversationDetail> {
  const payload = await api<unknown>(`${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}`);
  const envelope = unwrapRecord(payload);
  const conversation = normalizeTripzConversation(nestedRecord(envelope, "conversation") ?? envelope);
  const rawProposal = nestedRecord(envelope, "proposal");
  const attachmentsByMessage = new Map<string, TripzAttachment[]>();
  for (const item of arrayValue(envelope, "attachments")) {
    if (!isRecord(item)) continue;
    const messageId = stringValue(item, "messageId", "message_id");
    if (!messageId) continue;
    try {
      const attachment = normalizeTripzAttachment(item);
      attachmentsByMessage.set(messageId, [...(attachmentsByMessage.get(messageId) ?? []), attachment]);
    } catch {
      // Um anexo malformado não deve ocultar o restante da conversa válida.
    }
  }
  return {
    conversation,
    messages: arrayValue(envelope, "messages").flatMap((item) => {
      try {
        const message = normalizeTripzMessage(item);
        return [{ ...message, attachments: message.attachments.length ? message.attachments : attachmentsByMessage.get(message.id) ?? [] }];
      } catch { return []; }
    }),
    proposal: rawProposal ? normalizeTripzProposal(rawProposal) : undefined,
    documents: arrayValue(envelope, "documents").flatMap((item) => {
      try { return [normalizeTripzDocument(item, "preview")]; } catch { return []; }
    })
  };
}

export async function deleteTripzConversation(conversationId: string): Promise<void> {
  await api(`${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

export async function renameTripzConversation(conversationId: string, title: string): Promise<TripzConversation> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}`,
    { method: "PATCH", body: JSON.stringify({ title }) }
  );
  return normalizeTripzConversation(payload);
}

export async function listTripzMessages(conversationId: string, cursor?: string): Promise<TripzMessageList> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/messages${query}`
  );
  const source = isRecord(payload) ? payload : {};
  const rawItems = Array.isArray(payload) ? payload : arrayValue(source, "messages", "items", "data");
  return {
    messages: rawItems.flatMap((item) => {
      try { return [normalizeTripzMessage(item)]; } catch { return []; }
    }),
    nextCursor: stringValue(source, "nextCursor", "next_cursor", "cursor")
  };
}

export async function getTripzProposal(conversationId: string): Promise<TripzProposal> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/proposal`
  );
  return normalizeTripzProposal(payload);
}

export async function patchTripzProposal(
  conversationId: string,
  expectedRevision: number,
  patch: Record<string, unknown>
): Promise<TripzProposal> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/proposal`,
    { method: "PATCH", body: JSON.stringify({ expectedRevision, patch }) }
  );
  return normalizeTripzProposal(payload);
}

export async function uploadTripzAttachment(
  conversationId: string,
  file: File,
  signal?: AbortSignal
): Promise<TripzAttachment> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type,
        "X-File-Name": encodeURIComponent(file.name),
        "X-Tripz-File-Name": encodeURIComponent(file.name)
      },
      body: file,
      signal
    }
  );
  return normalizeTripzAttachment(payload);
}

export async function deleteTripzAttachment(conversationId: string, attachmentId: string): Promise<void> {
  await api(tripzAttachmentContentPath(conversationId, attachmentId).replace(/\/content$/, ""), { method: "DELETE" });
}

export async function sendTripzMessage(
  conversationId: string,
  input: { content: string; attachmentIds: string[]; idempotencyKey?: string }
): Promise<TripzSendResult> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey ?? createTripzIdempotencyKey("message") },
      body: JSON.stringify({ content: input.content, attachmentIds: input.attachmentIds })
    }
  );
  const source = isRecord(payload) ? payload : {};
  const rawMessage = nestedRecord(source, "message");
  const rawConversation = nestedRecord(source, "conversation");
  const rawProposal = nestedRecord(source, "proposal");
  return {
    message: rawMessage ? normalizeTripzMessage(rawMessage) : undefined,
    conversation: rawConversation ? normalizeTripzConversation(rawConversation) : undefined,
    proposal: rawProposal ? normalizeTripzProposal(rawProposal) : undefined
  };
}

export async function retryTripzMessage(conversationId: string, messageId: string): Promise<TripzSendResult> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/retry`,
    { method: "POST" }
  );
  const source = isRecord(payload) ? payload : {};
  const rawMessage = nestedRecord(source, "message");
  return { message: rawMessage ? normalizeTripzMessage(rawMessage) : undefined };
}

export async function generateTripzPreview(conversationId: string, expectedRevision: number): Promise<TripzDocument> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/preview`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision })
    }
  );
  return normalizeTripzDocument(payload, "preview");
}

export async function generateTripzPdf(conversationId: string, expectedRevision: number): Promise<TripzDocument> {
  const payload = await api<unknown>(
    `${TRIPZ_AI_BASE_PATH}/conversations/${encodeURIComponent(conversationId)}/pdf`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision })
    }
  );
  return normalizeTripzDocument(payload, "pdf");
}

export async function fetchTripzDocumentHtml(conversationId: string, documentId: string): Promise<string> {
  return api<string>(tripzDocumentContentPath(conversationId, documentId));
}

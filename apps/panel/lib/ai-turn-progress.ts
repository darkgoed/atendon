export const AI_TURN_PHASES = [
  "reading",
  "analyzing_media",
  "generating",
  "using_tool",
  "preview",
  "sending",
  "cleared"
] as const;

export type AiTurnPhase = typeof AI_TURN_PHASES[number];

export interface AiTurnProgress {
  type: "conversation.ai.progress";
  conversationId: string;
  turnId: string;
  attempt: number;
  revision: number;
  phase: AiTurnPhase;
  label?: string;
  preview?: string;
  previewTruncated?: boolean;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

const phaseSet = new Set<string>(AI_TURN_PHASES);
const progressKeys = new Set([
  "type", "conversationId", "turnId", "attempt", "revision", "phase", "label",
  "preview", "previewTruncated", "startedAt", "updatedAt", "expiresAt"
]);

export function parseAiTurnProgress(value: unknown): AiTurnProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !progressKeys.has(key))) return null;
  if (
    item.type !== "conversation.ai.progress"
    || typeof item.conversationId !== "string"
    || typeof item.turnId !== "string"
    || !Number.isInteger(item.attempt) || Number(item.attempt) < 1
    || !Number.isInteger(item.revision) || Number(item.revision) < 0
    || typeof item.phase !== "string" || !phaseSet.has(item.phase)
    || typeof item.startedAt !== "string" || !Number.isFinite(Date.parse(item.startedAt))
    || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))
    || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))
    || (item.label !== undefined && (typeof item.label !== "string" || item.label.length > 160))
    || (item.preview !== undefined && (typeof item.preview !== "string" || item.preview.length > 12_000))
    || (item.previewTruncated !== undefined && typeof item.previewTruncated !== "boolean")
  ) return null;
  return item as unknown as AiTurnProgress;
}

export function compareAiTurnProgress(left: AiTurnProgress, right: AiTurnProgress): number {
  const startedAt = Date.parse(left.startedAt) - Date.parse(right.startedAt);
  if (startedAt) return startedAt;
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.turnId.localeCompare(right.turnId);
}

export function reconcileAiTurnProgress(
  current: AiTurnProgress | null,
  incoming: AiTurnProgress,
  now = Date.now()
): AiTurnProgress | null {
  if (Date.parse(incoming.expiresAt) <= now) return current;
  if (current && compareAiTurnProgress(incoming, current) < 0) return current;
  return incoming.phase === "cleared" ? null : incoming;
}

export function aiTurnProgressSatisfiedByMessages(
  progress: AiTurnProgress,
  messages: readonly { sender: string; content: string; created_at: string }[]
): boolean {
  if (!progress.preview) return false;
  const startedAt = Date.parse(progress.startedAt);
  return messages.some((message) =>
    message.sender === "agent"
    && Date.parse(message.created_at) >= startedAt
    && progress.preview!.includes(message.content.trim())
  );
}

export function aiTurnPhaseLabel(progress: AiTurnProgress): string {
  if (progress.label) return progress.label;
  switch (progress.phase) {
    case "reading": return "Lendo a conversa…";
    case "analyzing_media": return "Analisando a mídia…";
    case "generating": return "Preparando uma resposta…";
    case "using_tool": return "Consultando informações…";
    case "preview": return "Prévia · ainda não enviada";
    case "sending": return "Enviando resposta…";
    case "cleared": return "";
  }
}

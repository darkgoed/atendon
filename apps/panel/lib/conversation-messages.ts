export interface CursorMessage {
  id: string;
  created_at: string;
}

export interface SessionScopedConversation {
  session_id?: string | null;
}

export interface ConnectionLabel {
  id: string;
  label: string;
}

export function shouldShowConversationConnectionFilter(connections: readonly { id: string }[]): boolean {
  return connections.length >= 2;
}

export function filterConversationsByConnection<T extends SessionScopedConversation>(
  conversations: readonly T[],
  sessionId: string
): T[] {
  return sessionId ? conversations.filter((conversation) => conversation.session_id === sessionId) : [...conversations];
}

export function conversationLabelForSession(
  conversation: SessionScopedConversation | null | undefined,
  connections: readonly ConnectionLabel[]
): string | null {
  if (!conversation?.session_id) return null;
  return connections.find((connection) => connection.id === conversation.session_id)?.label ?? null;
}

const localDayFormatters = new Map<string, Intl.DateTimeFormat>();

function messageLocalDay(createdAt: string, timezone: string): string {
  let formatter = localDayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    localDayFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(createdAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousCalendarDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

export function conversationMessageDateSeparator(
  message: CursorMessage,
  previousMessage: CursorMessage | undefined,
  timezone: string,
  now = new Date()
): string | null {
  const day = messageLocalDay(message.created_at, timezone);
  if (previousMessage && messageLocalDay(previousMessage.created_at, timezone) === day) return null;

  const today = messageLocalDay(now.toISOString(), timezone);
  if (day === today) return "Hoje";
  if (day === previousCalendarDay(today)) return "Ontem";

  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
}

export function scrollTopAfterPrepend(
  previousTop: number,
  previousHeight: number,
  nextHeight: number
): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function clearedConversationDeltaPagination() {
  return {
    beforeCursor: null,
    afterCursor: null,
    hasMoreBefore: false
  } as const;
}

export function mergeConversationMessages<T extends CursorMessage>(
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const byTime = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    return byTime || left.id.localeCompare(right.id);
  });
}

export function conversationMessagesV2Path(
  conversationId: string,
  query: { limit?: number; before?: string; after?: string } = {}
): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.before) params.set("before", query.before);
  if (query.after) params.set("after", query.after);
  const suffix = params.toString();
  return `/conversations/${encodeURIComponent(conversationId)}/messages/v2${suffix ? `?${suffix}` : ""}`;
}

export function conversationMessagesLegacyPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}/messages`;
}

export function conversationMessagesPath(
  conversationId: string,
  deltaEnabled: boolean
): string {
  return deltaEnabled
    ? conversationMessagesV2Path(conversationId, { limit: 100 })
    : conversationMessagesLegacyPath(conversationId);
}

export function conversationFallbackPollingDelay(input: {
  deltaEnabled: boolean;
  failures: number;
  visibilityState: string;
}): number | null {
  if (input.visibilityState !== "visible") return null;
  const baseMs = input.deltaEnabled ? 5_000 : 15_000;
  return Math.min(15_000, baseMs * (2 ** Math.min(10, Math.max(0, input.failures))));
}

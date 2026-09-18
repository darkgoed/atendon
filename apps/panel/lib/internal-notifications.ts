/**
 * Contrato: GET /me/internal-notifications?limit=30&cursor&unread
 *           POST /me/internal-notifications/:id/read
 *           POST /me/internal-notifications/read-all
 * (specs/active/v6-evolucao-estrutural-atendon.md — Contratos de API)
 */

export type InternalNotificationType =
  | "mention"
  | "task_assigned"
  | "note_directed"
  | "transfer"
  | "internal_message"
  | "internal_change";

export type InternalNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  source_type: string | null;
  source_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  read_at: string | null;
  created_at: string;
};

export type InternalNotificationsPage = {
  has_more: boolean;
  next_cursor: string | null;
};

export type InternalNotificationsResponse = {
  items: InternalNotification[];
  total_unread: number;
  page: InternalNotificationsPage;
};

/** Path de listagem do sino (só não lidas; poll curto, sem realtime v1). */
export const INTERNAL_NOTIFICATIONS_PATH = "/me/internal-notifications?limit=30&unread";

/**
 * Link por source_type: lead → /contatos/:id (a rota '/leads' do goal é
 * app/contatos no painel); conversation → /conversas?id=; task → rota ainda
 * não existe (wave 2) — o chamador desabilita o link quando null.
 */
export function internalNotificationHref(notification: Pick<InternalNotification, "source_type" | "source_id">): string | null {
  if (!notification.source_type || !notification.source_id) return null;
  if (notification.source_type === "lead") return `/contatos/${encodeURIComponent(notification.source_id)}`;
  if (notification.source_type === "conversation") return `/conversas?id=${encodeURIComponent(notification.source_id)}`;
  return null;
}

// Safari 12–13 não tem RelativeTimeFormat: guard na construção (um construtor
// lançando no escopo do módulo derrubaria o chunk inteiro do shell).
const relativeFormatter = typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
  ? new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" })
  : null;
const dateFormatter = new Intl.DateTimeFormat("pt-BR");

/** Tempo relativo pt-BR: "agora", "5 min atrás", "2 horas atrás", "3 dias atrás". */
export function formatRelativeNotificationTime(iso: string, now = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const diffSeconds = Math.round((time - now) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 60) return "agora";
  if (relativeFormatter) {
    if (absSeconds < 3600) return relativeFormatter.format(Math.round(diffSeconds / 60), "minute");
    if (absSeconds < 86_400) return relativeFormatter.format(Math.round(diffSeconds / 3600), "hour");
    if (absSeconds < 2_592_000) return relativeFormatter.format(Math.round(diffSeconds / 86_400), "day");
  }
  return dateFormatter.format(new Date(time));
}
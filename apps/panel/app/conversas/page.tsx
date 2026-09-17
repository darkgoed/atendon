"use client";
import { ArrowClockwise, ArrowDown, ArrowLeft, ArrowsLeftRight, BellRinging, BellSlash, CalendarDots, CheckCircle, Checks, Check, DotsThreeVertical, Flask, MagnifyingGlass, Pause, Robot, UserPlus, X } from "@phosphor-icons/react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ConversationComposer } from "@/components/conversation-composer";
import { copyTextToClipboard } from "@/lib/compat";
import { ContactAvatar } from "@/components/contact-avatar";
import { ConversationMessageMedia } from "@/components/conversation-message-media";
import { ConversationContactPanel, type ContactPanelMessage } from "@/components/conversation-contact-panel";
import { AiTurnBubble } from "@/components/ai-turn-bubble";
import { ConversationReferral } from "@/components/conversation-referral";
import { ConversationScheduler } from "@/components/conversation-scheduler";
import { ConversationStatusPicker } from "@/components/conversation-status-picker";
import { Empty } from "@/components/page-state";
import { LeadTagChips, type LeadTag } from "@/components/lead-tag-picker";
import { MessageActionsMenu } from "@/components/message-actions-menu";
import { ModalDialog } from "@/components/modal-dialog";
import { PopoverMenu } from "@/components/popover-menu";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import {
  claimConversation as claimConversationApi,
  deleteConversationMessages,
  deleteMessage as deleteMessageApi,
  editMessage as editMessageApi,
  markConversationRead,
  pauseConversation as pauseConversationApi,
  reactToMessage as reactToMessageApi,
  reactivateConversation as reactivateConversationApi,
  reopenConversation as reopenConversationApi,
  requestConversationAiReply,
  resolveConversation as resolveConversationApi,
  setConversationNotificationMute,
  setConversationSignature
} from "@/lib/conversations-api";
import { useCapabilities } from "@/lib/capabilities";
import {
  clearedConversationDeltaPagination,
  conversationFallbackPollingDelay,
  conversationLabelForSession,
  conversationMessageDateSeparator,
  conversationMessagesPath,
  conversationMessagesV2Path,
  mergeConversationMessages,
  scrollTopAfterPrepend,
  shouldShowConversationConnectionFilter
} from "@/lib/conversation-messages";
import {
  isFeatureFlagDisabledError,
  panelFeatureEnabled,
  type PanelFeatureFlagsResponse
} from "@/lib/feature-flags";
import { handoffReasonLabel } from "@/lib/labels";
import { useRealtimeSignals } from "@/lib/realtime";
import {
  canLeaveCaseUnassigned,
  canAccessRootWorkspace,
  hasWorkspaceWideCaseScope,
  losesCaseAccessAfterTransfer,
  type PanelSession
} from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import { ChannelBadge, type Channel } from "@/components/channel-badge";
import { ConversationNextAction } from "@/components/conversation-next-action";
import { ConversationPreBriefing } from "@/components/conversation-pre-briefing";
import { instagramDisplayIdentity, instagramDisplayName } from "@/lib/channel-identity";

const supportedConversationFilters = new Set(["human", "ai", "mine", "unassigned", "scheduled", "resolved"]);

function normalizeConversationFilter(value: string | null) {
  return value && supportedConversationFilters.has(value) ? value : "human";
}

import type { ConnectionsResponse } from "@/lib/connections";
import type { PipelineStage } from "@/lib/pipeline";
import type { PanelNotificationPreferencesResponse } from "@/lib/message-notifications";
import {
  aiTurnProgressSatisfiedByMessages,
  parseAiTurnProgress,
  reconcileAiTurnProgress,
  type AiTurnProgress
} from "@/lib/ai-turn-progress";

type Conversation = {
  id: string;
  session_id?: string | null;
  lead_id?: string;
  contact_phone: string | null;
  contact_identifier?: string | null;
  instagram_username?: string | null;
  messaging_window_expires_at?: string | null;
  contact_name?: string;
  avatar_url?: string | null;
  ai_active: boolean;
  handoff_reason?: string;
  last_message?: string;
  last_message_at: string;
  assigned_user_id?: string | null;
  assigned_user_email?: string | null;
  assigned_user_first_name?: string | null;
  status: "open" | "closed";
  waiting_minutes?: number;
  resolved_at?: string | null;
  contact_presence?: "available" | "unavailable" | "composing" | "recording" | "paused" | null;
  contact_presence_updated_at?: string | null;
  contact_last_seen_at?: string | null;
  facebook_attribution?: Record<string, unknown> | null;
  signature_enabled?: boolean | null;
  tags?: LeadTag[];
  pipeline_stage?: PipelineStage;
  lead_status?: string;
  lead_updated_at?: string;
  unread_count?: number;
  queue_id?: string | null;
  queue_name?: string | null;
  queue_color?: string | null;
  queue_is_resolved?: boolean;
  next_action?: string | null;
  next_action_at?: string | null;
  next_action_due?: boolean;
  lead_source?: string | null;
  lead_campaign?: string | null;
  interest?: string | null;
  channel?: Channel | null;
  last_message_sender?: "contact" | "agent" | "human" | null;
  last_message_status?: string | null;
};

type UnreadCountsResponse = { human?: number; ai?: number; scheduled?: number; resolved?: number; mine?: number };

type Assignee = { id: string; email: string };

type Message = {
  id: string;
  sender: "contact" | "agent" | "human";
  content: string;
  media_type: "audio" | "image" | "video" | "document" | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
  media_size_bytes?: number | null;
  media_is_sticker?: boolean;
  ai_model_used?: string;
  sender_name?: string | null;
  status: string;
  created_at: string;
  reaction_emoji?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  deleted_for_everyone_at?: string | null;
  reply_to_message_id?: string | null;
  reply_to_content?: string | null;
  reply_to_sender?: "contact" | "agent" | "human" | null;
};
type ConversationsPage = { limit: number; has_more: boolean; next_cursor: string | null };
type ConversationsResponse = { conversations: Conversation[]; page?: ConversationsPage };
type ConversationThreadResponse = {
  conversation: Conversation;
  messages: Message[];
  ai_turn?: AiTurnProgress | null;
  cursors?: { before: string | null; after: string | null };
  page?: {
    direction: "initial" | "before" | "after";
    limit: number;
    has_more_before: boolean;
    has_more_after: boolean;
  };
};
type ConversationCapabilities = { channel: "whatsapp" | "instagram"; can_send: boolean; reason: string | null; window_expires_at: string | null; text: boolean; image: boolean; audio: boolean; video: boolean; document: boolean; reactions: boolean; edit: boolean; delete: boolean; stickers: boolean };
type ConversationDeltaResponse = ConversationThreadResponse & {
  cursors: NonNullable<ConversationThreadResponse["cursors"]>;
  page: NonNullable<ConversationThreadResponse["page"]>;
};
type ConversationAssetsResponse = {
  messages: ContactPanelMessage[];
  has_more: boolean;
  next_cursor: string | null;
};

const fetcher = <T,>(url: string) => api<T>(url);

function formatClock(value: string, timezone?: string): string {
  return new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {})
  });
}

function waitingLabel(minutes = 0): string {
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
}

function contactIsOnline(conversation: Conversation): boolean {
  if (!conversation.contact_presence_updated_at || !["available", "composing", "recording"].includes(conversation.contact_presence ?? "")) return false;
  return Date.now() - new Date(conversation.contact_presence_updated_at).getTime() < 3 * 60 * 1_000;
}

function contactPresenceLabel(conversation: Conversation): string {
  if (contactIsOnline(conversation)) {
    if (conversation.contact_presence === "composing") return "digitando…";
    if (conversation.contact_presence === "recording") return "gravando áudio…";
    return "online";
  }
  if (!conversation.contact_last_seen_at) return "presença indisponível";
  const seen = new Date(conversation.contact_last_seen_at);
  const today = new Date();
  const sameDay = seen.toDateString() === today.toDateString();
  return sameDay
    ? `visto por último às ${seen.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : `visto por último em ${seen.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

function MessageTicks({ status }: { status: string }) {
  const label = status === "read" ? "Mensagem lida" : status === "delivered" ? "Mensagem entregue" : "Mensagem enviada";
  const Icon = status === "read" || status === "delivered" ? Checks : Check;
  return <><Icon size={13} weight="bold" className={status === "read" ? "text-[var(--info-text)]" : "text-[var(--text-muted)]"} aria-hidden="true" /><span className="sr-only">{label}</span></>;
}

function ConversationBadge({ item }: { item: Conversation }) {
  const active = item.ai_active;
  return (
    <span className="conversation-list__ai-status inline-flex min-w-0 shrink-0 items-center gap-1 text-xs font-medium">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-[var(--primary)]" : "bg-[var(--warning)]"}`} aria-hidden="true" />
      <span className={`shrink-0 whitespace-nowrap ${active ? "text-[var(--primary-text)]" : "text-[var(--warning-text)]"}`}>
        {active ? "IA ativa" : "IA pausada"}
      </span>
      {!active && item.handoff_reason ? (
        <span className="truncate text-[var(--text-muted)]">· {handoffReasonLabel(item.handoff_reason)}</span>
      ) : null}
    </span>
  );
}

function ConversationItem({ item, selected, showLeadTags, onClick }: { item: Conversation; selected: string; showLeadTags: boolean; onClick: (id: string) => void }) {
  const isSelected = selected === item.id;
  const title = item.channel === "instagram"
    ? instagramDisplayName(item.contact_name, item.instagram_username, item.contact_identifier, item.contact_phone)
    : item.contact_name ?? item.contact_phone ?? "Contato sem identificação";
  const unread = item.unread_count ?? 0;
  const showTicks = item.last_message_sender === "agent" || item.last_message_sender === "human";

  return (
    <button
      type="button"
      onClick={() => onClick(item.id)}
      aria-pressed={isSelected}
      className={[
        "conversation-list__item group flex w-full items-start text-left transition",
        isSelected
          ? "bg-[var(--primary-subtle)]"
          : "bg-[var(--surface)] hover:bg-[var(--surface-hover)]"
      ].join(" ")}
    >
      <div className="relative shrink-0">
        <ContactAvatar
          name={title}
          src={item.avatar_url}
          className={`conversation-list__avatar h-8 w-8 text-xs transition ${isSelected ? "border-[var(--primary-border)] text-[var(--primary-text)]" : ""}`}
        />
        {item.channel !== "instagram" && contactIsOnline(item) ? <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-[var(--surface)] bg-[var(--success)]" aria-hidden="true" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <strong data-unread={unread > 0 ? "true" : undefined} className={`conversation-list__name min-w-0 truncate text-[var(--text)] ${unread > 0 ? "font-semibold" : ""}`}>{title}</strong>
          <time className="conversation-list__time mono shrink-0 text-[var(--text-muted)]">{formatClock(item.last_message_at)}</time>
        </div>
        {item.contact_name ? <p className="conversation-list__company mono truncate text-[var(--text-muted)]" dir="ltr">{item.channel === "instagram" ? instagramDisplayIdentity(item.instagram_username, item.contact_identifier) : item.contact_phone}</p> : null}
        <div className="conversation-list__preview-row flex min-w-0 items-start justify-between gap-2">
          <p className="conversation-list__preview line-clamp-2 min-w-0 flex-1 text-[var(--text-secondary)]">
            {showTicks && item.last_message_status ? (
              <span className="mr-1 inline-flex align-middle"><MessageTicks status={item.last_message_status} /></span>
            ) : null}
            {item.last_message ?? "Sem mensagens ainda"}
          </p>
          {unread > 0 ? (
            <span className="conversation-list__unread mono flex shrink-0 items-center justify-center rounded-full bg-[var(--primary)] font-semibold text-[var(--primary-foreground)]">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </div>
        <div className="conversation-list__footer flex min-w-0 items-center gap-1.5 overflow-hidden">
          <ChannelBadge channel={item.channel === "instagram" ? "instagram" : "whatsapp"} size={12} />
          <ConversationBadge item={item} />
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-[var(--text-muted)]">
            {item.assigned_user_first_name ? <span className="truncate">{item.assigned_user_first_name}</span> : null}
            {!item.ai_active && item.status === "open" && item.handoff_reason !== "manually_paused" ? (
              <span className={`mono shrink-0 ${Number(item.waiting_minutes) >= 15 ? "text-[var(--danger-text)]" : "text-[var(--text-muted)]"}`}>
                {waitingLabel(Number(item.waiting_minutes))}{Number(item.waiting_minutes) >= 15 ? " · SLA" : ""}
              </span>
            ) : null}
          </span>
        </div>
        {item.next_action ? (
          <p className={`mt-1 truncate text-xs ${item.next_action_due || (item.next_action_at && new Date(item.next_action_at).getTime() <= Date.now()) ? "font-semibold text-[var(--warning-text)]" : "text-[var(--text-muted)]"}`}>
            Próxima ação: {item.next_action}{item.next_action_at ? ` · ${new Date(item.next_action_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
          </p>
        ) : null}
        {showLeadTags ? <LeadTagChips tags={item.tags} compact /> : null}
      </div>
    </button>
  );
}

function MessageItem({
  conversationId,
  message,
  timezone,
  canManage,
  onReply,
  onReact,
  onEdit,
  onDelete,
  actionCapabilities
}: {
  conversationId: string;
  message: Message;
  timezone: string;
  canManage: boolean;
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  onEdit: (messageId: string, text: string) => Promise<void>;
  onDelete: (messageId: string, forEveryone: boolean) => void;
  actionCapabilities?: Pick<ConversationCapabilities, "reactions" | "edit" | "delete">;
}) {
  const isContact = message.sender === "contact";
  const isSticker = Boolean(message.media_is_sticker);
  const isOwn = message.sender === "human";
  const isDeleted = Boolean(message.deleted_at);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);

  async function saveEdit() {
    const text = draft.trim();
    if (!text || text === message.content) { setEditing(false); return; }
    setSaving(true);
    try {
      await onEdit(message.id, text);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const author = isContact ? "Contato" : message.sender === "agent" ? "Copiloto" : message.sender_name ?? "Atendente";

  return (
    <div className={`conversation-message group/msg flex items-end gap-1.5 ${isContact ? "conversation-message--contact justify-start" : isOwn ? "conversation-message--human justify-end" : "conversation-message--ai justify-end"}`}>
      {!isContact && !isDeleted && canManage ? (
        <MessageActionsMenu
          isOwn={isOwn}
          align="end"
          reactionEmoji={message.reaction_emoji}
          onReply={() => onReply(message)}
          onCopy={() => { void copyTextToClipboard(message.content); }}
          onReact={(emoji) => onReact(message.id, emoji)}
          onEdit={isOwn && !message.media_type ? () => setEditing(true) : undefined}
          onDelete={(forEveryone) => onDelete(message.id, forEveryone)}
          allowReactions={actionCapabilities?.reactions}
          allowEdit={actionCapabilities?.edit}
          allowDelete={actionCapabilities?.delete}
        />
      ) : null}
      <div className="conversation-message__content conversation-message-content-width flex min-w-0 flex-col">
        <span className={`conversation-message__meta mb-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)] ${isContact ? "self-start" : "self-end"}`}>
          <strong className="truncate font-semibold text-[var(--text-secondary)]">{author}</strong>
          {message.sender === "agent" ? <span className="conversation-message__badge">IA</span> : null}
          <time className="mono shrink-0">{formatClock(message.created_at, timezone)}</time>
          {message.ai_model_used ? <span className="truncate">· {message.ai_model_used}</span> : null}
          {message.edited_at ? <span className="shrink-0">· editada</span> : null}
          {!isContact ? <MessageTicks status={message.status} /> : null}
        </span>
        <div
          className={[
            "msg conversation-message__bubble",
            isSticker
              ? "bg-transparent px-1 py-1"
              : isContact
                ? "border border-[var(--border)] bg-[var(--surface)]"
                : isOwn
                  ? "border border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "border border-[var(--primary-border)] bg-[var(--primary-subtle)]"
          ].join(" ")}
        >
          {isDeleted ? (
            <p className="whitespace-pre-wrap text-sm italic leading-snug text-[var(--text-muted)]">
              {message.deleted_for_everyone_at ? "Você apagou esta mensagem para todos" : "Mensagem apagada"}
            </p>
          ) : (
            <>
              {message.reply_to_message_id ? (
                <span className="msg-reply-preview">
                  <strong>{message.reply_to_sender === "contact" ? "Contato" : message.reply_to_sender === "agent" ? "IA" : "Você"}</strong>
                  {(message.reply_to_content ?? "").slice(0, 140) || "Mídia"}
                </span>
              ) : null}
              {editing ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    className="input conversation-control-minheight py-1.5 text-sm"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={saving}
                    autoFocus
                  />
                  <div className="flex justify-end gap-1.5">
                    <button type="button" className="btn text-xs" onClick={() => { setDraft(message.content); setEditing(false); }} disabled={saving}>Cancelar</button>
                    <button type="button" className="btn primary text-xs" onClick={() => void saveEdit()} disabled={saving}>Salvar</button>
                  </div>
                </div>
              ) : message.media_type ? (
                <ConversationMessageMedia conversationId={conversationId} message={{ ...message, media_type: message.media_type }} />
              ) : (
                <p className="whitespace-pre-wrap text-inherit">{message.content}</p>
              )}
            </>
          )}
        </div>
        {!isDeleted && message.reaction_emoji ? (
          <span className={`msg-reaction-badge ${isContact ? "self-start" : "self-end"}`}>{message.reaction_emoji}</span>
        ) : null}
      </div>
      {isContact && !isDeleted && canManage ? (
        <MessageActionsMenu
          isOwn={false}
          align="start"
          reactionEmoji={message.reaction_emoji}
          onReply={() => onReply(message)}
          onCopy={() => { void copyTextToClipboard(message.content); }}
          onReact={(emoji) => onReact(message.id, emoji)}
          onDelete={(forEveryone) => onDelete(message.id, forEveryone)}
          allowReactions={actionCapabilities?.reactions}
          allowEdit={actionCapabilities?.edit}
          allowDelete={actionCapabilities?.delete}
        />
      ) : null}
    </div>
  );
}

function MessageDateSeparator({ label }: { label: string }) {
  return (
    <div className="my-1 flex justify-center" role="separator" aria-label={label}>
      <time className="conversation-system-marker mono px-3 py-1 text-xs font-medium leading-none text-[var(--text-muted)]">
        {label}
      </time>
    </div>
  );
}

export default function Conversations() {
  const { isEnabled } = useCapabilities();
  const leadsEnabled = isEnabled("leads_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  const canReply = usePermission("conversations.reply");

  const canChangeAi = usePermission("conversations.reactivate");
  const canCreateAppointment = usePermission("appointments.create");
  const canReadAvailability = usePermission("availability.read");
  const canReadUnits = usePermission("units.read");
  const canSchedule = appointmentsEnabled && canCreateAppointment && canReadAvailability && canReadUnits;
  const [filter, setFilter] = useState("human");
  const [connectionFilter, setConnectionFilter] = useState("");
  const [queueFilter, setQueueFilter] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [assignmentNotice, setAssignmentNotice] = useState("");
  const [changingAi, setChangingAi] = useState(false);
  const [requestingAiReply, setRequestingAiReply] = useState(false);
  const [aiActionNotice, setAiActionNotice] = useState("");
  const [changingOwner, setChangingOwner] = useState(false);
  const [followUpPending, setFollowUpPending] = useState(false);
  const [queueingEvaluation, setQueueingEvaluation] = useState(false);
  const [evaluationNotice, setEvaluationNotice] = useState("");
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [contactPanelOpen, setContactPanelOpen] = useState(false);
  const [contactAssets, setContactAssets] = useState<ContactPanelMessage[]>([]);
  const [contactAssetsLoading, setContactAssetsLoading] = useState(false);
  const [contactAssetsLoadingMore, setContactAssetsLoadingMore] = useState(false);
  const [contactAssetsHasMore, setContactAssetsHasMore] = useState(false);
  const [contactAssetsCursor, setContactAssetsCursor] = useState<string | null>(null);
  const [contactAssetsError, setContactAssetsError] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [threadConversation, setThreadConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [aiTurn, setAiTurn] = useState<AiTurnProgress | null>(null);
  const [beforeCursor, setBeforeCursor] = useState<string | null>(null);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const selectedRef = useRef("");
  const deepLinkIdRef = useRef<string | null>(null);
  const renderedConversationRef = useRef("");
  const loadedConversationRef = useRef("");
  const messageModeRef = useRef<"legacy" | "delta">("legacy");
  const afterCursorRef = useRef<string | null>(null);
  const deltaInFlightRef = useRef(false);
  const pollingFailuresRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const revokedConversationIdRef = useRef<string | null>(null);
  const manualDeselectRef = useRef(false);
  const markedReadRef = useRef("");
  const contactAssetsRequestRef = useRef<AbortController | null>(null);
  const contactAssetsRequestIdRef = useRef(0);
  const contactPanelReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setFilter(normalizeConversationFilter(query.get("filtro")));
    const linkedId = query.get("id");
    setSelected(linkedId ?? "");
    deepLinkIdRef.current = linkedId;
  }, []);

  useEffect(() => {
    setReplyTarget(null);
    setContactPanelOpen(false);
    setContactAssets([]);
    setContactAssetsError("");
    setContactAssetsHasMore(false);
    setContactAssetsCursor(null);
    setContactAssetsLoading(false);
    setContactAssetsLoadingMore(false);
    contactAssetsRequestRef.current?.abort();
    contactAssetsRequestRef.current = null;
    contactAssetsRequestIdRef.current += 1;
  }, [selected]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data: connectionsData } = useSWR<ConnectionsResponse>(
    session ? "/connections" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const { data: notificationPreferences, mutate: mutateNotificationPreferences } = useSWR<PanelNotificationPreferencesResponse>(
    session ? "/me/notification-preferences" : null,
    fetcher,
    { revalidateOnFocus: true, dedupingInterval: 5_000 }
  );
  const { data: featureFlags, mutate: mutateFeatureFlags } = useSWR<PanelFeatureFlagsResponse>(
    "/feature-flags",
    fetcher,
    { refreshInterval: 5_000, revalidateOnFocus: true, dedupingInterval: 2_000 }
  );
  const deltaEnabled = panelFeatureEnabled(featureFlags, "conversations_delta_v2");
  const aiTurnVisibilityEnabled = panelFeatureEnabled(featureFlags, "ai_turn_visibility_v1");
  const messageMode = deltaEnabled ? "delta" : "legacy";
  const canQueueEvaluation = Boolean(session && canAccessRootWorkspace(session));
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));
  const effectiveFilter = hasWorkspaceScope ? filter : "mine";
  const advancedFilterCount = [
    connectionFilter,
    queueFilter,
    hasWorkspaceScope && (filter === "mine" || filter === "unassigned") ? filter : "",
    unreadOnly ? "unread" : "",
    pendingOnly ? "pending" : ""
  ].filter(Boolean).length;
  const listKey = session
    ? `/conversations?filter=${effectiveFilter}${debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : ""}${queueFilter ? `&queue_id=${queueFilter}` : ""}${connectionFilter ? `&session_id=${connectionFilter}` : ""}${unreadOnly ? "&unread=true" : ""}${pendingOnly ? "&pending_action=true" : ""}`
    : null;
  const { data: listData, error: listError, isLoading: listLoading, mutate: mutateList } = useSWR<ConversationsResponse>(listKey, fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: false,
    dedupingInterval: 5_000
  });
  // Server-side keyset pagination for the conversation list: the SWR key
  // always fetches the first page (what the 10s poll refreshes); "Carregar
  // mais" appends older pages by cursor. Once extra pages exist the poll must
  // not overwrite the anchor cursor (it would duplicate already-loaded rows).
  const [olderConversations, setOlderConversations] = useState<Conversation[]>([]);
  const [listPageState, setListPageState] = useState<{ cursor: string | null; hasMore: boolean; fetchedPages: number }>({ cursor: null, hasMore: false, fetchedPages: 0 });
  const [loadingOlderList, setLoadingOlderList] = useState(false);
  useEffect(() => {
    setOlderConversations([]);
    setListPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    setLoadingOlderList(false);
  }, [listKey]);
  useEffect(() => {
    const page = listData?.page;
    if (!page || listPageState.fetchedPages > 0) return;
    setListPageState((current) => current.fetchedPages > 0 ? current : { cursor: page.next_cursor, hasMore: page.has_more, fetchedPages: 0 });
  }, [listData?.page, listPageState.fetchedPages]);
  async function loadOlderConversations() {
    if (!listPageState.cursor || loadingOlderList) return;
    setLoadingOlderList(true);
    try {
      const response = await api<ConversationsResponse>(`${listKey}&before=${encodeURIComponent(listPageState.cursor)}&limit=50`);
      setOlderConversations((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.conversations.filter((item) => !seen.has(item.id))];
      });
      setListPageState((current) => ({
        cursor: response.page?.next_cursor ?? null,
        hasMore: Boolean(response.page?.has_more),
        fetchedPages: current.fetchedPages + 1
      }));
    } catch {
      // O botão permanece; o usuário pode tentar de novo.
    } finally {
      setLoadingOlderList(false);
    }
  }
  const threadPath = selected ? conversationMessagesPath(selected, deltaEnabled) : null;
  const { data: threadData, error: threadError, mutate: mutateThread } = useSWR<ConversationThreadResponse>(
    threadPath,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 3_000 }
  );
  const { data: channelCapabilities, error: channelCapabilitiesError } = useSWR<ConversationCapabilities>(
    selected ? `/conversations/${selected}/channel-capabilities` : null,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 3_000 }
  );
  const { data: assigneeData } = useSWR<{ assignees: Assignee[] }>(
    canReply && session ? "/conversations/assignees" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 15_000 }
  );
  const { data: unreadCounts, mutate: mutateUnreadCounts } = useSWR<UnreadCountsResponse>(
    session ? "/conversations/unread-counts" : null,
    fetcher,
    { refreshInterval: 10_000, revalidateOnFocus: false, dedupingInterval: 5_000 }
  );

  const connections = useMemo(() => connectionsData?.connections ?? [], [connectionsData?.connections]);
  const { data: queueData, mutate: mutateQueues } = useSWR<{ queues: Array<{ id: string; name: string; color: string; is_resolved: boolean; conversation_count: number; archived_at: string | null }> }>(session ? "/conversation-queues" : null, fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const showConnectionFilter = shouldShowConversationConnectionFilter(connections);
  const allItems = useMemo(() => {
    const fresh = listData?.conversations ?? [];
    if (olderConversations.length === 0) return fresh;
    const seen = new Set(fresh.map((item) => item.id));
    return [...fresh, ...olderConversations.filter((item) => !seen.has(item.id))];
  }, [listData?.conversations, olderConversations]);
  const items = allItems;
  const thread = { conversation: threadConversation, messages };
  const threadConnectionLabel = conversationLabelForSession(
    threadConversation?.session_id ? threadConversation : allItems.find((item) => item.id === selected),
    connections
  );
  const timezone = session?.activeWorkspace?.timezone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC";
  const lastMessageId = messages.at(-1)?.id;
  const assignees = useMemo(() => {
    const candidates = [...(assigneeData?.assignees ?? [])];
    if (
      threadConversation?.assigned_user_id
      && threadConversation.assigned_user_email
      && !candidates.some((candidate) => candidate.id === threadConversation.assigned_user_id)
    ) {
      candidates.push({
        id: threadConversation.assigned_user_id,
        email: `${threadConversation.assigned_user_email} · fora do pool`
      });
    }
    return candidates;
  }, [
    assigneeData?.assignees,
    threadConversation?.assigned_user_email,
    threadConversation?.assigned_user_id
  ]);

  useEffect(() => {
    if (session && !hasWorkspaceScope && filter !== "mine") setFilter("mine");
  }, [filter, hasWorkspaceScope, session]);

  useEffect(() => {
    if (!showConnectionFilter && connectionFilter) setConnectionFilter("");
  }, [connectionFilter, showConnectionFilter]);

  useEffect(() => {
    selectedRef.current = selected;
    loadedConversationRef.current = "";
    afterCursorRef.current = null;
    deltaInFlightRef.current = false;
    markedReadRef.current = "";
    setAiActionNotice("");
    setThreadConversation(null);
    setMessages([]);
    setAiTurn(null);
    setBeforeCursor(null);
    setHasMoreBefore(false);
  }, [selected]);

  useEffect(() => {
    if (messageModeRef.current === messageMode) return;
    messageModeRef.current = messageMode;
    const cleared = clearedConversationDeltaPagination();
    afterCursorRef.current = cleared.afterCursor;
    deltaInFlightRef.current = false;
    setBeforeCursor(cleared.beforeCursor);
    setHasMoreBefore(cleared.hasMoreBefore);
    setLoadingOlder(false);
  }, [messageMode]);

  useEffect(() => {
    if (!threadData || threadData.conversation.id !== selected) return;
    const firstLoad = loadedConversationRef.current !== selected;
    loadedConversationRef.current = selected;
    setThreadConversation(threadData.conversation);
    setMessages((current) => firstLoad
      ? threadData.messages
      : mergeConversationMessages(current, threadData.messages));
    const recoveredAiTurn = parseAiTurnProgress(threadData.ai_turn);
    if (recoveredAiTurn) {
      setAiTurn((current) => reconcileAiTurnProgress(current, recoveredAiTurn));
    } else if ("ai_turn" in threadData) {
      setAiTurn(null);
    }
    if (deltaEnabled && threadData.cursors && threadData.page) {
      setBeforeCursor(threadData.cursors.before);
      setHasMoreBefore(threadData.page.has_more_before);
      if (threadData.cursors.after) afterCursorRef.current = threadData.cursors.after;
    } else {
      setBeforeCursor(null);
      setHasMoreBefore(false);
      afterCursorRef.current = null;
    }
    if (markedReadRef.current !== selected) {
      markedReadRef.current = selected;
      markConversationRead(selected)
        .then(() => { void mutateList(); void mutateUnreadCounts(); })
        .catch(() => { markedReadRef.current = ""; });
    }
  }, [deltaEnabled, mutateList, mutateUnreadCounts, selected, threadData]);

  useEffect(() => {
    if (isFeatureFlagDisabledError(threadError, "conversations_delta_v2")) {
      void mutateFeatureFlags();
    }
  }, [mutateFeatureFlags, threadError]);

  const clearConversationAfterAccessChange = useCallback((notice: string) => {
    revokedConversationIdRef.current = selectedRef.current || null;
    selectedRef.current = "";
    deepLinkIdRef.current = null;
    loadedConversationRef.current = "";
    afterCursorRef.current = null;
    setSelected("");
    setThreadConversation(null);
    setMessages([]);
    setAiTurn(null);
    setBeforeCursor(null);
    setHasMoreBefore(false);
    setError("");
    setAssignmentNotice(notice);
    void mutateThread(undefined, { revalidate: false });
    void mutateList();
  }, [mutateList, mutateThread]);

  const refreshSelectedConversation = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (!conversationId) return;
    if (!deltaEnabled || messageModeRef.current !== "delta") {
      await mutateThread();
      return;
    }
    if (deltaInFlightRef.current) return;
    deltaInFlightRef.current = true;
    try {
      const initialCursor = afterCursorRef.current;
      if (!initialCursor) {
        await mutateThread();
        return;
      }
      let cursor = initialCursor;
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const response = await api<ConversationDeltaResponse>(
          conversationMessagesV2Path(conversationId, { limit: 100, after: cursor })
        );
        if (
          messageModeRef.current !== "delta"
          || selectedRef.current !== conversationId
          || response.conversation.id !== conversationId
        ) return;
        setThreadConversation(response.conversation);
        setMessages((current) => mergeConversationMessages(current, response.messages));
        const recoveredAiTurn = parseAiTurnProgress(response.ai_turn);
        if (recoveredAiTurn) {
          setAiTurn((current) => reconcileAiTurnProgress(current, recoveredAiTurn));
        } else if ("ai_turn" in response) {
          setAiTurn(null);
        }
        if (response.cursors.after) {
          cursor = response.cursors.after;
          afterCursorRef.current = cursor;
        }
        if (!response.page.has_more_after) break;
      }
    } catch (caught) {
      if (isFeatureFlagDisabledError(caught, "conversations_delta_v2")) {
        void mutateFeatureFlags();
      } else if (caught instanceof ApiError && caught.status === 404) {
        clearConversationAfterAccessChange("Seu acesso a essa conversa foi atualizado. A lista já mostra somente os atendimentos atribuídos a você.");
        return;
      }
      throw caught;
    } finally {
      deltaInFlightRef.current = false;
    }
  }, [clearConversationAfterAccessChange, deltaEnabled, mutateFeatureFlags, mutateThread]);

  useRealtimeSignals({
    onCatchUp: () => {
      if (document.visibilityState !== "visible") return;
      void mutateList();
      void refreshSelectedConversation().catch(() => undefined);
    },
    onSignal: (signal) => {
      if (signal.type === "conversation.ai.progress") {
        if (aiTurnVisibilityEnabled && signal.conversationId === selectedRef.current) {
          setAiTurn((current) => reconcileAiTurnProgress(current, signal));
        }
        return;
      }
      if (document.visibilityState !== "visible") return;
      if (signal.type === "case.assignment.changed") {
        void mutateList();
        if (signal.conversationId === selectedRef.current) {
          void refreshSelectedConversation().catch(() => undefined);
        }
        return;
      }
      if (signal.type !== "conversation.messages.changed") return;
      void mutateList();
      if (signal.conversationId === selectedRef.current) {
        void refreshSelectedConversation().catch(() => undefined);
      }
    }
  });

  useEffect(() => {
    if (!featureFlags || aiTurnVisibilityEnabled) return;
    setAiTurn(null);
  }, [aiTurnVisibilityEnabled, featureFlags]);

  useEffect(() => {
    if (!aiTurn) return;
    const remaining = Date.parse(aiTurn.expiresAt) - Date.now();
    if (remaining <= 0) {
      setAiTurn(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setAiTurn((current) => current?.turnId === aiTurn.turnId ? null : current);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [aiTurn]);

  useEffect(() => {
    if (!aiTurn || !aiTurnProgressSatisfiedByMessages(aiTurn, messages)) return;
    setAiTurn(null);
  }, [aiTurn, messages]);

  useEffect(() => {
    if (!selected || threadConversation?.id !== selected) return;
    pollingFailuresRef.current = 0;
    let stopped = false;
    let timer: number | undefined;

    const schedule = (immediate = false) => {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      const delay = immediate
        ? document.visibilityState === "visible" ? 0 : null
        : conversationFallbackPollingDelay({
            deltaEnabled,
            failures: pollingFailuresRef.current,
            visibilityState: document.visibilityState
          });
      timer = delay === null
        ? undefined
        : window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        await refreshSelectedConversation();
        pollingFailuresRef.current = 0;
      } catch {
        pollingFailuresRef.current += 1;
      } finally {
        schedule();
      }
    };

    const onVisibilityChange = () => schedule(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [deltaEnabled, refreshSelectedConversation, selected, threadConversation?.id]);

  useEffect(() => {
    if (listLoading) return;
    // Preserve the conversation requested by links from the agenda while its
    // thread is loading. On the first render, `selected` still has its empty
    // initial value and must not be replaced by the first item in the list.
    if (deepLinkIdRef.current) return;
    if (revokedConversationIdRef.current) {
      if (items.some((conversation) => conversation.id === revokedConversationIdRef.current)) return;
      revokedConversationIdRef.current = null;
    }
    if (!items.length) {
      if (selected) setSelected("");
      return;
    }
    if (manualDeselectRef.current) return;
    if (!selected || !items.some((conversation: Conversation) => conversation.id === selected)) {
      setSelected(items[0].id);
    }
  }, [items, listLoading, selected]);

  const selectConversation = useCallback((id: string) => {
    manualDeselectRef.current = false;
    setSelected(id);
  }, []);

  const goBackToList = useCallback(() => {
    manualDeselectRef.current = true;
    setSelected("");
  }, []);

  useEffect(() => {
    if (!deepLinkIdRef.current || selected !== deepLinkIdRef.current) return;
    if (isFeatureFlagDisabledError(threadError, "conversations_delta_v2")) return;
    if (threadError) {
      setError("A conversa vinculada a este agendamento não foi encontrada.");
      deepLinkIdRef.current = null;
      setSelected("");
    } else if (threadData) {
      deepLinkIdRef.current = null;
    }
  }, [threadData, threadError, selected]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  useLayoutEffect(() => {
    if (!thread.conversation) return;
    if (renderedConversationRef.current !== selected) {
      renderedConversationRef.current = selected;
      scrollToBottom("auto");
      return;
    }
    if (isNearBottomRef.current) scrollToBottom("auto");
  }, [aiTurn?.revision, lastMessageId, selected, scrollToBottom, thread.conversation]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const trackScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = messagesRef.current;
      if (!container) return;
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
      isNearBottomRef.current = nearBottom;
      setShowScrollToBottom((current) => (current === !nearBottom ? current : !nearBottom));
    });
  }, []);

  async function loadOlderMessages() {
    if (!deltaEnabled || !selected || !beforeCursor || loadingOlder) return;
    setLoadingOlder(true);
    const container = messagesRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    try {
      const response = await api<ConversationDeltaResponse>(
        conversationMessagesV2Path(selected, { limit: 100, before: beforeCursor })
      );
      if (
        response.conversation.id !== selected
        || selectedRef.current !== selected
        || messageModeRef.current !== "delta"
      ) return;
      setThreadConversation(response.conversation);
      setMessages((current) => mergeConversationMessages(current, response.messages));
      setBeforeCursor(response.cursors.before);
      setHasMoreBefore(response.page.has_more_before);
      requestAnimationFrame(() => {
        if (!container) return;
        container.scrollTop = scrollTopAfterPrepend(
          previousTop,
          previousHeight,
          container.scrollHeight
        );
      });
    } catch (caught) {
      if (isFeatureFlagDisabledError(caught, "conversations_delta_v2")) {
        void mutateFeatureFlags();
      } else {
        setError(caught instanceof Error ? caught.message : "Falha ao carregar mensagens anteriores");
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  async function reactivate() {
    setError("");
    setChangingAi(true);
    try {
      await reactivateConversationApi(selected);
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao reativar a IA");
    } finally {
      setChangingAi(false);
    }
  }

  function replyNowWithAi() {
    if (!selected) return;
    setPendingConfirm({
      message: "Fazer a IA responder agora à última mensagem deste contato? Use esta ação quando uma queda ou reinício interrompeu o atendimento.",
      confirmLabel: "Responder agora",
      onConfirm: () => void replyNowWithAiConfirmed()
    });
  }

  async function replyNowWithAiConfirmed() {
    setError("");
    setAiActionNotice("");
    setRequestingAiReply(true);
    try {
      await requestConversationAiReply(selectedRef.current);
      setAiActionNotice("Resposta da IA colocada na fila. Ela será enviada em instantes.");
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao solicitar a resposta da IA");
    } finally {
      setRequestingAiReply(false);
    }
  }

  function pauseAi() {
    if (!selected) return;
    setPendingConfirm({
      message: "Pausar a IA somente para este contato? As mensagens continuarão aparecendo aqui para atendimento manual.",
      confirmLabel: "Pausar IA",
      onConfirm: () => void pauseAiConfirmed()
    });
  }

  async function pauseAiConfirmed() {
    setError("");
    setChangingAi(true);
    try {
      await pauseConversationApi(selectedRef.current);
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao pausar a IA para este contato");
    } finally {
      setChangingAi(false);
    }
  }

  async function claimConversation() {
    if (!selected) return;
    setError("");
    setChangingOwner(true);
    try {
      await claimConversationApi(selected);
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao assumir a conversa");
    } finally {
      setChangingOwner(false);
    }
  }

  async function followUpConversation() {
    if (!selected || followUpPending) return;
    setError("");
    setFollowUpPending(true);
    try {
      const response = await api<{ status?: string; code?: string }>(`/conversations/${selectedRef.current}/follow-up`, {
        method: "POST",
        headers: { "Idempotency-Key": `conversation-follow-up-${selectedRef.current}-${Date.now()}` }
      });
      setAiActionNotice(response.status === "pending" ? "Follow-up enfileirado; o envio está sendo processado." : "Follow-up aceito.");
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Falha ao enviar follow-up";
      setError(message.includes("idempotency_conflict") ? "Esta solicitação já está em andamento." : message);
    } finally {
      setFollowUpPending(false);
    }
  }

  function resolveConversation() {
    if (!selected) return;
    setPendingConfirm({
      message: "Marcar esta conversa como resolvida e removê-la da fila aberta?",
      confirmLabel: "Resolver conversa",
      onConfirm: () => void resolveConversationConfirmed()
    });
  }

  async function resolveConversationConfirmed() {
    setError("");
    setChangingOwner(true);
    const previousList = listData;
    const previousThread = threadData;
    const optimistic = (conversation: Conversation): Conversation => ({ ...conversation, status: "closed", resolved_at: new Date().toISOString() });
    await mutateList((current) => current ? { conversations: current.conversations.map((item) => item.id === selectedRef.current ? optimistic(item) : item) } : current, { revalidate: false });
    if (previousThread?.conversation.id === selectedRef.current) await mutateThread({ ...previousThread, conversation: optimistic(previousThread.conversation) }, { revalidate: false });
    try {
      await resolveConversationApi(selectedRef.current);
      await Promise.all([mutateList(), mutateThread(), mutateQueues()]);
    } catch (e) {
      await mutateList(previousList, { revalidate: false });
      await mutateThread(previousThread, { revalidate: false });
      setError(e instanceof Error ? e.message : "Falha ao resolver a conversa");
    } finally {
      setChangingOwner(false);
    }
  }

  async function reopenConversation() {
    if (!selected) return;
    setError("");
    setChangingOwner(true);
    try {
      await reopenConversationApi(selected);
      setFilter("human");
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao reabrir a conversa");
    } finally {
      setChangingOwner(false);
    }
  }

  async function reactToMessage(messageId: string, emoji: string) {
    if (!selected) return;
    const previous = messages;
    setMessages((current) => current.map((item) => item.id === messageId ? { ...item, reaction_emoji: emoji || null } : item));
    try {
      await reactToMessageApi(selected, messageId, emoji || null);
    } catch (e) {
      setMessages(previous);
      setError(e instanceof Error ? e.message : "Falha ao reagir à mensagem");
    }
  }

  async function editMessage(messageId: string, text: string) {
    if (!selected) return;
    try {
      await editMessageApi(selected, messageId, text);
      setMessages((current) => current.map((item) => item.id === messageId ? { ...item, content: text, edited_at: new Date().toISOString() } : item));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao editar a mensagem");
      throw e;
    }
  }

  async function deleteMessage(messageId: string, forEveryone: boolean) {
    if (!selected) return;
    try {
      await deleteMessageApi(selected, messageId, forEveryone);
      const deletedAt = new Date().toISOString();
      setMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, deleted_at: deletedAt, deleted_for_everyone_at: forEveryone ? deletedAt : item.deleted_for_everyone_at }
        : item));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao apagar a mensagem");
    }
  }

  async function assignConversation(userId: string) {
    if (!selected) return;
    if (session && !canLeaveCaseUnassigned(session) && !userId) {
      setError("Operadores precisam transferir o atendimento para outro membro ativo do pool.");
      return;
    }
    setError("");
    setAssignmentNotice("");
    setChangingOwner(true);
    try {
      await api(`/conversations/${selected}/assign`, {
        method: "PATCH",
        body: JSON.stringify({ userId: userId || null })
      });
      if (session && losesCaseAccessAfterTransfer(session, userId || null)) {
        clearConversationAfterAccessChange("Conversa transferida. Ela não aparece mais em Minhas conversas.");
        return;
      }
      await Promise.all([mutateList(), mutateThread()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao transferir a conversa");
    } finally {
      setChangingOwner(false);
    }
  }

  async function moveConversationToQueue(queueId: string) {
    if (!selected || !canReply) return;
    const previousList = listData;
    const previousThread = threadData;
    const queue = (queueData?.queues ?? []).find((item) => item.id === queueId);
    const optimistic = (conversation: Conversation): Conversation => ({ ...conversation, queue_id: queueId, queue_name: queue?.name ?? conversation.queue_name, queue_color: queue?.color ?? conversation.queue_color, status: queue?.is_resolved ? "closed" : "open" });
    await mutateList((current) => current ? { conversations: current.conversations.map((item) => item.id === selected ? optimistic(item) : item) } : current, { revalidate: false });
    if (previousThread?.conversation.id === selected) await mutateThread({ ...previousThread, conversation: optimistic(previousThread.conversation) }, { revalidate: false });
    try {
      await api(`/conversations/${selected}/queue`, { method: "PATCH", body: JSON.stringify({ queue_id: queueId }) });
      await Promise.all([mutateList(), mutateThread(), mutateQueues()]);
    } catch (caught) {
      await mutateList(previousList, { revalidate: false });
      await mutateThread(previousThread, { revalidate: false });
      setError(caught instanceof Error ? caught.message : "Falha ao mover a conversa de fila");
    }
  }

  async function toggleSignature(value: string) {
    if (!selected) return;
    setError("");
    try {
      await setConversationSignature(selected, value === "" ? null : value === "true");
      await mutateThread();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao atualizar a assinatura desta conversa");
    }
  }

  async function toggleNotificationMute() {
    if (!selected) return;
    const muted = notificationPreferences?.muted_conversations.some((conversation) => conversation.id === selected) ?? false;
    setError("");
    try {
      await setConversationNotificationMute(selected, !muted);
      await mutateNotificationPreferences();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao alterar os avisos desta conversa");
    }
  }

  async function queueManualEvaluation() {
    if (!selected || queueingEvaluation) return;
    setError("");
    setEvaluationNotice("");
    setQueueingEvaluation(true);
    try {
      await api("/agent/evaluations/run", { method: "POST", body: JSON.stringify({ conversationId: selected }) });
      setEvaluationNotice("Avaliação manual enfileirada. O resultado aparecerá em Melhoria da IA.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao enfileirar a avaliação manual");
    } finally {
      setQueueingEvaluation(false);
    }
  }

  function clearContactConversation() {
    if (!selected) return;
    setPendingConfirm({
      message: "Limpar todas as mensagens desta conversa? Esta ação não pode ser desfeita.",
      confirmLabel: "Limpar conversa",
      danger: true,
      onConfirm: () => void clearContactConversationConfirmed()
    });
  }

  async function clearContactConversationConfirmed() {
    setError("");
    try {
      await deleteConversationMessages(selectedRef.current);
      setMessages([]);
      setContactAssets([]);
      setAiTurn(null);
      setThreadConversation((current) => current ? { ...current, last_message: undefined } : current);
      setContactPanelOpen(false);
      setAssignmentNotice("Conversa limpa.");
      await Promise.all([mutateList(), mutateThread()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao limpar a conversa");
    }
  }

  async function saveContactName(name: string) {
    if (!selected) return;
    setError("");
    try {
      const result = await api<{ contact_name: string }>(`/conversations/${selected}/contact`, {
        method: "PATCH",
        body: JSON.stringify({ name })
      });
      setThreadConversation((current) => current ? { ...current, contact_name: result.contact_name } : current);
      setAssignmentNotice("Nome do contato atualizado.");
      await Promise.all([mutateList(), mutateThread()]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Falha ao editar o contato";
      setError(message);
      throw new Error(message);
    }
  }

  const loadContactAssetsPage = useCallback(async (
    conversationId: string,
    cursor: string | null,
    replace: boolean,
    fallbackMessages: ContactPanelMessage[]
  ) => {
    const requestId = contactAssetsRequestIdRef.current + 1;
    contactAssetsRequestIdRef.current = requestId;
    contactAssetsRequestRef.current?.abort();
    const controller = new AbortController();
    contactAssetsRequestRef.current = controller;
    setContactAssetsError("");
    if (replace) setContactAssetsLoading(true);
    else setContactAssetsLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("before", cursor);
      const response = await api<ConversationAssetsResponse>(`/conversations/${conversationId}/assets?${query.toString()}`, { signal: controller.signal });
      if (requestId !== contactAssetsRequestIdRef.current) return;
      setContactAssets((current) => replace ? response.messages : [...current, ...response.messages]);
      setContactAssetsHasMore(response.has_more);
      setContactAssetsCursor(response.next_cursor);
    } catch (caught) {
      if (controller.signal.aborted || requestId !== contactAssetsRequestIdRef.current) return;
      if (replace) {
        setContactAssets(fallbackMessages);
        setContactAssetsHasMore(false);
        setContactAssetsCursor(null);
      }
      setContactAssetsError(caught instanceof Error ? caught.message : "Não foi possível carregar o conteúdo compartilhado");
    } finally {
      if (requestId === contactAssetsRequestIdRef.current) {
        if (replace) setContactAssetsLoading(false);
        else setContactAssetsLoadingMore(false);
      }
    }
  }, []);

  const openContactPanel = useCallback((trigger: HTMLButtonElement) => {
    if (!selected) return;
    contactPanelReturnFocusRef.current = trigger;
    setContactPanelOpen(true);
    setContactAssets([]);
    setContactAssetsHasMore(false);
    setContactAssetsCursor(null);
    void loadContactAssetsPage(selected, null, true, messages);
  }, [loadContactAssetsPage, messages, selected]);

  const loadMoreContactAssets = useCallback(() => {
    if (!selected || !contactAssetsCursor || contactAssetsLoadingMore) return;
    void loadContactAssetsPage(selected, contactAssetsCursor, false, messages);
  }, [contactAssetsCursor, contactAssetsLoadingMore, loadContactAssetsPage, messages, selected]);

  const retryContactAssets = useCallback(() => {
    if (!selected || contactAssetsLoading || contactAssetsLoadingMore) return;
    if (contactAssetsHasMore && contactAssetsCursor) {
      void loadContactAssetsPage(selected, contactAssetsCursor, false, messages);
      return;
    }
    void loadContactAssetsPage(selected, null, true, messages);
  }, [contactAssetsCursor, contactAssetsHasMore, contactAssetsLoading, contactAssetsLoadingMore, loadContactAssetsPage, messages, selected]);

  return (
    <Shell flush activeConversationId={selected} onOpenConversation={setSelected}>
      <div className="conversation-screen flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="conversation-screen__header flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
          <h1>{hasWorkspaceScope ? "Conversas" : "Minhas conversas"}</h1>
          <span className="conversation-screen__summary mono">{items.length} na fila</span>

        </header>
        <div
          className="conversation-layout grid min-h-0 min-w-0 flex-1 overflow-hidden"
          data-contact-panel={contactPanelOpen ? "open" : "closed"}
          data-mobile-view={selected ? "thread" : "list"}
        >
        <aside className="conversation-list flex min-h-0 flex-col border-r border-[var(--border)] bg-transparent">
          <header className="conversation-list__header shrink-0 border-b border-[var(--border)] px-3.5 py-3">
            <div className="conversation-list__meta mb-3 flex items-start justify-between gap-3">
              <span className="mono shrink-0 rounded-full border border-[var(--border)] bg-transparent px-2 py-0.5 text-xs text-[var(--text-muted)]">
                {items.length}
              </span>
            </div>
            <label className="conversation-list__search search-field">
              <MagnifyingGlass className="shrink-0 text-[var(--text-muted)]" size={16} aria-hidden="true" />
              <span className="sr-only">Buscar conversa</span>
              <input
                className="input min-w-0"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nome, telefone ou tag"
                aria-label="Buscar conversa por nome ou telefone"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} className="search-clear" aria-label="Limpar busca">
                  <X size={15} />
                </button>
              ) : null}
            </label>
            <button
              type="button"
              className="btn mb-2 flex w-full items-center justify-between"
              aria-expanded={advancedFiltersOpen}
              aria-controls="conversation-advanced-filters"
              onClick={() => setAdvancedFiltersOpen((value) => !value)}
            >
              <span>Filtros{advancedFilterCount ? ` (${advancedFilterCount})` : ""}</span>
              <span aria-hidden="true">{advancedFiltersOpen ? "⌃" : "⌄"}</span>
            </button>
            {advancedFiltersOpen ? (
              <div id="conversation-advanced-filters" aria-label="Filtros avançados" className="mb-2 space-y-2">
                {showConnectionFilter ? (
                  <label className="field">
                    <span className="label">Número</span>
                    <select className="input py-2 text-xs" value={connectionFilter} onChange={(event) => setConnectionFilter(event.target.value)} aria-label="Número">
                      <option value="">Todos os números</option>
                      {connections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filas de atendimento">
                  <button type="button" aria-pressed={!queueFilter} className={`btn ${!queueFilter ? "primary" : ""}`} onClick={() => setQueueFilter("")}>Todas</button>
                  {(queueData?.queues ?? []).filter((queue) => !queue.archived_at && !queue.is_resolved).map((queue) => <button type="button" aria-pressed={queueFilter === queue.id} key={queue.id} className={`btn ${queueFilter === queue.id ? "primary" : ""}`} onClick={() => setQueueFilter(queue.id)}><span className="mr-1 inline-block size-2 rounded-full" style={{ backgroundColor: queue.color }} aria-hidden="true" />{queue.name} <span className="mono">{queue.conversation_count}</span></button>)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" disabled={!hasWorkspaceScope} aria-pressed={hasWorkspaceScope && filter === "mine"} className={`btn ${!hasWorkspaceScope || filter === "mine" ? "primary" : ""}`} onClick={() => { if (hasWorkspaceScope) setFilter(filter === "mine" ? "human" : "mine"); }}>Minhas conversas</button>
                  {hasWorkspaceScope ? <button type="button" aria-pressed={filter === "unassigned"} className={`btn ${filter === "unassigned" ? "primary" : ""}`} onClick={() => setFilter(filter === "unassigned" ? "human" : "unassigned")}>Sem responsável</button> : null}
                  <button type="button" aria-pressed={unreadOnly} className={`btn ${unreadOnly ? "primary" : ""}`} onClick={() => setUnreadOnly((value) => !value)}>Não lidas</button>
                  <button type="button" aria-pressed={pendingOnly} className={`btn ${pendingOnly ? "primary" : ""}`} onClick={() => setPendingOnly((value) => !value)}>Pendências</button>
                </div>
                <button type="button" className="btn" onClick={() => { setConnectionFilter(""); setQueueFilter(""); setFilter(hasWorkspaceScope ? "human" : "mine"); setUnreadOnly(false); setPendingOnly(false); setAdvancedFiltersOpen(false); }}>Limpar filtros</button>
              </div>
            ) : null}

            {hasWorkspaceScope ? (
              <div className="conversation-filter-tabs">
                {[
                  ["human", "Abertas", unreadCounts?.human],
                  ["ai", "IA", unreadCounts?.ai],
                  ["scheduled", "Agendadas", unreadCounts?.scheduled],
                  ["resolved", "Resolvidas", unreadCounts?.resolved]
                ].map(([key, label, count]) => (
                  <button
                    type="button"
                    key={key as string}
                    onClick={() => setFilter(key as string)}
                    aria-pressed={filter === key}
                    className="flex min-w-0 items-center justify-center gap-1 truncate"
                  >
                    <span className="truncate">{label}</span>
                    {Number(count) > 0 ? (
                      <span className="mono flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-xs font-semibold text-[var(--primary-foreground)]">
                        {Number(count) > 99 ? "99+" : count}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-[var(--primary-border)] px-3 py-1.5 text-xs font-medium text-[var(--primary-text)]">
                Minhas conversas abertas
              </div>
            )}

          </header>

          <div
            className="conversation-list__items min-h-0 flex-1 overflow-y-auto"
            tabIndex={0}
            aria-label="Lista de conversas"
          >
            {assignmentNotice ? <div className="mb-2.5 rounded-md border border-[var(--primary-border)] p-2.5 text-xs leading-relaxed text-[var(--primary-text)]" role="status">{assignmentNotice}</div> : null}
            {listError ? (
              <div className="mb-2.5 flex items-center justify-between gap-2 rounded-md border border-[var(--warning-border)] bg-transparent p-2.5 text-sm text-[var(--warning-text)]" role="alert">
                <span>Não foi possível carregar as conversas.</span>
                <button type="button" className="btn warn shrink-0" onClick={() => void mutateList()}>Tentar novamente</button>
              </div>
            ) : null}
            {listLoading && items.length === 0 ? (
              <div className="space-y-1.5 p-1">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="skeleton rounded-md border border-[var(--border)]" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <Empty>{debouncedQuery ? "Nenhuma conversa corresponde à busca." : "Nenhuma conversa neste filtro."}</Empty>
            ) : (
              <div className="space-y-1.5">
                {items.map((item: Conversation) => (
                  <ConversationItem key={item.id} item={item} selected={selected} showLeadTags={leadsEnabled} onClick={selectConversation} />
                ))}
                {listPageState.hasMore ? (
                  <div className="pt-1.5 text-center">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void loadOlderConversations()}
                      disabled={loadingOlderList}
                    >
                      {loadingOlderList ? "Carregando…" : "Carregar conversas anteriores"}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </aside>

        <section className="conversation-thread flex min-h-0 min-w-0 flex-col">
          {!selected ? (
            <div className="flex h-full items-center justify-center">
              <Empty>Selecione uma conversa.</Empty>
            </div>
          ) : threadError ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-md rounded-lg border border-[var(--warning-border)] bg-transparent p-5 text-[var(--warning-text)]" role="alert">
                <strong className="block text-sm">Falha ao carregar a conversa</strong>
                <p className="mt-2 text-sm leading-relaxed">{threadError.message}</p>
                <button type="button" className="btn warn mt-3" onClick={() => void mutateThread()}>Tentar novamente</button>
              </div>
            </div>
          ) : !thread.conversation ? (
            <div className="m-6 flex-1 rounded-lg border border-[var(--border)] bg-transparent">
              <div className="h-16 border-b border-[var(--border)]" />
              <div className="space-y-3 p-6">
                <div className="skeleton h-4 w-48 rounded-full" />
                <div className="skeleton h-3 w-28 rounded-full" />
                <div className="skeleton mt-6 h-20 rounded-lg" />
                <div className="skeleton h-20 rounded-lg" />
                <div className="skeleton h-10 rounded-lg" />
              </div>
            </div>
          ) : (
            <>
              <header className="conversation-thread__header shrink-0">
                <button
                  type="button"
                  className="conversation-thread__back shrink-0"
                  onClick={goBackToList}
                  aria-label="Voltar para a lista de conversas"
                  title="Voltar"
                >
                  <ArrowLeft size={18} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="conversation-thread__contact-trigger shrink-0"
                  onClick={(event) => openContactPanel(event.currentTarget)}
                  aria-label="Abrir dados do contato"
                  title="Dados do contato"
                >
                  <ContactAvatar
                    name={thread.conversation.channel === "instagram" ? instagramDisplayName(thread.conversation.contact_name, thread.conversation.instagram_username, thread.conversation.contact_identifier, thread.conversation.contact_phone) : thread.conversation.contact_name ?? thread.conversation.contact_phone ?? "Contato sem identificação"}
                    src={thread.conversation.avatar_url}
                    className="h-7 w-7 text-xs"
                  />
                </button>
                <div className="min-w-0">
                  <button
                    type="button"
                    className="conversation-thread__contact-name block max-w-full truncate text-left"
                    onClick={(event) => openContactPanel(event.currentTarget)}
                    title="Abrir dados do contato"
                  >
                    {thread.conversation.channel === "instagram" ? instagramDisplayName(thread.conversation.contact_name, thread.conversation.instagram_username, thread.conversation.contact_identifier, thread.conversation.contact_phone) : thread.conversation.contact_name ?? thread.conversation.contact_phone ?? "Contato sem identificação"}
                  </button>
                  <div className="conversation-thread__meta mt-0.5 overflow-hidden whitespace-nowrap">
                    <ChannelBadge channel={thread.conversation.channel === "instagram" ? "instagram" : "whatsapp"} size={13} />
                    {thread.conversation.channel !== "instagram" && threadConnectionLabel ? <><span className="shrink-0 text-[var(--text-muted)]">·</span><span className="shrink-0">Número: {threadConnectionLabel}</span></> : null}
                    <span className="shrink-0 text-[var(--text-muted)]">·</span>
                    <span className="mono" dir="ltr">{thread.conversation.channel === "instagram" ? instagramDisplayIdentity(thread.conversation.instagram_username, thread.conversation.contact_identifier) : thread.conversation.contact_phone ?? "telefone indisponível"}</span>
                    {thread.conversation.channel !== "instagram" ? <span className={`inline-flex items-center gap-1.5 ${contactIsOnline(thread.conversation) ? "text-[var(--primary-text)]" : "text-[var(--text-muted)]"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${contactIsOnline(thread.conversation) ? "animate-pulse bg-[var(--primary)]" : "bg-[var(--text-muted)]"}`} aria-hidden="true" />
                      {contactPresenceLabel(thread.conversation)}
                    </span> : null}
                    <ConversationBadge item={thread.conversation} />
                    {leadsEnabled ? <LeadTagChips tags={thread.conversation.tags} compact /> : null}
                    <span>{thread.conversation.assigned_user_email ? `Responsável: ${thread.conversation.assigned_user_email}` : "Sem responsável"}</span>
                    {thread.conversation.status === "closed" && thread.conversation.resolved_at ? <span>Resolvida em {new Date(thread.conversation.resolved_at).toLocaleString("pt-BR")}</span> : null}
                  </div>
                </div>
                <div className="conversation-thread__actions">
                  {leadsEnabled && thread.conversation.lead_id ? (
                    thread.conversation.pipeline_stage && thread.conversation.lead_updated_at ? (
                      <ConversationStatusPicker
                        leadId={thread.conversation.lead_id}
                        leadName={thread.conversation.contact_name}
                        leadPhone={thread.conversation.contact_phone ?? ""}
                        leadStatus={thread.conversation.lead_status ?? thread.conversation.pipeline_stage.technical_status}
                        leadUpdatedAt={thread.conversation.lead_updated_at}
                        pipelineStage={thread.conversation.pipeline_stage}
                        timezone={timezone}
                        onChanged={async () => { await Promise.all([mutateList(), mutateThread()]); }}
                      />
                    ) : null
                  ) : null}
                  {canReply ? thread.conversation.status === "closed"
                    ? <span className="text-xs text-[var(--text-secondary)]" aria-label="Fila atual">Fila: {thread.conversation.queue_name ?? "Sem fila"}</span>
                    : <label className="field"><span className="sr-only">Fila do atendimento</span><select className="input" aria-label="Fila do atendimento" value={thread.conversation.queue_id ?? ""} onChange={(event) => { if (event.target.value) void moveConversationToQueue(event.target.value); }}><option value="">Sem fila</option>{(queueData?.queues ?? []).filter((queue) => !queue.archived_at && !queue.is_resolved).map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></label>
                    : null}
                  {canReply && thread.conversation.status === "open" ? <button className="btn primary shrink-0 active:scale-95" onClick={resolveConversation} disabled={changingOwner || followUpPending}>
                    <CheckCircle size={14} aria-hidden="true" /> Resolver
                  </button> : null}
                  {canReply
                  && thread.conversation.status === "open"
                  && (hasWorkspaceScope || thread.conversation.assigned_user_id === session?.user.id) ? (
                    <PopoverMenu
                      buttonClassName="btn conversation-action-menu-trigger shrink-0 active:scale-95"
                      icon={<ArrowsLeftRight size={14} aria-hidden="true" />}
                      label="Transferir"
                      align="start"
                      panelClassName="conversation-action-menu__panel conversation-action-menu__panel--transfer"
                    >
                      {() => {
                        const conversation = thread.conversation;
                        if (!conversation) return null;
                        return (
                          <label className="field">
                            <span className="label">Novo responsável</span>
                            <select
                              className="input"
                              value={conversation.assigned_user_id ?? ""}
                              disabled={changingOwner}
                              onChange={(event) => void assignConversation(event.target.value)}
                              aria-label="Transferir responsável pela conversa"
                            >
                              {hasWorkspaceScope ? <option value="">Sem responsável</option> : null}
                              {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.email}</option>)}
                            </select>
                          </label>
                        );
                      }}
                    </PopoverMenu>
                  ) : null}
                  {thread.conversation ? (
                    <PopoverMenu
                      buttonClassName="btn conversation-action-menu-trigger shrink-0 active:scale-95"
                      icon={<DotsThreeVertical size={16} weight="bold" aria-hidden="true" />}
                      ariaLabel="Mais ações da conversa"
                      title="Mais ações"
                      panelClassName="conversation-action-menu__panel"
                    >
                      {() => {
                        const activeConversation = thread.conversation;
                        if (!activeConversation) return null;
                        return (
                          <>
                            {canSchedule ? <button className="conversation-action-menu__item" onClick={() => setSchedulerOpen(true)}><CalendarDots size={15} aria-hidden="true" />Agendar</button> : null}
                            {canReply && activeConversation.status === "open" && activeConversation.lead_id ? <button className="conversation-action-menu__item" onClick={() => void followUpConversation()} disabled={followUpPending || changingOwner}><ArrowClockwise size={15} aria-hidden="true" />{followUpPending ? "Enviando…" : "Follow-up"}</button> : null}
                            <button className="conversation-action-menu__item" onClick={() => void toggleNotificationMute()}>
                              {notificationPreferences?.muted_conversations.some((conversation) => conversation.id === selected)
                                ? <><BellRinging size={15} aria-hidden="true" />Reativar avisos</>
                                : <><BellSlash size={15} aria-hidden="true" />Silenciar conversa</>}
                            </button>
                            {canQueueEvaluation ? <button className="conversation-action-menu__item" onClick={queueManualEvaluation} disabled={queueingEvaluation}>
                              <Flask size={15} aria-hidden="true" />{queueingEvaluation ? "Enfileirando…" : "Avaliar com IA"}
                            </button> : null}
                            {hasWorkspaceScope && canReply && activeConversation.status === "open" && !activeConversation.assigned_user_id ? (
                              <button className="conversation-action-menu__item" onClick={claimConversation} disabled={changingOwner}>
                                <UserPlus size={15} aria-hidden="true" />
                                {changingOwner ? "Assumindo…" : "Assumir conversa"}
                              </button>
                            ) : null}
                            {canReply && activeConversation.channel !== "instagram" ? (
                              <label className="field px-3 py-2">
                                <span className="label">Assinatura do atendente</span>
                                <select
                                  className="input"
                                  value={activeConversation.signature_enabled === null || activeConversation.signature_enabled === undefined
                                    ? ""
                                    : String(activeConversation.signature_enabled)}
                                  onChange={(event) => void toggleSignature(event.target.value)}
                                  aria-label="Assinatura do atendente para este cliente"
                                >
                                  <option value="">Usar padrão</option>
                                  <option value="true">Ativada</option>
                                  <option value="false">Desativada</option>
                                </select>
                              </label>
                            ) : null}
                            {canReply && activeConversation.status === "closed" ? <button className="conversation-action-menu__item" onClick={reopenConversation} disabled={changingOwner}>
                              <CheckCircle size={15} aria-hidden="true" />
                              Reabrir conversa
                            </button> : null}
                            {activeConversation.status === "open" && canChangeAi ? (
                              <button className="conversation-action-menu__item" onClick={replyNowWithAi} disabled={requestingAiReply || changingAi}>
                                <ArrowClockwise size={15} aria-hidden="true" />
                                {requestingAiReply ? "Colocando na fila…" : "Responder agora com IA"}
                              </button>
                            ) : null}
                            {activeConversation.status === "open" && canChangeAi && !activeConversation.ai_active ? (
                              <button className="conversation-action-menu__item" onClick={reactivate} disabled={changingAi}>
                                <Robot size={15} aria-hidden="true" />
                                {changingAi ? "Alterando…" : "Reativar IA"}
                              </button>
                            ) : activeConversation.status === "open" && canChangeAi ? (
                              <button className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={pauseAi} disabled={changingAi}>
                                <Pause size={15} aria-hidden="true" />
                                {changingAi ? "Alterando…" : "Pausar IA neste contato"}
                              </button>
                            ) : null}
                          </>
                        );
                      }}
                    </PopoverMenu>
                  ) : null}
                </div>
              </header>

              {evaluationNotice ? <div className="shrink-0 border-b border-[var(--primary-border)] px-4 py-2 text-xs text-[var(--primary-text)]" role="status">{evaluationNotice}</div> : null}
              {aiActionNotice ? <div className="shrink-0 border-b border-[var(--primary-border)] px-4 py-2 text-xs text-[var(--primary-text)]" role="status">{aiActionNotice}</div> : null}

              {thread.conversation.status === "open" && !thread.conversation.ai_active ? (
                <div className="conversation-thread__pause flex shrink-0 items-center gap-2">
                  <Pause size={13} className="shrink-0" />
                  <p className="truncate leading-tight">
                    {thread.conversation.handoff_reason === "manually_paused"
                      ? "IA pausada manualmente para este contato — responda pelo painel ou celular."
                      : "Transferida para atendimento humano — responda pelo painel ou celular."}
                  </p>
                </div>
              ) : null}

              {thread.conversation.lead_id ? <div className="grid shrink-0 gap-2 border-b border-[var(--border)] p-3 lg:grid-cols-2"><ConversationPreBriefing source={thread.conversation.lead_source ?? null} campaign={thread.conversation.lead_campaign ?? null} interest={thread.conversation.interest ?? null} facebookAttribution={thread.conversation.facebook_attribution} /><ConversationNextAction leadId={thread.conversation.lead_id} nextAction={thread.conversation.next_action ?? null} nextActionAt={thread.conversation.next_action_at ?? null} assignedUserEmail={thread.conversation.assigned_user_email ?? null} timezone={timezone} canManage={canReply} onSaved={async () => { await Promise.all([mutateList(), mutateThread()]); }} /></div> : null}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="relative min-h-0 flex-1">
                  <div
                    ref={messagesRef}
                    onScroll={trackScroll}
                    className="conversation-history h-full overflow-y-auto px-3.5 py-4 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--primary-border)] sm:px-5"
                    role="region"
                    aria-label={`Histórico da conversa com ${thread.conversation.contact_name ?? thread.conversation.instagram_username ?? thread.conversation.contact_identifier ?? thread.conversation.contact_phone ?? "Contato sem identificação"}`}
                    tabIndex={0}
                  >
                    {hasMoreBefore ? (
                      <div className="mb-4 flex justify-center">
                        <button
                          type="button"
                          className="btn"
                          disabled={loadingOlder}
                          onClick={() => void loadOlderMessages()}
                        >
                          {loadingOlder ? "Carregando…" : "Carregar mensagens anteriores"}
                        </button>
                      </div>
                    ) : null}
                    <ConversationReferral attribution={thread.conversation.facebook_attribution} />
                    <div className="flex flex-col gap-2">
                      {messages.length === 0 && !aiTurn ? (
                        <div className="py-12">
                          <Empty>Sem mensagens nesta conversa.</Empty>
                        </div>
                      ) : (
                        messages.map((message: Message, index) => {
                          const separator = conversationMessageDateSeparator(
                            message,
                            messages[index - 1],
                            timezone
                          );
                          return (
                            <Fragment key={message.id}>
                              {separator ? <MessageDateSeparator label={separator} /> : null}
                              <MessageItem
                                conversationId={selected}
                                message={message}
                                timezone={timezone}
                                canManage={canReply}
                                onReply={setReplyTarget}
                                onReact={reactToMessage}
                                onEdit={editMessage}
                                onDelete={deleteMessage}
                                actionCapabilities={thread.conversation?.channel === "instagram"
                                  ? {
                                      reactions: channelCapabilities?.reactions === true,
                                      edit: channelCapabilities?.edit === true,
                                      delete: channelCapabilities?.delete === true
                                    }
                                  : undefined}
                              />
                            </Fragment>
                          );
                        })
                      )}
                      {aiTurn ? <AiTurnBubble progress={aiTurn} /> : null}
                    </div>
                  </div>

                  {showScrollToBottom ? (
                    <button
                      type="button"
                      onClick={() => scrollToBottom()}
                      className="btn conversation-thread__jump-latest absolute bottom-3 left-1/2 z-10 -translate-x-1/2"
                      aria-label="Ir para a mensagem mais recente"
                    >
                      <ArrowDown size={16} />
                    </button>
                  ) : null}
                </div>

                {canReply && thread.conversation.status === "open" && !thread.conversation.ai_active ? (
                  <ConversationComposer
                    key={selected}
                    conversationId={selected}
                    channel={thread.conversation.channel === "instagram" ? "instagram" : "whatsapp"}
                    replyTo={replyTarget}
                    onCancelReply={() => setReplyTarget(null)}
                    onError={setError}
                    capabilities={channelCapabilities}
                    capabilitiesError={channelCapabilitiesError}
                    onSent={async () => { setReplyTarget(null); await Promise.all([mutateList(), mutateThread()]); }}
                  />
                ) : <p className="shrink-0 border-t border-[var(--border)] p-4 text-center text-xs text-[var(--text-secondary)]">{thread.conversation.status === "closed" ? "Conversa resolvida. Reabra para continuar o atendimento." : thread.conversation.ai_active ? "A IA está ativa nesta conversa. Pause a IA antes de responder manualmente." : "Seu acesso permite consultar esta conversa, sem enviar mensagens."}</p>}
              </div>
            </>
          )}
        </section>

        {contactPanelOpen && thread.conversation ? (
          <ConversationContactPanel
            conversation={thread.conversation}
            messages={contactAssets}
            assetsLoading={contactAssetsLoading}
            assetsLoadingMore={contactAssetsLoadingMore}
            assetsHasMore={contactAssetsHasMore}
            assetsError={contactAssetsError}
            canEdit={canReply}
            returnFocus={contactPanelReturnFocusRef.current}
            onClose={() => setContactPanelOpen(false)}
            onLoadMoreAssets={loadMoreContactAssets}
            onRetryAssets={retryContactAssets}
            onClearConversation={clearContactConversation}
            onSaveContactName={saveContactName}
          />
        ) : null}
        </div>
      </div>

      {error ? (
        <div className="error fixed inset-x-4 bottom-20 flex items-start justify-between gap-3 rounded-lg border border-[var(--warning-border)] bg-[var(--bg)] p-3 sm:bottom-4 sm:left-auto sm:max-w-sm" role="alert">
          <span>{error}</span>
          <button type="button" className="shrink-0 rounded p-1 text-[var(--warning-text)]" onClick={() => setError("")} aria-label="Fechar aviso"><X size={15} aria-hidden="true" /></button>
        </div>
      ) : null}

      {appointmentsEnabled && schedulerOpen && thread.conversation ? (
        <ConversationScheduler
          conversationId={thread.conversation.id}
          contactName={thread.conversation.contact_name}
          contactPhone={thread.conversation.contact_phone ?? ""}
          onClose={() => setSchedulerOpen(false)}
        />
      ) : null}

      {pendingConfirm ? (
        <ModalDialog labelledBy="confirm-action-title" onClose={() => setPendingConfirm(null)}>
          <h2 id="confirm-action-title" className="text-base">Confirmar ação</h2>
          <p className="text-sm text-[var(--text-secondary)]">{pendingConfirm.message}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setPendingConfirm(null)}>Cancelar</button>
            <button
              type="button"
              className={`btn ${pendingConfirm.danger ? "warn" : "primary"}`}
              data-autofocus
              onClick={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
            >
              {pendingConfirm.confirmLabel}
            </button>
          </div>
        </ModalDialog>
      ) : null}
    </Shell>
  );
}

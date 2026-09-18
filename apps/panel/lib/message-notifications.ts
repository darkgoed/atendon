export type NotificationConversation = {
  id: string;
  contact_name?: string | null;
  contact_phone: string;
};

export type NotificationMessage = {
  id: string;
  sender: "contact" | "agent" | "human";
  content: string;
  media_type: "audio" | "image" | "document" | null;
  created_at: string;
};

export type NotificationThreadResponse = {
  conversation: NotificationConversation;
  messages: NotificationMessage[];
};

export type MessageNotification = {
  id: string;
  conversationId: string;
  contactName: string;
  preview: string;
};

export type PanelNotificationPreferences = {
  enabled: boolean;
  sound_enabled: boolean;
  visual_enabled: boolean;
  /** Som selecionado (contrato PATCH /me/notification-preferences; null = padrão). */
  sound_key?: string | null;
  /** Volume salvo em 0-100 (int|null). Runtime converte para ganho 0-1. */
  volume?: number | null;
};

export type PanelNotificationPreferencesResponse = {
  preferences: PanelNotificationPreferences;
  muted_conversations: Array<{
    id: string;
    contact_name: string | null;
    contact_phone: string;
    muted_at: string;
  }>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;
const TAB_PREFIX = "atendon:notification-tab:";
const SEEN_PREFIX = "atendon:notification-seen:";

export function claimPanelNotification(storage: StorageLike, tenantId: string, messageId: string, now = Date.now()): boolean {
  const key = `${SEEN_PREFIX}${tenantId}:${messageId}`;
  const previous = Number(storage.getItem(key));
  if (Number.isFinite(previous) && previous > now - 60_000) return false;
  storage.setItem(key, String(now));
  return true;
}

export function publishPanelTabState(
  storage: StorageLike,
  tenantId: string,
  tabId: string,
  state: { visible: boolean; activeConversationId?: string },
  now = Date.now()
) {
  storage.setItem(`${TAB_PREFIX}${tenantId}:${tabId}`, JSON.stringify({ ...state, at: now }));
}

export function clearPanelTabState(storage: StorageLike, tenantId: string, tabId: string) {
  storage.removeItem(`${TAB_PREFIX}${tenantId}:${tabId}`);
}

export function conversationVisibleInAnyPanelTab(
  storage: StorageLike,
  tenantId: string,
  conversationId: string,
  now = Date.now()
): boolean {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${TAB_PREFIX}${tenantId}:`)) continue;
    try {
      const state = JSON.parse(storage.getItem(key) ?? "null") as { visible?: boolean; activeConversationId?: string; at?: number } | null;
      if (state?.visible && state.activeConversationId === conversationId && Number(state.at) > now - 30_000) return true;
    } catch { /* ignora estado de outra aba corrompido */ }
  }
  return false;
}

const MESSAGE_PREVIEW_LENGTH = 60;
const CONTACT_MESSAGE_LOOKBACK_MS = 30_000;

export function messageNotificationFromThread(
  thread: NotificationThreadResponse,
  now = Date.now()
): MessageNotification | null {
  const latestMessage = thread.messages.at(-1);
  const contactMessage = [...thread.messages].reverse()
    .find((message) => message.sender === "contact");
  if (!contactMessage) return null;

  const contactMessageTime = new Date(contactMessage.created_at).getTime();
  const contactIsCurrent = latestMessage?.id === contactMessage.id
    || (Number.isFinite(contactMessageTime) && now - contactMessageTime <= CONTACT_MESSAGE_LOOKBACK_MS);
  if (!contactIsCurrent) return null;

  const contactName = thread.conversation.contact_name?.trim()
    || thread.conversation.contact_phone.trim()
    || "Contato";
  const content = contactMessage.content.trim();
  return {
    id: contactMessage.id,
    conversationId: thread.conversation.id,
    contactName,
    preview: content ? content.slice(0, MESSAGE_PREVIEW_LENGTH) : "[mídia]"
  };
}

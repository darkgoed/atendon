export type ConversationChannel = "whatsapp" | "instagram";

export interface ChannelCapabilitySource {
  channel: ConversationChannel;
  connection_status: string;
  connection_archived_at: Date | string | null;
  reconnect_required: boolean;
  token_expires_at: Date | string | null;
  instagram_contact_id: string | null;
  messaging_window_expires_at: Date | string | null;
}

export interface ChannelCapabilities {
  channel: ConversationChannel;
  can_send: boolean;
  reason: string | null;
  window_expires_at: string | null;
  text: boolean;
  image: boolean;
  audio: boolean;
  video: boolean;
  document: boolean;
  reactions: boolean;
  edit: boolean;
  delete: boolean;
  stickers: boolean;
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null): string | null {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export function channelCapabilities(
  source: ChannelCapabilitySource,
  now = Date.now()
): ChannelCapabilities {
  const connected = source.connection_status === "connected" && source.connection_archived_at === null;
  if (source.channel === "whatsapp") {
    return {
      channel: "whatsapp",
      can_send: connected,
      reason: connected ? null : "A conexão do WhatsApp está desconectada",
      window_expires_at: null,
      text: true,
      image: true,
      audio: true,
      video: true,
      document: true,
      reactions: true,
      edit: true,
      delete: true,
      stickers: true
    };
  }

  const tokenExpiry = timestamp(source.token_expires_at);
  const windowExpiry = timestamp(source.messaging_window_expires_at);
  let reason: string | null = null;
  if (!connected || source.reconnect_required || tokenExpiry === null || tokenExpiry <= now) {
    reason = "Reconecte a conta do Instagram antes de enviar mensagens";
  } else if (!source.instagram_contact_id) {
    reason = "A conversa não possui uma identidade Instagram válida";
  } else if (windowExpiry === null || windowExpiry <= now) {
    reason = "A janela de 24 horas do Instagram expirou";
  }

  return {
    channel: "instagram",
    can_send: reason === null,
    reason,
    window_expires_at: iso(source.messaging_window_expires_at),
    text: true,
    image: true,
    audio: true,
    video: true,
    document: true,
    reactions: false,
    edit: false,
    delete: false,
    stickers: false
  };
}

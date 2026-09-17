export type MediaType = "audio" | "image" | "document" | "video";
export type MessageChannel = "whatsapp" | "instagram";
export type MessageDeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface ReadReceipt {
  id: string;
  remoteJid: string;
  fromMe: boolean;
}

export interface InboundMessage {
  kind?: "contact";
  externalId: string;
  tenantId: string;
  sessionId: string;
  contactPhone: string;
  channel?: MessageChannel;
  instagramContactId?: string;
  instagramUsername?: string;
  contactJid?: string;
  contactName?: string;
  text: string;
  mediaType?: MediaType;
  mediaMimeType?: string;
  mediaFileName?: string;
  mediaSizeBytes?: number;
  mediaIsSticker?: boolean;
  /** Chave bruta do provedor (ex.: `mid` do Instagram). Quando presente,
   * compõe `messages.provider_message_key` e permite resolver respostas
   * citadas (reply_to) para a mensagem local sem depender do hash. */
  providerMessageKey?: string;
  /** `mid` da mensagem citada pelo contato (webhook `message.reply_to`). */
  replyToExternalId?: string;
  referral?: MessageReferral;
}

export interface MessageReferral {
  sourceType: "ad" | "post" | "unknown";
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  ctwaClid?: string;
  sourceApp?: string;
  /** Campos preenchidos pelo contato, quando o provedor os envia separadamente do texto. */
  prefilledFields?: Record<string, string>;
}

export interface HumanMessage {
  kind: "human";
  externalId: string;
  tenantId: string;
  sessionId: string;
  contactPhone: string;
  channel?: MessageChannel;
  instagramContactId?: string;
  instagramUsername?: string;
  contactJid?: string;
  text: string;
  mediaType?: MediaType;
  mediaMimeType?: string;
  mediaFileName?: string;
  mediaSizeBytes?: number;
  mediaIsSticker?: boolean;
}

export type SessionMessage = InboundMessage | HumanMessage;

export interface QuotedMessage {
  key: ReadReceipt;
  text: string;
}

export interface MessageGateway {
  sendText(sessionId: string, contactPhone: string, text: string, quoted?: QuotedMessage): Promise<{ externalId: string }>;
  sendPresence(sessionId: string, contactPhone: string, presence: "composing" | "paused", delayMs?: number): Promise<void>;
  markMessageAsRead(sessionId: string, receipts: ReadReceipt | ReadReceipt[]): Promise<void>;
  setPresence(sessionId: string, presence: "available" | "unavailable"): Promise<void>;
  refreshContactAvatar?(sessionId: string, contactPhone: string): Promise<void>;
  sendReaction?(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void>;
  sendReactionStrict?(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void>;
  updateText?(sessionId: string, destination: string, externalMessageId: string, text: string): Promise<void>;
  deleteMessageForEveryone?(sessionId: string, destination: string, receipt: ReadReceipt): Promise<void>;
  sendSticker?(sessionId: string, contactPhone: string, sticker: {
    dataBase64: string;
  }): Promise<{ externalId: string }>;
  sendMedia?(sessionId: string, contactPhone: string, media: {
    mediaType: MediaType;
    mimeType: string;
    fileName: string;
    dataBase64: string;
    caption?: string;
  }): Promise<{ externalId: string }>;
  downloadMedia?(sessionId: string, externalId: string): Promise<{
    base64: string;
    mimeType: string;
    fileName?: string;
  }>;
}

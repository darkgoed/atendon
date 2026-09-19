import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { signMediaUrl } from "../instagram/media.js";
import { prepareInstagramOutboundMedia } from "../instagram/media-transcode.js";
import type { InstagramRuntime, ProviderSendResult } from "../instagram/types.js";
import { WhatsAppSendRejectedError } from "../whatsapp/errors.js";
import type {
  InteractivePayload,
  MessagingCapabilityFlags,
  MessageGateway,
  QuotedMessage,
  ReadReceipt
} from "./types.js";

const INSTAGRAM_ADDRESS = /^ig:([A-Za-z0-9._-]{1,200})$/;
const PUBLIC_MEDIA_TTL_SECONDS = 15 * 60;
const PRIVATE_MEDIA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type Database = Pick<Pool, "connect" | "query">;
type SessionRoute = {
  tenantId: string;
  channel: "whatsapp" | "instagram";
  status: string;
  archivedAt: Date | null;
};
type GatewayMedia = NonNullable<Parameters<NonNullable<MessageGateway["sendMedia"]>>[2]>;

export class ChannelSendRejectedError extends WhatsAppSendRejectedError {
  readonly statusCode = 409;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChannelSendRejectedError";
  }
}

export class ChannelSendAmbiguousError extends Error {
  readonly sendOutcome = "ambiguous" as const;
  readonly statusCode = 409;
  readonly code = "SEND_OUTCOME_AMBIGUOUS";

  constructor(message: string) {
    super(message);
    this.name = "ChannelSendAmbiguousError";
  }
}

export class ChannelOperationUnsupportedError extends Error {
  readonly statusCode = 409;
  readonly code = "CHANNEL_OPERATION_UNSUPPORTED";

  constructor(operation: string) {
    super(`A operação ${operation} não é suportada no Instagram`);
    this.name = "ChannelOperationUnsupportedError";
  }
}

function badInstagramAddress(): Error {
  return Object.assign(new Error("Destino Instagram inválido"), {
    statusCode: 400,
    code: "INSTAGRAM_DESTINATION_INVALID"
  });
}

function mediaError(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: "INSTAGRAM_MEDIA_INVALID"
  });
}

function instagramRecipient(destination: string): string {
  const match = INSTAGRAM_ADDRESS.exec(destination);
  if (!match) throw badInstagramAddress();
  return match[1]!;
}

function startsWith(bytes: Buffer, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Buffer, offset: number, expected: string): boolean {
  return bytes.length >= offset + expected.length
    && bytes.subarray(offset, offset + expected.length).toString("ascii") === expected;
}

function matchesMediaMagic(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a");
    case "image/webp":
      return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
    case "application/pdf":
      return ascii(bytes, 0, "%PDF-");
    case "audio/aac":
      return ascii(bytes, 0, "ADIF")
        || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0);
    case "audio/mpeg":
      return ascii(bytes, 0, "ID3")
        || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    case "audio/wav":
    case "audio/x-wav":
      return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE");
    case "audio/ogg":
    case "video/ogg":
      return ascii(bytes, 0, "OggS");
    case "audio/webm":
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/flac":
      return ascii(bytes, 0, "fLaC");
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
    case "video/quicktime":
      return ascii(bytes, 4, "ftyp");
    default:
      return false;
  }
}

function instagramMediaType(media: GatewayMedia): "image" | "audio" | "video" | "file" {
  if (media.mediaType === "document") {
    if (media.mimeType !== "application/pdf") {
      throw mediaError("O Instagram aceita somente PDF como documento nesta integração");
    }
    return "file";
  }
  if (media.mediaType === "image" || media.mediaType === "audio" || media.mediaType === "video") {
    return media.mediaType;
  }
  throw mediaError("Tipo de mídia não suportado no Instagram");
}

function validateInstagramMedia(media: GatewayMedia, maxBytes: number): Buffer {
  const bytes = Buffer.from(media.dataBase64.replace(/^data:[^;,]+;base64,/i, ""), "base64");
  const mimeType = media.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (bytes.length > maxBytes) {
    throw mediaError(`A mídia excede o limite de ${maxBytes} bytes do Instagram`);
  }
  if (!bytes.length || !matchesMediaMagic(mimeType, bytes)) {
    throw mediaError("O conteúdo da mídia não corresponde ao formato informado");
  }
  return bytes;
}

function fileExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/ogg": "ogv",
    "video/webm": "webm",
    "application/pdf": "pdf"
  };
  return extensions[contentType] ?? "bin";
}

function providerResult(result: ProviderSendResult): { externalId: string } {
  if (result.outcome === "accepted") return { externalId: result.externalId };
  if (result.outcome === "rejected") throw new ChannelSendRejectedError(result.code, result.message);
  throw new ChannelSendAmbiguousError(result.message);
}

export class ChannelGatewayRouter implements MessageGateway {
  constructor(
    private readonly database: Database,
    private readonly whatsappGateway: MessageGateway,
    private readonly instagramRuntime: InstagramRuntime,
    private readonly runtimeConfig: AppConfig
  ) {}

  private async route(sessionId: string): Promise<SessionRoute> {
    const result = await this.database.query<{
      tenant_id: string;
      channel: "whatsapp" | "instagram";
      status: string;
      archived_at: Date | null;
    }>(
      `SELECT tenant_id,channel,status,archived_at
       FROM whatsapp_sessions WHERE id=$1`,
      [sessionId]
    );
    const row = result.rows[0];
    if (!row || row.archived_at) {
      throw Object.assign(new Error("Conexão não encontrada"), { statusCode: 404, code: "CONNECTION_NOT_FOUND" });
    }
    return {
      tenantId: row.tenant_id,
      channel: row.channel,
      status: row.status,
      archivedAt: row.archived_at
    };
  }

  private unsupported(operation: string): never {
    throw new ChannelOperationUnsupportedError(operation);
  }

  async sendText(sessionId: string, destination: string, text: string, quoted?: QuotedMessage): Promise<{ externalId: string }> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      return this.whatsappGateway.sendText(sessionId, destination, text, quoted);
    }
    // O Send API do Instagram aceita respostas citadas (`reply_to.mid` na raiz
    // do payload, ao lado de `message` — doc "Send a message", Instagram
    // Messaging). O id citado precisa ser o `mid` bruto do provedor, que o
    // app.ts resolve de provider_message_key; mensagens antigas chegam aqui
    // com o external_id com hash (`ig_...`) e são bloqueadas antes.
    return providerResult(await this.instagramRuntime.gateway.sendText({
      tenantId: route.tenantId,
      connectionId: sessionId,
      recipientId: instagramRecipient(destination),
      text,
      ...(quoted?.key.id ? { replyTo: quoted.key.id } : {})
    }));
  }

  async sendMedia(sessionId: string, destination: string, media: GatewayMedia): Promise<{ externalId: string }> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.sendMedia) this.unsupported("enviar mídia");
      return this.whatsappGateway.sendMedia(sessionId, destination, media);
    }

    const recipientId = instagramRecipient(destination);
    const type = instagramMediaType(media);
    const bytes = validateInstagramMedia(media, this.runtimeConfig.INSTAGRAM_MEDIA_MAX_BYTES);
    // Formatos que o gravador do painel produz (WebM/Opus no Chrome, OGG no
    // Firefox, WebP nas imagens) não são aceitos pelo Send API do Instagram —
    // audio aceita aac/m4a/wav/mp4 e imagem png/jpeg. Converte para o formato
    // documentado antes de publicar a URL que a Meta vai baixar.
    const prepared = await prepareInstagramOutboundMedia({
      mediaType: type,
      mimeType: media.mimeType,
      bytes
    });
    const conversation = await withTenantTransaction(this.database, route.tenantId, async (client) => client.query<{ id: string }>(
      `SELECT id FROM conversations
       WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3`,
      [route.tenantId, sessionId, recipientId]
    ));
    if (!conversation.rows[0]) {
      throw Object.assign(new Error("Conversa Instagram não encontrada"), { statusCode: 404, code: "INSTAGRAM_CONVERSATION_NOT_FOUND" });
    }
    const saved = await this.instagramRuntime.repository.savePublicMedia({
      tenantId: route.tenantId,
      sessionId,
      conversationId: conversation.rows[0].id,
      bytes: prepared.bytes,
      contentType: prepared.contentType,
      expiresAt: new Date(Date.now() + PUBLIC_MEDIA_TTL_SECONDS * 1_000)
    });
    const signature = signMediaUrl(saved.id, this.runtimeConfig.DATA_ENCRYPTION_KEY, PUBLIC_MEDIA_TTL_SECONDS);
    const url = new URL(`/api/instagram/media/${saved.id}`, this.runtimeConfig.PANEL_PUBLIC_URL);
    url.searchParams.set("signature", signature);
    return providerResult(await this.instagramRuntime.gateway.sendMedia({
      tenantId: route.tenantId,
      connectionId: sessionId,
      recipientId,
      media: { type, url: url.toString() }
    }));
  }

  async downloadMedia(sessionId: string, externalId: string): Promise<{ base64: string; mimeType: string; fileName?: string }> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.downloadMedia) this.unsupported("baixar mídia");
      return this.whatsappGateway.downloadMedia(sessionId, externalId);
    }

    // The inbox dispatcher stores the deterministic, namespaced external id.
    // `inbound:<id>` remains readable for rows created by the pre-dispatch
    // fallback used during rolling upgrades.
    const storageKey = externalId;
    const cached = await withTenantTransaction(this.database, route.tenantId, async (client) => client.query<{
      media_data: Buffer;
      content_type: string;
    }>(
      `SELECT media_data,content_type FROM instagram_media
       WHERE tenant_id=$1 AND session_id=$2
         AND storage_key=ANY($3::text[]) AND expires_at>now()
       ORDER BY created_at DESC LIMIT 1`,
      [route.tenantId, sessionId, [storageKey, `inbound:${externalId}`]]
    ));
    if (cached.rows[0]) {
      return {
        base64: cached.rows[0].media_data.toString("base64"),
        mimeType: cached.rows[0].content_type,
        fileName: `instagram-${externalId.slice(-24)}.${fileExtension(cached.rows[0].content_type)}`
      };
    }

    const metadata = await withTenantTransaction(this.database, route.tenantId, async (client) => client.query<{
      conversation_id: string | null;
      raw_mid: string;
      media_url: string;
    }>(
      `SELECT conversation.id conversation_id,
              inbox.payload #>> '{message,mid}' raw_mid,
              attachment.item #>> '{payload,url}' media_url
       FROM instagram_webhook_inbox inbox
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(inbox.payload #> '{message,attachments}')='array'
              THEN inbox.payload #> '{message,attachments}' ELSE '[]'::jsonb END
       ) attachment(item)
       LEFT JOIN conversations conversation
         ON conversation.tenant_id=inbox.tenant_id
        AND conversation.session_id=inbox.session_id
        AND conversation.instagram_contact_id=inbox.payload #>> '{sender,id}'
       LEFT JOIN messages message
         ON message.conversation_id=conversation.id
        AND message.external_message_id=$3
       WHERE inbox.tenant_id=$1 AND inbox.session_id=$2
         AND attachment.item #>> '{payload,url}' IS NOT NULL
         AND (
           inbox.provider_event_id='message:' || $3
           OR inbox.payload #>> '{message,mid}'=$3
           OR (
             message.id IS NOT NULL
             AND (
               message.provider_message_key=inbox.payload #>> '{message,mid}'
               OR right(message.provider_message_key,length(inbox.payload #>> '{message,mid}'))=inbox.payload #>> '{message,mid}'
             )
           )
         )
       ORDER BY inbox.received_at DESC
       LIMIT 1`,
      [route.tenantId, sessionId, externalId]
    ));
    const source = metadata.rows[0];
    if (!source?.media_url || !source.raw_mid) {
      throw Object.assign(new Error("Mídia Instagram não encontrada"), { statusCode: 404, code: "INSTAGRAM_MEDIA_NOT_FOUND" });
    }
    const accessToken = await this.instagramRuntime.repository.getToken(route.tenantId, sessionId);
    const downloaded = await this.instagramRuntime.provider.fetchMedia({ url: source.media_url, accessToken });
    const saved = await this.instagramRuntime.repository.savePublicMedia({
      tenantId: route.tenantId,
      sessionId,
      conversationId: source.conversation_id,
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
      expiresAt: new Date(Date.now() + PRIVATE_MEDIA_RETENTION_MS),
      sourceUrl: downloaded.finalUrl,
      storageKey
    });
    void saved;
    return {
      base64: downloaded.bytes.toString("base64"),
      mimeType: downloaded.contentType,
      fileName: `instagram-${source.raw_mid.slice(-24)}.${fileExtension(downloaded.contentType)}`
    };
  }

  async sendPresence(sessionId: string, destination: string, presence: "composing" | "paused", delayMs?: number): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      await this.whatsappGateway.sendPresence(sessionId, destination, presence, delayMs);
      return;
    }
    instagramRecipient(destination);
    // Meta sender actions are intentionally not advertised until the selected
    // Instagram Login endpoint is verified. This local no-op is only AI pacing.
  }

  async markMessageAsRead(sessionId: string, receipts: ReadReceipt | ReadReceipt[]): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") await this.whatsappGateway.markMessageAsRead(sessionId, receipts);
    // Instagram webhook/read state remains local; no external read claim is made.
  }

  async setPresence(sessionId: string, presence: "available" | "unavailable"): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") await this.whatsappGateway.setPresence(sessionId, presence);
    // Account-level presence has no equivalent in the selected Meta contract.
  }

  async refreshContactAvatar(sessionId: string, contactPhone: string): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      await this.whatsappGateway.refreshContactAvatar?.(sessionId, contactPhone);
      return;
    }
    // O mesmo throttle de 6h do WhatsApp (session-manager.ts) evita gastar
    // uma chamada de Graph por mensagem; instagram/dispatch.ts já cobre o
    // caminho de inbound novo, então este branch cobre outras origens que
    // chamem refreshContactAvatar diretamente para o mesmo contato.
    const recipientId = instagramRecipient(contactPhone);
    const claimed = await withTenantTransaction(this.database, route.tenantId, async (client) => client.query<{ id: string }>(
      `UPDATE conversations
       SET contact_avatar_updated_at=now()
       WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3
         AND (contact_avatar_updated_at IS NULL OR contact_avatar_updated_at < now() - interval '6 hours')
       RETURNING id`,
      [route.tenantId, sessionId, recipientId]
    ));
    if (!claimed.rows[0]) return;
    try {
      const accessToken = await this.instagramRuntime.repository.getToken(route.tenantId, sessionId);
      const profile = await this.instagramRuntime.provider.fetchUserProfile({
        instagramScopedUserId: recipientId,
        accessToken
      });
      if (!profile.profilePictureUrl) return;
      await this.database.query(
        `UPDATE conversations SET contact_avatar_url=$4
         WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3`,
        [route.tenantId, sessionId, recipientId, profile.profilePictureUrl]
      );
    } catch {
      // Best effort: falha na Graph API não pode derrubar o fluxo do
      // chamador; a foto simplesmente permanece desatualizada até a
      // próxima janela de 6h.
    }
  }

  async sendReaction(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.sendReaction) this.unsupported("reagir");
      await this.whatsappGateway.sendReaction(sessionId, contactPhone, receipt, emoji);
      return;
    }
    this.unsupported("reagir");
  }

  async sendReactionStrict(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.sendReactionStrict) this.unsupported("reagir");
      await this.whatsappGateway.sendReactionStrict(sessionId, contactPhone, receipt, emoji);
      return;
    }
    this.unsupported("reagir");
  }

  async updateText(sessionId: string, destination: string, externalMessageId: string, text: string): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.updateText) this.unsupported("editar mensagem");
      await this.whatsappGateway.updateText(sessionId, destination, externalMessageId, text);
      return;
    }
    this.unsupported("editar mensagem");
  }

  async deleteMessageForEveryone(sessionId: string, destination: string, receipt: ReadReceipt): Promise<void> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.deleteMessageForEveryone) this.unsupported("apagar mensagem para todos");
      await this.whatsappGateway.deleteMessageForEveryone(sessionId, destination, receipt);
      return;
    }
    this.unsupported("apagar mensagem para todos");
  }

  async sendSticker(sessionId: string, contactPhone: string, sticker: { dataBase64: string }): Promise<{ externalId: string }> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.sendSticker) this.unsupported("enviar figurinha");
      return this.whatsappGateway.sendSticker(sessionId, contactPhone, sticker);
    }
    return this.unsupported("enviar figurinha");
  }

  async sendInteractive(sessionId: string, contactPhone: string, payload: InteractivePayload): Promise<{ externalId: string }> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      if (!this.whatsappGateway.sendInteractive) this.unsupported("mensagem interativa");
      return this.whatsappGateway.sendInteractive(sessionId, contactPhone, payload);
    }
    this.unsupported("mensagem interativa");
  }

  async sessionMessagingCapabilities(sessionId: string): Promise<MessagingCapabilityFlags> {
    const route = await this.route(sessionId);
    if (route.channel === "whatsapp") {
      const gateway = this.whatsappGateway;
      return {
        reactions: Boolean(gateway.sendReaction || gateway.sendReactionStrict),
        forward_media: Boolean(gateway.sendMedia && gateway.downloadMedia),
        interactive: Boolean(gateway.sendInteractive)
      };
    }
    return { reactions: false, forward_media: false, interactive: false };
  }
}

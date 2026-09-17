import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { InstagramRepository } from "./repository.js";
import type { InstagramService } from "./service.js";
import type { InstagramProvider, InstagramRuntime } from "./types.js";
import type { MessageRepository } from "../messages/repository.js";
import type { MediaType, SessionMessage } from "../messages/types.js";

export interface InstagramInboxRow {
  id: string;
  tenant_id: string;
  session_id: string;
  provider_event_id: string;
  account_id: string;
  payload: unknown;
}

export type InstagramDispatchResult =
  | "inbound_enqueued"
  | "echo_confirmed"
  | "human_echo_recorded"
  | "read_updated"
  | "reaction_updated"
  | "non_message_observed";

export type InstagramInboxDispatcher = (row: Record<string, unknown>) => Promise<InstagramDispatchResult>;

export interface InstagramInboxDispatcherOptions {
  database: Pick<Pool, "query">;
  instagram: Pick<InstagramRuntime, "repository" | "provider"> | {
    repository: InstagramRepository;
    provider: InstagramProvider;
  };
  messages: MessageRepository;
  enqueueInbound(message: SessionMessage): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedId(value: unknown): string | null {
  const item = record(value);
  return item && typeof item.id === "string" && item.id.length > 0 ? item.id : null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Instagram inbox ${label} is missing`);
  return value;
}

function typedRow(value: Record<string, unknown>): InstagramInboxRow {
  return {
    id: requireString(value.id, "id"),
    tenant_id: requireString(value.tenant_id, "tenant"),
    session_id: requireString(value.session_id, "session"),
    provider_event_id: requireString(value.provider_event_id, "provider event id"),
    account_id: requireString(value.account_id, "account"),
    payload: value.payload
  };
}

export function instagramInboundExternalId(tenantId: string, sessionId: string, providerMessageId: string): string {
  const digest = createHash("sha256")
    .update("instagram-inbound\0")
    .update(tenantId)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(providerMessageId)
    .digest("base64url");
  return `ig_${digest}`;
}

// A Meta não garante que `attachments[].type` declarado no JSON do webhook
// (image/audio/video/file/...) corresponda exatamente ao Content-Type real
// do arquivo. Por isso classificamos pelo Content-Type REAL detectado no
// download (já validado por assinatura mágica em
// provider.ts::matchesMimeMagic), não pelo `type` declarado pelo webhook.
function mediaTypeFromContentType(contentType: string): MediaType | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (contentType === "application/pdf") return "document";
  return null;
}

// Tipos de attachment cujo payload.url aponta para o arquivo de mídia bruto
// na CDN da Meta (lookaside.fbsbx.com), servido diretamente com o
// Content-Type real — únicos seguros para download binário. Confirmado em
// produção: `ig_reel`/`reel` (e, pela mesma natureza de "referência a post"
// em vez de arquivo, também `share`/`story_mention`) trazem em payload.url a
// PÁGINA do post/reel (ex. https://www.instagram.com/reel/...), não um
// arquivo — tentar baixar sempre falha com "Unsupported media type" e
// desperdiça uma chamada. Para esses, ver referencePostFallbackText() logo
// abaixo: viram texto com link em vez de uma tentativa de download.
const DOWNLOADABLE_ATTACHMENT_TYPES = new Set(["image", "audio", "video", "file"]);
// Tipos que referenciam um post/reel/story do Instagram por página (não por
// arquivo de mídia bruto) — sempre viram texto com link, nunca uma
// tentativa de download que sabemos que vai falhar.
const POST_REFERENCE_ATTACHMENT_TYPES = new Set(["ig_reel", "reel", "share", "story_mention"]);

function attachmentUrl(attachment: Record<string, unknown>): string | null {
  if (!DOWNLOADABLE_ATTACHMENT_TYPES.has(String(attachment.type))) return null;
  const url = record(attachment.payload)?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

// Melhor esforço para não perder o conteúdo de attachments sem URL baixável
// (ex.: `template` reencaminhado por automações tipo ManyChat, ou
// `ig_reel`/`reel`/`share`/`story_mention` cuja URL é a página do post, não
// o arquivo) ou mensagens marcadas `is_unsupported`. Nunca deve lançar: vira
// apenas o texto da mensagem, preservando a conversa/identidade em vez de
// derrubar o evento em retry infinito por um formato de payload
// conhecido-mas-não-suportado.
function unsupportedContentFallbackText(attachment: Record<string, unknown> | null): string {
  if (attachment?.type === "template") {
    const generic = record(record(attachment.payload)?.generic);
    const elements = Array.isArray(generic?.elements) ? generic!.elements : [];
    const first = record(elements[0]);
    const title = typeof first?.title === "string" ? first.title.trim() : "";
    if (title) return title;
  }
  if (attachment && POST_REFERENCE_ATTACHMENT_TYPES.has(String(attachment.type))) {
    const payload = record(attachment.payload);
    const url = typeof payload?.url === "string" ? payload.url : "";
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const kind = attachment.type === "ig_reel" || attachment.type === "reel" ? "reel"
      : attachment.type === "story_mention" ? "story" : "post";
    const label = `[${kind === "reel" ? "Reel" : kind === "story" ? "Story" : "Post"} do Instagram compartilhado]`;
    return [title, label, url].filter(Boolean).join("\n");
  }
  return "[Conteúdo não suportado recebido pelo Instagram]";
}

function mediaFileName(type: MediaType, contentType: string): string {
  const extension = contentType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `instagram-${type}.${extension}`;
}

async function conversationIdFor(
  database: Pick<Pool, "query">,
  row: InstagramInboxRow,
  instagramContactId: string
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `SELECT id FROM conversations
     WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3 AND contact_phone IS NULL`,
    [row.tenant_id, row.session_id, instagramContactId]
  );
  if (!result.rows[0]) throw new Error("Instagram inbox conversation is missing");
  return result.rows[0].id;
}

const AVATAR_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * O webhook de mensagem só entrega o IGSID numérico do remetente: sem esta
 * busca, `conversations.instagram_username`/`contact_name`/`contact_avatar_url`
 * ficam NULL para sempre e o painel cai no fallback "Identidade do Instagram
 * indisponível". Consulta a Graph API sob demanda apenas quando ainda falta
 * identidade OU a foto está velha (mesma janela de 6h usada pelo WhatsApp em
 * session-manager.ts), para não gastar uma chamada de Graph por mensagem.
 * Nunca lança: qualquer falha aqui é enriquecimento perdido, não motivo para
 * derrubar o processamento da mensagem. Chamada ANTES do processamento de
 * mídia (ver createInstagramInboxDispatcher) para que uma falha ao baixar um
 * anexo nunca impeça a identidade do contato de ser gravada.
 */
async function enrichInstagramContact(
  options: InstagramInboxDispatcherOptions,
  row: InstagramInboxRow,
  instagramContactId: string
): Promise<{ instagramUsername?: string; contactName?: string }> {
  const current = await options.database.query<{
    instagram_username: string | null;
    contact_name: string | null;
    contact_avatar_updated_at: Date | string | null;
  }>(
    `SELECT instagram_username, contact_name, contact_avatar_updated_at
     FROM conversations
     WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3`,
    [row.tenant_id, row.session_id, instagramContactId]
  );
  const conversation = current.rows[0];
  const identityKnown = Boolean(conversation?.instagram_username || conversation?.contact_name);
  const avatarUpdatedAt = conversation?.contact_avatar_updated_at
    ? new Date(conversation.contact_avatar_updated_at).getTime()
    : 0;
  const avatarStale = Date.now() - avatarUpdatedAt > AVATAR_REFRESH_INTERVAL_MS;
  if (identityKnown && !avatarStale) return {};

  try {
    const token = await options.instagram.repository.getToken(row.tenant_id, row.session_id);
    const profile = await options.instagram.provider.fetchUserProfile({
      instagramScopedUserId: instagramContactId,
      accessToken: token
    });
    // Sempre grava contact_avatar_updated_at (mesmo sem foto nova) para não
    // reconsultar a Graph a cada mensagem quando ela não tem a foto ainda.
    await options.database.query(
      `UPDATE conversations
       SET contact_avatar_url=COALESCE($4,contact_avatar_url), contact_avatar_updated_at=now()
       WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3`,
      [row.tenant_id, row.session_id, instagramContactId, profile.profilePictureUrl]
    );
    return {
      instagramUsername: !conversation?.instagram_username && profile.username ? profile.username : undefined,
      contactName: !conversation?.contact_name && profile.name ? profile.name : undefined
    };
  } catch {
    return {};
  }
}

export function createInstagramInboxDispatcher(options: InstagramInboxDispatcherOptions): InstagramInboxDispatcher {
  return async (untypedRow) => {
    const row = typedRow(untypedRow);
    const payload = record(row.payload);
    if (!payload) throw new Error("Instagram inbox payload is invalid");
    const senderId = nestedId(payload.sender);
    const recipientId = nestedId(payload.recipient);
    if (!senderId || !recipientId) throw new Error("Instagram inbox sender or recipient is missing");

    const message = record(payload.message);
    if (message) {
      const rawMid = requireString(message.mid, "message mid");
      const isEcho = senderId === row.account_id || message.is_echo === true || message.is_self === true;
      const instagramContactId = isEcho ? recipientId : senderId;
      if (isEcho) {
        const known = await options.messages.confirmInstagramEcho({
          tenantId: row.tenant_id,
          sessionId: row.session_id,
          externalId: rawMid
        });
        if (known) return "echo_confirmed";
        await options.messages.recordHuman({
          kind: "human",
          channel: "instagram",
          externalId: rawMid,
          tenantId: row.tenant_id,
          sessionId: row.session_id,
          contactPhone: `ig:${instagramContactId}`,
          instagramContactId,
          text: typeof message.text === "string" ? message.text : ""
        });
        return "human_echo_recorded";
      }

      // Enriquecimento de identidade roda ANTES do processamento de mídia e
      // de forma independente dele: enrichInstagramContact é best-effort
      // (nunca lança), mas se ficasse depois do bloco de mídia, uma falha ao
      // baixar um anexo (ex.: attachment sem URL suportada) impediria para
      // sempre que a conversa recebesse username/nome/foto — era exatamente
      // o que causava contatos chegando "sem nome e @" em produção.
      const enrichment = await enrichInstagramContact(options, row, instagramContactId);

      const externalId = instagramInboundExternalId(row.tenant_id, row.session_id, rawMid);
      let inboundMedia: Pick<SessionMessage, "mediaType" | "mediaMimeType" | "mediaFileName" | "mediaSizeBytes"> = {};
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.map(record).filter((attachment): attachment is Record<string, unknown> => attachment !== null)
        : [];
      // Prefere o primeiro attachment com URL baixável; se nenhum tiver URL
      // (ex.: só veio um `template`), cai no fallback de texto mais abaixo.
      const downloadableAttachment = attachments.find((attachment) => attachmentUrl(attachment) !== null);
      const firstAttachment = attachments[0] ?? null;

      if (downloadableAttachment) {
        const url = attachmentUrl(downloadableAttachment)!;
        const token = await options.instagram.repository.getToken(row.tenant_id, row.session_id);
        const downloaded = await options.instagram.provider.fetchMedia({ url, accessToken: token });
        const type = mediaTypeFromContentType(downloaded.contentType);
        if (!type) throw new Error("Instagram inbox media attachment has an unsupported content type");
        const conversationId = await conversationIdFor(options.database, row, instagramContactId);
        await options.instagram.repository.savePublicMedia({
          tenantId: row.tenant_id,
          sessionId: row.session_id,
          conversationId,
          bytes: downloaded.bytes,
          contentType: downloaded.contentType,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          sourceUrl: downloaded.finalUrl,
          storageKey: externalId
        });
        inboundMedia = {
          mediaType: type,
          mediaMimeType: downloaded.contentType,
          mediaFileName: mediaFileName(type, downloaded.contentType),
          mediaSizeBytes: downloaded.sizeBytes
        };
      }

      let text = typeof message.text === "string" ? message.text : "";
      // Attachment presente mas sem URL baixável (ex.: `template`), ou
      // mensagem explicitamente marcada como não suportada pela Meta: nunca
      // derruba o processamento — vira texto de fallback para preservar a
      // conversa/identidade em vez de ficar em retry infinito para sempre
      // (instagram_webhook_inbox não tem backoff/DLQ).
      if (!text && !inboundMedia.mediaType) {
        if (firstAttachment || message.is_unsupported === true) {
          text = unsupportedContentFallbackText(firstAttachment);
        } else {
          throw new Error("Instagram inbox message has no supported content");
        }
      }
      await options.enqueueInbound({
        channel: "instagram",
        externalId,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        contactPhone: `ig:${instagramContactId}`,
        instagramContactId,
        ...enrichment,
        text,
        ...inboundMedia
      });
      return "inbound_enqueued";
    }

    const read = record(payload.read);
    if (read) {
      const externalId = requireString(read.mid, "read mid");
      await options.messages.updateMessageStatus({
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        externalId,
        status: "read"
      });
      return "read_updated";
    }

    const reaction = record(payload.reaction);
    if (reaction) {
      const externalId = requireString(reaction.mid, "reaction mid");
      if (reaction.action !== "react" && reaction.action !== "unreact") {
        throw new Error("Instagram inbox reaction action is invalid");
      }
      await options.messages.updateInstagramMessageReaction({
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        externalId,
        emoji: reaction.action === "unreact" ? null : typeof reaction.emoji === "string" ? reaction.emoji : null
      });
      return "reaction_updated";
    }

    if (record(payload.postback) || record(payload.referral)) return "non_message_observed";
    throw new Error(`Instagram inbox event ${row.provider_event_id} has no supported effect`);
  };
}

export async function drainInstagramInboxTenant(
  service: Pick<InstagramService, "drainWebhookEvents">,
  tenantId: string,
  dispatch: InstagramInboxDispatcher
): Promise<number> {
  return service.drainWebhookEvents(tenantId, async (row) => {
    await dispatch(row);
  });
}

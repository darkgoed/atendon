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

function mediaType(value: unknown): MediaType | null {
  if (value === "image" || value === "audio" || value === "video") return value;
  if (value === "file") return "document";
  return null;
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

      const externalId = instagramInboundExternalId(row.tenant_id, row.session_id, rawMid);
      let inboundMedia: Pick<SessionMessage, "mediaType" | "mediaMimeType" | "mediaFileName" | "mediaSizeBytes"> = {};
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      const firstAttachment = attachments.map(record).find((attachment) => attachment !== null);
      if (firstAttachment) {
        const type = mediaType(firstAttachment.type);
        const url = record(firstAttachment.payload)?.url;
        if (!type || typeof url !== "string" || url.length === 0) {
          throw new Error("Instagram inbox media attachment is unsupported");
        }
        const token = await options.instagram.repository.getToken(row.tenant_id, row.session_id);
        const downloaded = await options.instagram.provider.fetchMedia({ url, accessToken: token });
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
      const text = typeof message.text === "string" ? message.text : "";
      if (!text && !inboundMedia.mediaType) throw new Error("Instagram inbox message has no supported content");
      await options.enqueueInbound({
        channel: "instagram",
        externalId,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        contactPhone: `ig:${instagramContactId}`,
        instagramContactId,
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

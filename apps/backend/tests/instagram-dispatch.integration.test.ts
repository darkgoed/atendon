import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import {
  createInstagramInboxDispatcher,
  drainInstagramInboxTenant,
  instagramInboundExternalId
} from "../src/modules/instagram/index.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { InstagramService } from "../src/modules/instagram/service.js";
import type { InstagramProvider, NormalizedInstagramEvent } from "../src/modules/instagram/types.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import type { SessionMessage } from "../src/modules/messages/types.js";
import { inboundJobId } from "../src/queue/message-queue.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-dispatch-key-0000000000000001";
let tenantId = "";
let sessionId = "";
let accountId = "";
let contactId = "";
let conversationId = "";
const enqueued: SessionMessage[] = [];

const provider: InstagramProvider = {
  exchangeOAuthCode: vi.fn(), refreshAccessToken: vi.fn(), subscribeWebhook: vi.fn(),
  sendText: vi.fn(), sendMedia: vi.fn(),
  fetchMedia: vi.fn().mockResolvedValue({
    bytes: Buffer.from("video-bytes"), contentType: "video/mp4", sizeBytes: 11,
    finalUrl: "https://lookaside.instagram.test/video.mp4"
  })
};

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram dispatch ${randomUUID()}`]
  )).rows[0].id;
  const repository = new InstagramRepository(pool, key);
  accountId = `account-${randomUUID()}`;
  const connection = await repository.saveConnection({
    tenantId, label: "Instagram", accountId, accessToken: "provider-token",
    expiresAt: new Date(Date.now() + 3_600_000)
  });
  sessionId = connection.id;
  contactId = `igsid-${randomUUID()}`;
  const seed = await repository.persistEvent(tenantId, sessionId, {
    kind: "message", eventId: `seed:${randomUUID()}`, accountId,
    providerUserId: contactId, timestamp: new Date(), text: "seed", isEcho: false,
    raw: { sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: `seed-${randomUUID()}`, text: "seed" } }
  }, Buffer.from("{}"));
  conversationId = seed.conversationId!;
  await pool.query(
    `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key,status)
     VALUES($1,'agent','saída conhecida',$2,$3,'sent')`,
    [conversationId, "outbound-known", `${tenantId}:${sessionId}:outbound-known`]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

async function persist(repository: InstagramRepository, event: NormalizedInstagramEvent): Promise<void> {
  await repository.persistEvent(tenantId, sessionId, event, Buffer.from(JSON.stringify(event.raw)));
}

describe("durable Instagram inbox dispatch", () => {
  it("drains media into the real inbound queue contract and applies echo/read/reaction without AI loops", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const service = new InstagramService(instagramRepository, provider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const mediaMid = `video:${randomUUID()}`;
    await persist(instagramRepository, {
      kind: "message", eventId: `message:${mediaMid}`, accountId, providerUserId: contactId,
      timestamp: new Date(), text: "Veja o vídeo", media: [{ type: "video", url: "https://lookaside.instagram.test/private-video" }],
      isEcho: false,
      raw: {
        sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: mediaMid, text: "Veja o vídeo", attachments: [{ type: "video", payload: { url: "https://lookaside.instagram.test/private-video" } }] }
      }
    });
    await persist(instagramRepository, {
      kind: "message", eventId: "message:outbound-known", accountId, providerUserId: contactId,
      timestamp: new Date(), text: "saída conhecida", isEcho: true,
      raw: { sender: { id: accountId }, recipient: { id: contactId }, timestamp: Date.now(), message: { mid: "outbound-known", text: "saída conhecida", is_echo: true } }
    });
    await persist(instagramRepository, {
      kind: "read", eventId: "read:outbound-known", accountId, providerUserId: contactId,
      timestamp: new Date(), isEcho: false,
      raw: { sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(), read: { mid: "outbound-known" } }
    });
    await persist(instagramRepository, {
      kind: "reaction", eventId: `reaction:outbound-known:${randomUUID()}`, accountId, providerUserId: contactId,
      timestamp: new Date(), isEcho: false,
      raw: { sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(), reaction: { mid: "outbound-known", action: "react", emoji: "❤️" } }
    });

    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider },
      messages: messageRepository,
      enqueueInbound: async (message) => { enqueued.push(message); }
    });
    const drained = await drainInstagramInboxTenant(service, tenantId, dispatch);
    expect(drained).toBeGreaterThanOrEqual(4);

    const inbound = enqueued.find((message) => message.externalId === instagramInboundExternalId(tenantId, sessionId, mediaMid));
    expect(inbound).toMatchObject({
      channel: "instagram", tenantId, sessionId, contactPhone: `ig:${contactId}`,
      instagramContactId: contactId, mediaType: "video", mediaMimeType: "video/mp4",
      mediaSizeBytes: 11, text: "Veja o vídeo"
    });
    expect(provider.fetchMedia).toHaveBeenCalledWith({
      url: "https://lookaside.instagram.test/private-video", accessToken: "provider-token"
    });
    const media = await pool.query<{ storage_key: string; media_data: Buffer }>(
      "SELECT storage_key,media_data FROM instagram_media WHERE conversation_id=$1",
      [conversationId]
    );
    expect(media.rows.some((row) => row.storage_key === inbound?.externalId && row.media_data.equals(Buffer.from("video-bytes")))).toBe(true);

    const outbound = (await pool.query<{ status: string; reaction_emoji: string | null }>(
      "SELECT status,reaction_emoji FROM messages WHERE provider_message_key=$1",
      [`${tenantId}:${sessionId}:outbound-known`]
    )).rows[0];
    expect(outbound).toEqual({ status: "read", reaction_emoji: "❤️" });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM messages WHERE conversation_id=$1 AND sender='human'",
      [conversationId]
    )).rows[0].count).toBe(0);
    const pending = await pool.query<{ provider_event_id: string; last_error: string | null }>(
      `SELECT provider_event_id,last_error FROM instagram_webhook_inbox
       WHERE tenant_id=$1 AND processed_at IS NULL ORDER BY provider_event_id`,
      [tenantId]
    );
    expect(pending.rows).toEqual([]);
  });

  it("uses collision-resistant queue identifiers for provider mids", () => {
    expect(instagramInboundExternalId(tenantId, sessionId, "mid:a/b"))
      .not.toBe(instagramInboundExternalId(tenantId, sessionId, "mid:a?b"));
    const base = { tenantId, sessionId, contactPhone: `ig:${contactId}`, text: "", channel: "instagram" as const };
    expect(inboundJobId({ ...base, externalId: "mid:a/b" }))
      .not.toBe(inboundJobId({ ...base, externalId: "mid:a?b" }));
    expect(inboundJobId({ ...base, externalId: "same-mid" }))
      .not.toBe(inboundJobId({ ...base, externalId: "same-mid", contactPhone: "ig:other-contact", instagramContactId: "other-contact" }));
    expect(inboundJobId({ ...base, externalId: "same-mid" }))
      .not.toBe(inboundJobId({ ...base, externalId: "same-mid", channel: "whatsapp", contactPhone: "+5511999999999" }));
  });
});

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
  fetchUserProfile: vi.fn().mockResolvedValue({ username: null, name: null, profilePictureUrl: null }),
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

  // Regressão: o webhook de mensagem só entrega o IGSID numérico do
  // remetente; sem consultar a Graph API, instagram_username/contact_name/
  // contact_avatar_url ficavam NULL para sempre e o painel caía no fallback
  // "Identidade do Instagram indisponível".
  it("enriches an unknown contact with username, name and avatar from the provider profile", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const profileTenantId = (await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Instagram profile enrichment ${randomUUID()}`]
    )).rows[0].id;
    const connection = await instagramRepository.saveConnection({
      tenantId: profileTenantId, label: "Instagram", accountId: `account-${randomUUID()}`,
      accessToken: "profile-token", expiresAt: new Date(Date.now() + 3_600_000)
    });
    const profileContactId = `igsid-${randomUUID()}`;
    const mid = `message:${randomUUID()}`;
    const seeded = await instagramRepository.persistEvent(profileTenantId, connection.id, {
      kind: "message", eventId: mid, accountId: connection.provider_account_id,
      providerUserId: profileContactId, timestamp: new Date(), text: "Oi", isEcho: false,
      raw: {
        sender: { id: profileContactId }, recipient: { id: connection.provider_account_id },
        timestamp: Date.now(), message: { mid, text: "Oi" }
      }
    }, Buffer.from("{}"));

    const profileProvider: InstagramProvider = {
      ...provider,
      fetchUserProfile: vi.fn().mockResolvedValue({
        username: "cliente_novo", name: "Cliente Novo", profilePictureUrl: "https://lookaside.instagram.test/pic.jpg"
      })
    };
    const service = new InstagramService(instagramRepository, profileProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const enrichedMessages: SessionMessage[] = [];
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: profileProvider },
      messages: messageRepository,
      enqueueInbound: async (message) => { enrichedMessages.push(message); }
    });
    await drainInstagramInboxTenant(service, profileTenantId, dispatch);

    expect(profileProvider.fetchUserProfile).toHaveBeenCalledWith({
      instagramScopedUserId: profileContactId, accessToken: "profile-token"
    });
    expect(enrichedMessages[0]).toMatchObject({
      instagramUsername: "cliente_novo",
      contactName: "Cliente Novo"
    });
    const stored = (await pool.query<{
      instagram_username: string | null; contact_name: string | null; contact_avatar_url: string | null;
    }>(
      "SELECT instagram_username,contact_name,contact_avatar_url FROM conversations WHERE id=$1",
      [seeded.conversationId]
    )).rows[0];
    // A conversa só recebe username/contact_name ao chegar a próxima mensagem
    // via recordInboundAndLoadContext (COALESCE já testado em
    // instagram-ai.integration.test.ts); aqui garantimos que o dispatcher
    // já grava a foto diretamente e propaga a identidade no SessionMessage.
    expect(stored?.contact_avatar_url).toBe("https://lookaside.instagram.test/pic.jpg");

    await pool.query("DELETE FROM tenants WHERE id=$1", [profileTenantId]);
  });

  // Regressão inversa: quando a identidade já é conhecida e a foto está
  // recente, não deve gastar uma chamada de Graph por mensagem.
  it("does not re-fetch the profile when identity is known and the avatar is fresh", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const knownContactId = `igsid-${randomUUID()}`;
    const knownMid = `message:${randomUUID()}`;
    const seeded = await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: knownMid, accountId,
      providerUserId: knownContactId, timestamp: new Date(), text: "Oi de novo", isEcho: false,
      raw: {
        sender: { id: knownContactId }, recipient: { id: accountId },
        timestamp: Date.now(), message: { mid: knownMid, text: "Oi de novo" }
      }
    }, Buffer.from("{}"));
    await pool.query(
      `UPDATE conversations SET instagram_username='ja_conhecido', contact_avatar_updated_at=now()
       WHERE id=$1`,
      [seeded.conversationId]
    );

    const freshProvider: InstagramProvider = { ...provider, fetchUserProfile: vi.fn() };
    const service = new InstagramService(instagramRepository, freshProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: freshProvider },
      messages: messageRepository,
      enqueueInbound: async () => undefined
    });
    await drainInstagramInboxTenant(service, tenantId, dispatch);

    expect(freshProvider.fetchUserProfile).not.toHaveBeenCalled();
  });

  // Regressão: um attachment ig_reel (reel encaminhado pelo contato) traz em
  // payload.url a PÁGINA do post no instagram.com, não um arquivo de mídia
  // bruto — confirmado em produção (payload.url real observado:
  // https://www.instagram.com/reel/...). Tentar baixar isso como mídia
  // sempre falha ("Unsupported media type"/HTML). Deve virar texto com link,
  // sem NUNCA chamar fetchMedia.
  it("turns an ig_reel attachment into a text fallback with the post link, without attempting a download", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const reelContactId = `igsid-${randomUUID()}`;
    const reelMid = `message:${randomUUID()}`;
    const reelProvider: InstagramProvider = {
      ...provider,
      fetchUserProfile: vi.fn().mockResolvedValue({ username: null, name: null, profilePictureUrl: null }),
      fetchMedia: vi.fn().mockRejectedValue(new Error("fetchMedia must not be called for ig_reel"))
    };
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${reelMid}`, accountId, providerUserId: reelContactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: reelContactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: reelMid, attachments: [{ type: "ig_reel", payload: { url: "https://www.instagram.com/reel/DdXpfzQRyCj/", title: "Reel legal" } }] }
      }
    }, Buffer.from("{}"));

    const service = new InstagramService(instagramRepository, reelProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const reelEnqueued: SessionMessage[] = [];
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: reelProvider },
      messages: messageRepository,
      enqueueInbound: async (message) => { reelEnqueued.push(message); }
    });
    const drained = await drainInstagramInboxTenant(service, tenantId, dispatch);
    expect(drained).toBe(1);
    expect(reelProvider.fetchMedia).not.toHaveBeenCalled();
    expect(reelEnqueued[0]).not.toHaveProperty("mediaType");
    expect(reelEnqueued[0].text).toContain("Reel legal");
    expect(reelEnqueued[0].text).toContain("https://www.instagram.com/reel/DdXpfzQRyCj/");
  });

  // Regressão: attachment `template` (sem payload.url, comum em
  // reencaminhamentos de automações tipo ManyChat) e mensagens
  // `is_unsupported` não podem mais lançar exceção fatal — isso travava o
  // evento em retry infinito (visto attempts>9000 em produção) e, por
  // acontecer antes do enriquecimento de contato, também deixava a conversa
  // sem username/nome para sempre.
  it("falls back to a readable text for unsupported attachments instead of retrying forever", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const templateContactId = `igsid-${randomUUID()}`;
    const templateMid = `message:${randomUUID()}`;
    const templateProvider: InstagramProvider = {
      ...provider,
      fetchUserProfile: vi.fn().mockResolvedValue({ username: "sem_url", name: "Sem URL", profilePictureUrl: null })
    };
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${templateMid}`, accountId, providerUserId: templateContactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: templateContactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: templateMid, attachments: [{ type: "template", payload: { generic: { elements: [{ title: "Clique aqui" }] } } }] }
      }
    }, Buffer.from("{}"));

    const service = new InstagramService(instagramRepository, templateProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const templateEnqueued: SessionMessage[] = [];
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: templateProvider },
      messages: messageRepository,
      enqueueInbound: async (message) => { templateEnqueued.push(message); }
    });
    const drained = await drainInstagramInboxTenant(service, tenantId, dispatch);
    expect(drained).toBe(1);
    expect(templateEnqueued[0]).toMatchObject({ text: "Clique aqui", instagramUsername: "sem_url", contactName: "Sem URL" });
    const pending = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM instagram_webhook_inbox WHERE tenant_id=$1 AND provider_event_id=$2`,
      [tenantId, `message:${templateMid}`]
    );
    expect(pending.rows[0].last_error).toBeNull();
  });

  // Regressão central do bug "contato chega sem nome e @": o enriquecimento
  // de identidade deve acontecer mesmo quando o processamento de mídia
  // falha de verdade (erro transitório real, não payload conhecido).
  it("still enriches contact identity even when real media processing fails", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const failingContactId = `igsid-${randomUUID()}`;
    const failingMid = `message:${randomUUID()}`;
    const failingProvider: InstagramProvider = {
      ...provider,
      fetchUserProfile: vi.fn().mockResolvedValue({ username: "identidade_apesar_do_erro", name: "Ainda Assim", profilePictureUrl: null }),
      fetchMedia: vi.fn().mockRejectedValue(new Error("transient network failure"))
    };
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${failingMid}`, accountId, providerUserId: failingContactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: failingContactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: failingMid, attachments: [{ type: "audio", payload: { url: "https://lookaside.instagram.test/audio-that-fails" } }] }
      }
    }, Buffer.from("{}"));

    const service = new InstagramService(instagramRepository, failingProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: failingProvider },
      messages: messageRepository,
      enqueueInbound: async () => undefined
    });
    // A mensagem em si deve continuar falhando/retryando (erro transitório
    // real de download): o enriquecimento por si só só persiste o avatar
    // diretamente (username/nome são gravados depois, downstream, quando a
    // mensagem é processada da fila via recordInboundAndLoadContext) — a
    // prova real de que a ordem foi corrigida é que fetchUserProfile FOI
    // chamado antes da falha de mídia interromper o processamento, e que o
    // evento ficou marcado para retry (não foi silenciosamente descartado).
    await drainInstagramInboxTenant(service, tenantId, dispatch);
    expect(failingProvider.fetchUserProfile).toHaveBeenCalledWith({
      instagramScopedUserId: failingContactId, accessToken: "provider-token"
    });
    const pending = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM instagram_webhook_inbox WHERE tenant_id=$1 AND provider_event_id=$2`,
      [tenantId, `message:${failingMid}`]
    );
    expect(pending.rows[0].last_error).toBeTruthy();
  });

  // Notas de voz do Instagram chegam em contêiner MP4 servido com
  // Content-Type video/mp4; sem o desempate pelo tipo DECLARADO (`audio`),
  // toda nota de voz virava "vídeo" no painel.
  it("classifies declared-audio mp4 voice notes as audio and carries the raw provider key", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const voiceProvider: InstagramProvider = {
      ...provider,
      fetchMedia: vi.fn().mockResolvedValue({
        bytes: Buffer.from("voice-bytes"), contentType: "video/mp4", sizeBytes: 11,
        finalUrl: "https://lookaside.instagram.test/voice.mp4"
      })
    };
    const voiceMid = `voice:${randomUUID()}`;
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${voiceMid}`, accountId, providerUserId: contactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: voiceMid, attachments: [{ type: "audio", payload: { url: "https://lookaside.instagram.test/voice.mp4" } }] }
      }
    }, Buffer.from("{}"));
    const service = new InstagramService(instagramRepository, voiceProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const voiceEnqueued: SessionMessage[] = [];
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: voiceProvider },
      messages: messageRepository,
      enqueueInbound: async (message) => { voiceEnqueued.push(message); }
    });
    await drainInstagramInboxTenant(service, tenantId, dispatch);

    const voice = voiceEnqueued.find((message) => message.externalId === instagramInboundExternalId(tenantId, sessionId, voiceMid));
    expect(voice).toMatchObject({
      mediaType: "audio",
      mediaMimeType: "video/mp4",
      mediaFileName: "instagram-audio.mp4",
      providerMessageKey: voiceMid
    });
  });

  // Resposta citada: o webhook traz message.reply_to.mid e a mensagem citada
  // mora em provider_message_key=`tenant:sessão:mid` — a resolução para
  // reply_to_message_id acontece em recordInboundAndLoadContext.
  it("resolves a quoted reply to the local message id via the raw provider key", async () => {
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const quotedMid = `quoted:${randomUUID()}`;
    const replyMid = `reply:${randomUUID()}`;
    // A mensagem citada já existe na conversa, gravada com a chave bruta.
    const quoted = await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key,status)
       VALUES($1,'contact','mensagem citada original',$2,$3,'sent') RETURNING id`,
      [conversationId, instagramInboundExternalId(tenantId, sessionId, quotedMid), `${tenantId}:${sessionId}:${quotedMid}`]
    );
    const context = await messageRepository.recordInboundAndLoadContext({
      channel: "instagram",
      externalId: instagramInboundExternalId(tenantId, sessionId, replyMid),
      tenantId, sessionId,
      contactPhone: `ig:${contactId}`,
      instagramContactId: contactId,
      text: "respondendo a citação",
      providerMessageKey: replyMid,
      replyToExternalId: quotedMid
    }, { claim: false });
    expect(context).not.toBeNull();
    const stored = (await pool.query<{ reply_to_message_id: string | null }>(
      "SELECT reply_to_message_id FROM messages WHERE provider_message_key=$1",
      [`${tenantId}:${sessionId}:${replyMid}`]
    )).rows[0];
    expect(stored.reply_to_message_id).toBe(quoted.rows[0].id);
    // Resolução não deve derrubar o fluxo quando a citada não existe.
    const missingContext = await messageRepository.recordInboundAndLoadContext({
      channel: "instagram",
      externalId: instagramInboundExternalId(tenantId, sessionId, `missing:${randomUUID()}`),
      tenantId, sessionId,
      contactPhone: `ig:${contactId}`,
      instagramContactId: contactId,
      text: "citando algo inexistente",
      providerMessageKey: `missing:${randomUUID()}`,
      replyToExternalId: `nao-existe:${randomUUID()}`
    }, { claim: false });
    expect(missingContext).not.toBeNull();
  });

  // Fallbacks de conteúdo não suportado, com texto específico por caso.
  it("maps view-once, location and unsupported payloads to specific fallback texts", async () => {
    const instagramRepository = new InstagramRepository(pool, key);
    const fallbackProvider: InstagramProvider = { ...provider };
    const service = new InstagramService(instagramRepository, fallbackProvider);
    const messageRepository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const fallbackEnqueued: SessionMessage[] = [];
    const dispatch = createInstagramInboxDispatcher({
      database: pool,
      instagram: { repository: instagramRepository, provider: fallbackProvider },
      messages: messageRepository,
      enqueueInbound: async (message) => { fallbackEnqueued.push(message); }
    });

    const ephemeralMid = `ephemeral:${randomUUID()}`;
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${ephemeralMid}`, accountId, providerUserId: contactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: ephemeralMid, attachments: [{ type: "ephemeral" }] }
      }
    }, Buffer.from("{}"));
    const unsupportedMid = `unsupported:${randomUUID()}`;
    await instagramRepository.persistEvent(tenantId, sessionId, {
      kind: "message", eventId: `message:${unsupportedMid}`, accountId, providerUserId: contactId,
      timestamp: new Date(), text: "", isEcho: false,
      raw: {
        sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(),
        message: { mid: unsupportedMid, is_unsupported: true }
      }
    }, Buffer.from("{}"));
    await drainInstagramInboxTenant(service, tenantId, dispatch);

    const texts = fallbackEnqueued.map((message) => message.text);
    expect(texts).toContain("[Não é possível visualizar a imagem de visualização única recebida pelo Instagram]");
    expect(texts).toContain("[Não é possível visualizar este conteúdo pelo AtendON: localização, visualização única ou conteúdo não suportado pelo Instagram]");
  });
});

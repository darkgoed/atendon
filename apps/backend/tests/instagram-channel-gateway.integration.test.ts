import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import {
  ChannelGatewayRouter,
  ChannelSendAmbiguousError,
  ChannelSendRejectedError
} from "../src/modules/messages/channel-gateway.js";
import { createInstagramRuntime } from "../src/modules/instagram/index.js";
import type { InstagramProvider, NormalizedInstagramEvent } from "../src/modules/instagram/types.js";
import type { MessageGateway } from "../src/modules/messages/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];

function providerFake() {
  const sendText = vi.fn<InstagramProvider["sendText"]>().mockResolvedValue({ outcome: "accepted", externalId: "ig-mid-text" });
  const sendMedia = vi.fn<InstagramProvider["sendMedia"]>().mockResolvedValue({ outcome: "accepted", externalId: "ig-mid-media" });
  const fetchMedia = vi.fn<InstagramProvider["fetchMedia"]>().mockResolvedValue({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    contentType: "image/jpeg",
    sizeBytes: 4,
    finalUrl: "https://lookaside.instagram.com/media.jpg"
  });
  const provider: InstagramProvider = {
    exchangeOAuthCode: vi.fn(),
    refreshAccessToken: vi.fn(),
    subscribeWebhook: vi.fn(),
    sendText,
    sendMedia,
    fetchMedia
  };
  return { provider, sendText, sendMedia, fetchMedia };
}

function whatsappFake() {
  const sendText = vi.fn().mockResolvedValue({ externalId: "wa-mid" });
  const sendMedia = vi.fn().mockResolvedValue({ externalId: "wa-media" });
  const downloadMedia = vi.fn().mockResolvedValue({ base64: "d2E=", mimeType: "image/jpeg", fileName: "wa.jpg" });
  const gateway: MessageGateway = {
    sendText,
    sendMedia,
    downloadMedia,
    sendPresence: vi.fn().mockResolvedValue(undefined),
    markMessageAsRead: vi.fn().mockResolvedValue(undefined),
    setPresence: vi.fn().mockResolvedValue(undefined)
  };
  return { gateway, sendText, sendMedia, downloadMedia };
}

async function tenantFixture() {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Router ${randomUUID()}`, `router-${randomUUID()}`]
  )).rows[0].id;
  tenants.push(tenantId);
  const whatsappSessionId = (await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel,phone_number)
     VALUES($1,'WhatsApp',true,'connected','whatsapp','5511999990000') RETURNING id`,
    [tenantId]
  )).rows[0].id;
  return { tenantId, whatsappSessionId };
}

function inboundEvent(accountId: string, contactId: string, mid: string): NormalizedInstagramEvent {
  return {
    kind: "message",
    eventId: `message:${mid}`,
    accountId,
    providerUserId: contactId,
    timestamp: new Date(),
    text: "foto",
    media: [{ type: "image", url: "https://lookaside.instagram.com/media.jpg" }],
    isEcho: false,
    raw: {
      sender: { id: contactId },
      recipient: { id: accountId },
      message: {
        mid,
        attachments: [{ type: "image", payload: { url: "https://lookaside.instagram.com/media.jpg" } }]
      }
    }
  };
}

describe("ChannelGatewayRouter", () => {
  beforeAll(async () => pool.query("SELECT 1"));

  afterAll(async () => {
    if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
    await pool.end();
  });

  it("delegates a WhatsApp text without changing destination, quote or provider", async () => {
    const fixture = await tenantFixture();
    const whatsapp = whatsappFake();
    const instagram = providerFake();
    const runtime = createInstagramRuntime({ database: pool, runtimeConfig: config, provider: instagram.provider });
    const router = new ChannelGatewayRouter(pool, whatsapp.gateway, runtime, config);
    const quote = { key: { id: "quoted", remoteJid: "5511888880000@s.whatsapp.net", fromMe: false }, text: "anterior" };

    await expect(router.sendText(
      fixture.whatsappSessionId,
      "5511888880000@s.whatsapp.net",
      "olá",
      quote
    )).resolves.toEqual({ externalId: "wa-mid" });

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      fixture.whatsappSessionId,
      "5511888880000@s.whatsapp.net",
      "olá",
      quote
    );
    expect(instagram.sendText).not.toHaveBeenCalled();
  });

  it("routes ig:IGSID through the tenant connection and preserves rejected versus ambiguous outcomes", async () => {
    const fixture = await tenantFixture();
    const whatsapp = whatsappFake();
    const instagram = providerFake();
    const runtime = createInstagramRuntime({ database: pool, runtimeConfig: config, provider: instagram.provider });
    const connection = await runtime.repository.saveConnection({
      tenantId: fixture.tenantId,
      label: "Instagram",
      accountId: `account-${randomUUID()}`,
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    await runtime.repository.persistEvent(
      fixture.tenantId,
      connection.id,
      inboundEvent(connection.provider_account_id, contactId, `mid-${randomUUID()}`),
      Buffer.from("{}")
    );
    const router = new ChannelGatewayRouter(pool, whatsapp.gateway, runtime, config);

    await expect(router.sendText(connection.id, `ig:${contactId}`, "aceita")).resolves.toEqual({ externalId: "ig-mid-text" });
    expect(instagram.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ recipientId: contactId, text: "aceita" }));
    expect(whatsapp.sendText).not.toHaveBeenCalled();

    instagram.sendText.mockResolvedValueOnce({ outcome: "rejected", code: "window_expired", message: "Janela expirada" });
    const rejected = await router.sendText(connection.id, `ig:${contactId}`, "rejeitada").catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ChannelSendRejectedError);
    expect(rejected).toMatchObject({ sendOutcome: "rejected", code: "window_expired", statusCode: 409 });

    instagram.sendText.mockResolvedValueOnce({ outcome: "ambiguous", code: "ambiguous", message: "Resultado desconhecido" });
    const ambiguous = await router.sendText(connection.id, `ig:${contactId}`, "ambígua").catch((error: unknown) => error);
    expect(ambiguous).toBeInstanceOf(ChannelSendAmbiguousError);
    expect(ambiguous).toMatchObject({ sendOutcome: "ambiguous", code: "SEND_OUTCOME_AMBIGUOUS", statusCode: 409 });
  });

  it("persists outbound bytes before exposing a signed public media URL and rejects spoofed content", async () => {
    const fixture = await tenantFixture();
    const whatsapp = whatsappFake();
    const instagram = providerFake();
    const runtime = createInstagramRuntime({ database: pool, runtimeConfig: config, provider: instagram.provider });
    const connection = await runtime.repository.saveConnection({
      tenantId: fixture.tenantId,
      label: "Instagram media",
      accountId: `account-${randomUUID()}`,
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    const persisted = await runtime.repository.persistEvent(
      fixture.tenantId,
      connection.id,
      inboundEvent(connection.provider_account_id, contactId, `mid-${randomUUID()}`),
      Buffer.from("{}")
    );
    const router = new ChannelGatewayRouter(pool, whatsapp.gateway, runtime, config);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

    await expect(router.sendMedia!(connection.id, `ig:${contactId}`, {
      mediaType: "image",
      mimeType: "image/png",
      fileName: "foto.png",
      dataBase64: png.toString("base64"),
      caption: "Imagem"
    })).resolves.toEqual({ externalId: "ig-mid-media" });

    const providerCall = instagram.sendMedia.mock.calls[0]?.[0];
    expect(providerCall?.media.type).toBe("image");
    const publicUrl = new URL(providerCall!.media.url);
    expect(publicUrl.pathname).toMatch(/^\/api\/instagram\/media\/[0-9a-f-]+$/);
    expect(publicUrl.searchParams.get("signature")).toBeTruthy();
    const mediaId = publicUrl.pathname.split("/").at(-1)!;
    const stored = await runtime.repository.getPublicMedia(mediaId);
    expect(stored?.bytes.equals(png)).toBe(true);
    expect((await pool.query<{ conversation_id: string | null }>(
      "SELECT conversation_id FROM instagram_media WHERE id=$1",
      [mediaId]
    )).rows[0].conversation_id).toBe(persisted.conversationId);

    await expect(router.sendMedia!(connection.id, `ig:${contactId}`, {
      mediaType: "image",
      mimeType: "image/png",
      fileName: "falsa.png",
      dataBase64: Buffer.from("not-a-png").toString("base64")
    })).rejects.toMatchObject({ code: "INSTAGRAM_MEDIA_INVALID", statusCode: 400 });
    const sizeLimitedRouter = new ChannelGatewayRouter(
      pool,
      whatsapp.gateway,
      runtime,
      { ...config, INSTAGRAM_MEDIA_MAX_BYTES: png.length - 1 }
    );
    await expect(sizeLimitedRouter.sendMedia!(connection.id, `ig:${contactId}`, {
      mediaType: "image",
      mimeType: "image/png",
      fileName: "grande.png",
      dataBase64: png.toString("base64")
    })).rejects.toMatchObject({ code: "INSTAGRAM_MEDIA_INVALID", statusCode: 400 });
    expect(instagram.sendMedia).toHaveBeenCalledTimes(1);
  });

  it("downloads Instagram media from durable inbox metadata once, caches bytes, and never calls Evolution", async () => {
    const fixture = await tenantFixture();
    const whatsapp = whatsappFake();
    const instagram = providerFake();
    const runtime = createInstagramRuntime({ database: pool, runtimeConfig: config, provider: instagram.provider });
    const connection = await runtime.repository.saveConnection({
      tenantId: fixture.tenantId,
      label: "Instagram download",
      accountId: `account-${randomUUID()}`,
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    const mid = `mid-${randomUUID()}`;
    await runtime.repository.persistEvent(
      fixture.tenantId,
      connection.id,
      inboundEvent(connection.provider_account_id, contactId, mid),
      Buffer.from("{}")
    );
    const router = new ChannelGatewayRouter(pool, whatsapp.gateway, runtime, config);

    await expect(router.downloadMedia!(connection.id, mid)).resolves.toEqual({
      base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      mimeType: "image/jpeg",
      fileName: expect.stringMatching(/\.jpg$/)
    });
    await expect(router.downloadMedia!(connection.id, mid)).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(instagram.fetchMedia).toHaveBeenCalledTimes(1);
    expect(whatsapp.downloadMedia).not.toHaveBeenCalled();
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM instagram_media WHERE tenant_id=$1 AND session_id=$2 AND storage_key=$3",
      [fixture.tenantId, connection.id, mid]
    )).rows[0].count).toBe(1);
  });
});

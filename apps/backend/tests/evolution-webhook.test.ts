import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { normalizedFacebookAttribution } from "../src/modules/messages/repository.js";
import { evolutionContactUpdates, evolutionMessage, evolutionMessageStatusUpdates, evolutionPresenceUpdates, evolutionStickerMessage, parseEvolutionEvent } from "../src/modules/whatsapp/evolution-webhook.js";
import { handleEvolutionWebhook } from "../src/modules/whatsapp/webhook-handler.js";
import type { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";
import { enqueueInbound } from "../src/queue/message-queue.js";

vi.mock("../src/queue/message-queue.js", () => ({ enqueueInbound: vi.fn() }));

describe("Evolution webhook adapter", () => {
  const identity = { tenantId: "tenant-a", sessionId: "session-a" };

  it("recognizes a sticker sent from the connected WhatsApp for library import", () => {
    expect(evolutionStickerMessage({
      key: { id: "wamid-sticker", remoteJid: "5511888888888@s.whatsapp.net", fromMe: true },
      message: { stickerMessage: { mimetype: "image/webp" } }
    })).toEqual({
      externalId: "wamid-sticker",
      contactPhone: "5511888888888",
      contactJid: "5511888888888@s.whatsapp.net",
      fromMe: true
    });
  });

  it("maps inbound messages to the resolved tenant identity", () => {
    const event = parseEvolutionEvent({ event: "messages.upsert", instance: "atendon_a", data: {
      key: { id: "wamid-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
      pushName: "Contato", message: { conversation: "Olá" }
    } });
    expect(event).not.toBeNull();
    expect(evolutionMessage(event!.data, identity)).toEqual(expect.objectContaining({
      kind: "contact", externalId: "wamid-1", tenantId: "tenant-a", sessionId: "session-a",
      contactPhone: "5511999999999", text: "Olá"
    }));
  });

  it("captures messages sent from the linked phone as human history", () => {
    const message = evolutionMessage({
      key: { id: "wamid-human", remoteJid: "5511888888888@s.whatsapp.net", fromMe: true },
      message: { extendedTextMessage: { text: "Resposta pelo celular" } }
    }, identity);
    expect(message).toEqual(expect.objectContaining({ kind: "human", text: "Resposta pelo celular" }));
  });

  it("captures metadata needed to render inbound media", () => {
    const message = evolutionMessage({
      key: { id: "wamid-document", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { documentMessage: {
        caption: "Contrato assinado",
        mimetype: "application/pdf",
        fileName: "contrato.pdf",
        fileLength: 48231
      } }
    }, identity);
    expect(message).toEqual(expect.objectContaining({
      mediaType: "document",
      mediaMimeType: "application/pdf",
      mediaFileName: "contrato.pdf",
      mediaSizeBytes: 48231
    }));
  });

  it("maps images received from the contact and sent from the linked phone", () => {
    for (const fromMe of [false, true]) {
      expect(evolutionMessage({
        key: { id: `wamid-image-${fromMe}`, remoteJid: "5511888888888@s.whatsapp.net", fromMe },
        message: { imageMessage: { caption: "Foto do produto", mimetype: "image/jpeg", fileLength: 2048 } }
      }, identity)).toEqual(expect.objectContaining({
        kind: fromMe ? "human" : "contact",
        text: "Foto do produto",
        mediaType: "image",
        mediaMimeType: "image/jpeg",
        mediaSizeBytes: 2048
      }));
    }
  });

  it("maps received and linked-phone stickers as visual conversation media", () => {
    for (const fromMe of [false, true]) {
      const message = evolutionMessage({
        key: { id: `wamid-sticker-${fromMe}`, remoteJid: "5511888888888@s.whatsapp.net", fromMe },
        message: { stickerMessage: { mimetype: "image/webp", fileLength: 12345 } }
      }, identity);
      expect(message).toEqual(expect.objectContaining({
        kind: fromMe ? "human" : "contact",
        text: "",
        mediaType: "image",
        mediaMimeType: "image/webp",
        mediaSizeBytes: 12345,
        mediaIsSticker: true
      }));
      expect(message).not.toHaveProperty("mediaFileName");
    }
  });

  it("normalizes CTWA referral metadata without retaining the raw payload", () => {
    const message = evolutionMessage({
      key: { id: "wamid-ctwa", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { extendedTextMessage: { text: "Quero saber mais", contextInfo: { externalAdReply: {
        sourceType: "ad", sourceId: "ad-123", sourceUrl: "https://facebook.com/ad/123", headline: "Newave",
        body: "Crédito para sua loja", thumbnailUrl: "https://cdn.example/thumb.jpg", ctwaClid: "clid-1",
        ignoredRawField: { secret: true }
      } } } }
    }, identity);
    expect(message).toEqual(expect.objectContaining({ referral: {
      sourceType: "ad", sourceId: "ad-123", sourceUrl: "https://facebook.com/ad/123", headline: "Newave",
      body: "Crédito para sua loja", thumbnailUrl: "https://cdn.example/thumb.jpg", ctwaClid: "clid-1"
    } }));
    expect(JSON.stringify(message)).not.toContain("ignoredRawField");
  });

  it("persists form answers found only in Meta message text", () => {
    expect(normalizedFacebookAttribution({
      sourceType: "ad",
      sourceId: "ad-form-text"
    }, `Preenchi o formulário
Qual é o nicho da empresa?: Ótica
Há quanto tempo está no mercado?: 3 anos`)).toMatchObject({
      provider: "meta",
      source_type: "ad",
      source_id: "ad-form-text",
      prefilled_fields: {
        "Qual é o nicho da empresa?": "Ótica",
        "Há quanto tempo está no mercado?": "3 anos"
      }
    });
  });

  it("captures the root contextInfo shape emitted by Evolution for Meta lead ads", () => {
    const message = evolutionMessage({
      key: { id: "wamid-root-ctwa", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { conversation: "Hello! I filled out your form." },
      contextInfo: {
        conversionSource: "FB_Ads",
        conversionData: [65, 66, 67],
        entryPointConversionApp: "instagram",
        externalAdReply: {
          title: "Financiamento para sua loja",
          body: "Mais opções de pagamento para seus clientes.",
          mediaType: 2,
          mediaUrl: "https://www.facebook.com/reel/1587649496049319/",
          thumbnailUrl: "https://instagram.example/campaign.jpg",
          sourceType: "ad",
          sourceId: "120249583544180078",
          sourceUrl: "https://www.instagram.com/p/DbL6cGNA9hx/",
          ctwaClid: "clid-root",
          sourceApp: "instagram",
          ignoredRawField: { secret: true }
        }
      }
    }, identity);

    expect(message).toEqual(expect.objectContaining({ referral: {
      sourceType: "ad",
      sourceId: "120249583544180078",
      sourceUrl: "https://www.instagram.com/p/DbL6cGNA9hx/",
      headline: "Financiamento para sua loja",
      body: "Mais opções de pagamento para seus clientes.",
      mediaType: "2",
      mediaUrl: "https://www.facebook.com/reel/1587649496049319/",
      thumbnailUrl: "https://instagram.example/campaign.jpg",
      ctwaClid: "clid-root",
      sourceApp: "instagram"
    } }));
    const referral = message && "referral" in message ? message.referral : undefined;
    expect(normalizedFacebookAttribution(referral)).toMatchObject({
      provider: "meta",
      channel: "instagram",
      source_app: "instagram",
      source_id: "120249583544180078",
      headline: "Financiamento para sua loja"
    });
    expect(JSON.stringify(message)).not.toContain("conversionData");
    expect(JSON.stringify(message)).not.toContain("ignoredRawField");
  });

  it("captures arbitrary prefilled ad fields without requiring fixed field names", () => {
    const message = evolutionMessage({
      key: { id: "wamid-form", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { extendedTextMessage: { text: "Quero saber mais", contextInfo: { referralMessage: {
        sourceType: "ad",
        leadData: [
          { question: "Quantas filiais você possui?", answer: 3 },
          { label: "Atende aos sábados", value: true },
          { field_data: [{ name: "Regiões atendidas", values: ["Sudeste", "Sul"] }] }
        ]
      } } } }
    }, identity);
    expect(message).toEqual(expect.objectContaining({ referral: expect.objectContaining({
      prefilledFields: {
        "Quantas filiais você possui?": "3",
        "Atende aos sábados": "true",
        "Regiões atendidas": "Sudeste, Sul"
      }
    }) }));
  });

  it("does not accept groups, broadcasts or malformed messages", () => {
    expect(evolutionMessage({ key: { id: "1", remoteJid: "status@broadcast" }, message: { conversation: "x" } }, identity)).toBeNull();
    expect(evolutionMessage({ key: { id: "2", remoteJid: "123@g.us" }, message: { conversation: "x" } }, identity)).toBeNull();
    expect(parseEvolutionEvent({ event: "messages.upsert", data: {} })).toBeNull();
  });
});

describe("Evolution webhook presence mapping", () => {
  it("maps Baileys presence entries and their last seen timestamp", () => {
    expect(evolutionPresenceUpdates({
      id: "5511999999999@s.whatsapp.net",
      presences: {
        "5511999999999@s.whatsapp.net": { lastKnownPresence: "unavailable", lastSeen: 1_750_000_000 }
      }
    })).toEqual([{
      contactPhone: "5511999999999",
      contactJid: "5511999999999@s.whatsapp.net",
      presence: "unavailable",
      lastSeenAt: new Date(1_750_000_000_000)
    }]);
  });

  it("ignores groups and unknown presence values", () => {
    expect(evolutionPresenceUpdates({ id: "120363@g.us", presence: "available" })).toEqual([]);
    expect(evolutionPresenceUpdates({ id: "5511999999999@s.whatsapp.net", presence: "mystery" })).toEqual([]);
  });
});

describe("Evolution webhook contact mapping", () => {
  it("maps contact avatar updates and rejects unsafe URLs", () => {
    expect(evolutionContactUpdates([
      { remoteJid: "5511999999999@s.whatsapp.net", profilePicUrl: "https://cdn.example/avatar.jpg" },
      { id: "5511888888888@s.whatsapp.net", profilePictureUrl: "javascript:alert(1)" },
      { remoteJid: "120363@g.us", profilePicUrl: "https://cdn.example/group.jpg" }
    ])).toEqual([
      {
        contactPhone: "5511999999999",
        contactJid: "5511999999999@s.whatsapp.net",
        avatarUrl: "https://cdn.example/avatar.jpg"
      },
      {
        contactPhone: "5511888888888",
        contactJid: "5511888888888@s.whatsapp.net",
        avatarUrl: null
      }
    ]);
  });
});

describe("Evolution webhook descarta conexões arquivadas", () => {
  it("responde 204 sem enfileirar a mensagem", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "session-archived",
        tenant_id: "tenant-a",
        archived_at: "2026-09-09T12:00:00.000Z"
      }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const send = vi.fn();
    const status = vi.fn().mockReturnValue({ send });
    const info = vi.fn();
    vi.mocked(enqueueInbound).mockClear();

    await handleEvolutionWebhook({
      headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET },
      body: {
        event: "messages.upsert",
        instance: "atendon_archived",
        data: {
          key: { id: "wamid-archived", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true },
          message: { conversation: "Não deve entrar na fila" }
        }
      }
    } as unknown as FastifyRequest, { status } as unknown as FastifyReply, {
      db: { query } as never,
      whatsapp: {} as WhatsAppSessionManager,
      log: { info, warn: vi.fn() } as unknown as FastifyBaseLogger
    });

    expect(status).toHaveBeenCalledWith(204);
    expect(send).toHaveBeenCalledOnce();
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { instance: "atendon_archived" },
      "Evento de instância arquivada descartado"
    );
  });
});

describe("Evolution webhook ack status mapping", () => {
  it("maps a single update object with a nested key/update shape", () => {
    expect(evolutionMessageStatusUpdates({ key: { id: "wamid-1" }, update: { status: "DELIVERY_ACK" } }))
      .toEqual([{ externalId: "wamid-1", status: "delivered" }]);
  });

  it("maps an array of updates using flattened keyId/status fields", () => {
    expect(evolutionMessageStatusUpdates([
      { keyId: "wamid-2", status: "READ" },
      { keyId: "wamid-3", status: "PLAYED" }
    ])).toEqual([
      { externalId: "wamid-2", status: "read" },
      { externalId: "wamid-3", status: "read" }
    ]);
  });

  it("accepts numeric WAMessageStatus values", () => {
    expect(evolutionMessageStatusUpdates({ id: "wamid-error", status: 0, fromMe: true }))
      .toEqual([{ externalId: "wamid-error", status: "failed", failed: true, fromMe: true }]);
    expect(evolutionMessageStatusUpdates({ id: "wamid-4", status: 2 })).toEqual([{ externalId: "wamid-4", status: "sent" }]);
    expect(evolutionMessageStatusUpdates({ id: "wamid-5", status: 3 })).toEqual([{ externalId: "wamid-5", status: "delivered" }]);
    expect(evolutionMessageStatusUpdates({ id: "wamid-6", status: 4 })).toEqual([{ externalId: "wamid-6", status: "read" }]);
  });

  it("ignores entries missing an id or an unrecognized status", () => {
    expect(evolutionMessageStatusUpdates({ status: "READ" })).toEqual([]);
    expect(evolutionMessageStatusUpdates({ id: "wamid-7", status: "SOMETHING_UNKNOWN" })).toEqual([]);
    expect(evolutionMessageStatusUpdates(null)).toEqual([]);
  });
});

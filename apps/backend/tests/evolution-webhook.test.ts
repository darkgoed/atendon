import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { normalizedFacebookAttribution } from "../src/modules/messages/repository.js";
import { evolutionContactUpdates, evolutionMessage, evolutionMessageStatusUpdates, evolutionPresenceUpdates, evolutionStickerMessage, evolutionUnrecognizedMessageContentKeys, parseEvolutionEvent } from "../src/modules/whatsapp/evolution-webhook.js";
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

  it("captures video messages, including GIF playback, from the contact and the linked phone", () => {
    for (const fromMe of [false, true]) {
      const message = evolutionMessage({
        key: { id: `wamid-video-${fromMe}`, remoteJid: "5511888888888@s.whatsapp.net", fromMe },
        message: { videoMessage: { caption: "Segue o vídeo", mimetype: "video/mp4", fileLength: 40960 } }
      }, identity);
      expect(message).toEqual(expect.objectContaining({
        kind: fromMe ? "human" : "contact",
        text: "Segue o vídeo",
        mediaType: "video",
        mediaMimeType: "video/mp4",
        mediaSizeBytes: 40960
      }));
    }
    const gif = evolutionMessage({
      key: { id: "wamid-gif", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { videoMessage: { mimetype: "video/mp4", fileLength: 8192, gifPlayback: true } }
    }, identity);
    expect(gif).toEqual(expect.objectContaining({ kind: "contact", mediaType: "video", text: "" }));
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

  it("surfaces the content keys of a message type AtendON does not yet recognize, for operational visibility", () => {
    expect(evolutionUnrecognizedMessageContentKeys({
      key: { id: "wamid-poll", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { pollCreationMessage: { name: "Qual horário prefere?", options: [] } }
    })).toEqual(["pollCreationMessage"]);
  });

  it("does not flag recognized content, groups, broadcasts or empty messages as unrecognized", () => {
    expect(evolutionUnrecognizedMessageContentKeys({
      key: { id: "wamid-ok", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { conversation: "Olá" }
    })).toEqual([]);
    expect(evolutionUnrecognizedMessageContentKeys({
      key: { id: "wamid-group", remoteJid: "123@g.us" }, message: { pollCreationMessage: {} }
    })).toEqual([]);
    expect(evolutionUnrecognizedMessageContentKeys({
      key: { id: "wamid-ack", remoteJid: "5511888888888@s.whatsapp.net" }
    })).toEqual([]);
  });

  it("extracts a shared contact card (contactMessage) as readable text instead of discarding it", () => {
    const message = evolutionMessage({
      key: { id: "wamid-contact", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { contactMessage: {
        displayName: "João Silva",
        vcard: "BEGIN:VCARD\nVERSION:3.0\nN:;João Silva;;;\nFN:João Silva\nTEL;type=CELL;type=VOICE;waid=5511999998888:+55 11 99999-8888\nEND:VCARD"
      } }
    }, identity);
    expect(message).not.toBeNull();
    expect(message).toEqual(expect.objectContaining({ kind: "contact" }));
    expect((message as { text: string }).text).toContain("João Silva");
    expect((message as { text: string }).text).toContain("+55 11 99999-8888");
    expect(message).not.toHaveProperty("mediaType");
  });

  it("extracts multiple shared contacts (contactsArrayMessage) as a listed text", () => {
    const message = evolutionMessage({
      key: { id: "wamid-contacts", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { contactsArrayMessage: { displayName: "2 contatos", contacts: [
        { displayName: "Ana", vcard: "BEGIN:VCARD\nFN:Ana Souza\nTEL:+5511911112222\nEND:VCARD" },
        { displayName: "Beto", vcard: "BEGIN:VCARD\nFN:Beto Lima\nTEL:+5511933334444\nEND:VCARD" }
      ] } }
    }, identity);
    expect(message).not.toBeNull();
    const text = (message as { text: string }).text;
    expect(text).toContain("Ana Souza");
    expect(text).toContain("+5511911112222");
    expect(text).toContain("Beto Lima");
    expect(text).toContain("+5511933334444");
  });

  it("falls back to display name when the vcard cannot be parsed, and to a generic label with neither", () => {
    const withNameOnly = evolutionMessage({
      key: { id: "wamid-contact-noname", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { contactMessage: { displayName: "Carla" } }
    }, identity);
    expect((withNameOnly as { text: string }).text).toContain("Carla");

    const withNothing = evolutionMessage({
      key: { id: "wamid-contact-empty", remoteJid: "5511888888888@s.whatsapp.net", fromMe: false },
      message: { contactMessage: {} }
    }, identity);
    expect((withNothing as { text: string }).text).toContain("Contato compartilhado");
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

describe("Evolution webhook connection alerts", () => {
  it("identifies a disconnected connection by label and passes it to once-only alerting", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-a", tenant_id: "tenant-a", label: "Suporte", archived_at: null }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const status = vi.fn().mockReturnValue({ send: vi.fn() });
    await handleEvolutionWebhook({ headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, body: {
      event: "connection.update", instance: "atendon_a", data: { state: "close", reason: "logged_out" }
    }} as unknown as FastifyRequest, { status } as unknown as FastifyReply, {
      db: { query } as never, whatsapp: {} as WhatsAppSessionManager, log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO system_alerts"), ["tenant-a", expect.stringContaining("Suporte")]);
  });

  // Regressão de produção: a Evolution/Baileys emite "close" com frequência
  // em reconexões TRANSITÓRIAS (ping timeout, restart de instância, blip de
  // rede) das quais se recupera sozinha sem exigir novo QR — sem reason de
  // logout e sem shouldReconnect=false. Antes, isso marcava a sessão como
  // "disconnected" na hora, mostrando "desconectado" para um número que
  // continuava conectado na prática. Não deve atualizar o status nem
  // disparar alerta.
  it("ignores a transient close without a logout reason (no status change, no alert)", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-a", tenant_id: "tenant-a", label: "Suporte", archived_at: null }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const status = vi.fn().mockReturnValue({ send: vi.fn() });
    await handleEvolutionWebhook({ headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, body: {
      event: "connection.update", instance: "atendon_a", data: { state: "close" }
    }} as unknown as FastifyRequest, { status } as unknown as FastifyReply, {
      db: { query } as never, whatsapp: {} as WhatsAppSessionManager, log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
    });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE whatsapp_sessions"), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO system_alerts"), expect.anything());
    expect(status).toHaveBeenCalledWith(204);
  });

  // Regressão de produção: a Evolution emite "connecting" durante reconexões
  // internas de uma sessão JÁ pareada, e frequentemente fora de ordem com o
  // "open" correspondente. Regredir para qr_pending nesse caso trava a sessão
  // como não conectada no painel, e channelCapabilities passa a responder
  // can_send=false ("A conexão do WhatsApp está desconectada") para um número
  // que recebe e envia normalmente.
  it("ignores a transient connecting for an already connected session", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-a", tenant_id: "tenant-a", label: "Suporte", archived_at: null, status: "connected" }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const status = vi.fn().mockReturnValue({ send: vi.fn() });
    await handleEvolutionWebhook({ headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, body: {
      event: "connection.update", instance: "atendon_a", data: { state: "connecting" }
    }} as unknown as FastifyRequest, { status } as unknown as FastifyReply, {
      db: { query } as never, whatsapp: {} as WhatsAppSessionManager, log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
    });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE whatsapp_sessions"), expect.anything());
    expect(status).toHaveBeenCalledWith(204);
  });

  it("still moves a session that is not connected yet to qr_pending on connecting", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-a", tenant_id: "tenant-a", label: "Suporte", archived_at: null, status: "disconnected" }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const status = vi.fn().mockReturnValue({ send: vi.fn() });
    await handleEvolutionWebhook({ headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, body: {
      event: "connection.update", instance: "atendon_a", data: { state: "connecting" }
    }} as unknown as FastifyRequest, { status } as unknown as FastifyReply, {
      db: { query } as never, whatsapp: {} as WhatsAppSessionManager, log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE whatsapp_sessions"),
      ["session-a", "qr_pending", null, null, null]
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

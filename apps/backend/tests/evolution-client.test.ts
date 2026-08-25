import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVOLUTION_MAX_RESPONSE_BYTES,
  EvolutionApiError,
  EvolutionClient,
  isEvolutionConnectionClosedError
} from "../src/modules/whatsapp/evolution-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("EvolutionClient webhook configuration", () => {
  it("preserves a bounded provider error reason as a retry-safe gateway error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 400,
      error: "Bad Request",
      response: { message: ["The destination is temporarily unavailable"] }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    const error = await client.sendText("tenant-instance", "5511999999999", "Olá")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvolutionApiError);
    expect(error).toMatchObject({ statusCode: 502, upstreamStatus: 400 });
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).toContain("destination is temporarily unavailable");
    expect(isEvolutionConnectionClosedError(error)).toBe(false);
  });

  it("classifies only Evolution closed-socket responses as recoverable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 400,
      error: "Bad Request",
      response: { message: ["Error: Connection Closed"] }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    const error = await client.sendText("tenant-instance", "5511999999999", "Olá")
      .catch((caught: unknown) => caught);

    expect(isEvolutionConnectionClosedError(error)).toBe(true);
  });

  it("restarts one Evolution instance through the provider endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      instance: { instanceName: "tenant-instance", status: "open" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.restart("tenant-instance")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/instance/restart/tenant-instance",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("edits a previously sent group message with the provider message key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ message: "updated" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.updateText(
      "tenant-instance",
      "120363000000000000@g.us",
      "group-message-id",
      "Agendamento atualizado"
    )).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/chat/updateMessage/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          number: "120363000000000000",
          key: {
            remoteJid: "120363000000000000@g.us",
            fromMe: true,
            id: "group-message-id"
          },
          text: "Agendamento atualizado"
        })
      })
    );
  });

  it("loads stored contacts and fetches a current profile picture", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([
        { remoteJid: "5511999999999@s.whatsapp.net", profilePicUrl: "https://cdn.example/avatar.jpg" },
        { remoteJid: "120363@g.us", profilePicUrl: "https://cdn.example/group.jpg" }
      ]))
      .mockResolvedValueOnce(Response.json({
        wuid: "5511999999999@s.whatsapp.net",
        profilePictureUrl: "https://cdn.example/avatar-current.jpg"
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.fetchContacts("tenant-instance")).resolves.toEqual([{
      remoteJid: "5511999999999@s.whatsapp.net",
      profilePicUrl: "https://cdn.example/avatar.jpg"
    }]);
    await expect(client.fetchProfilePicture("tenant-instance", "5511999999999@s.whatsapp.net"))
      .resolves.toBe("https://cdn.example/avatar-current.jpg");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://evolution.test/chat/findContacts/tenant-instance",
      "http://evolution.test/chat/fetchProfilePictureUrl/tenant-instance"
    ]);
  });

  it("downloads an inbound media message as base64", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      mediaType: "audioMessage",
      fileName: "wamid-audio.ogg",
      mimetype: "audio/ogg; codecs=opus",
      base64: "T2dnUw=="
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.downloadMedia("tenant-instance", "wamid-audio")).resolves.toEqual({
      base64: "T2dnUw==",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "wamid-audio.ogg"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/chat/getBase64FromMediaMessage/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: { key: { id: "wamid-audio" } }, convertToMp4: false })
      })
    );
  });

  it("rejects oversized provider responses before buffering their body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-length": String(EVOLUTION_MAX_RESPONSE_BYTES + 1) }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.connect("tenant-instance")).rejects.toThrow(/size limit/i);
  });

  it("recognizes an existing instance when fetchInstances returns a top-level array", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([{ name: "tenant-instance" }]))
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await client.ensureInstance("tenant-instance");

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/instance/create"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/webhook/set/tenant-instance"))).toBe(true);
  });

  it("sends the webhook secret in a header instead of the URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example/",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await client.ensureInstance("tenant-instance");
    const webhookCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/webhook/set/"));
    expect(webhookCall).toBeDefined();
    const body = JSON.parse(String((webhookCall![1] as RequestInit).body));
    expect(body.webhook.url).toBe("https://backend.example/webhooks/evolution");
    expect(body.webhook.headers).toEqual({ "x-atendon-webhook-secret": "webhook-secret-with-enough-characters" });
    expect(body.webhook.url).not.toContain("webhook-secret");
    expect(body.webhook.events).toContain("MESSAGES_UPSERT");
    expect(body.webhook.events).toContain("MESSAGES_UPDATE");
    expect(body.webhook.events).toContain("CONTACTS_UPSERT");
    expect(body.webhook.events).toContain("CONTACTS_UPDATE");
    expect(body.webhook.events).toContain("PRESENCE_UPDATE");
    expect(body.webhook.events).not.toContain("SEND_MESSAGE");

    const settingsCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/settings/set/"));
    expect(settingsCall).toBeDefined();
    expect(JSON.parse(String((settingsCall![1] as RequestInit).body))).toEqual(expect.objectContaining({
      alwaysOnline: true,
      readMessages: false,
      readStatus: true,
      syncFullHistory: false
    }));

    const presenceCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/instance/setPresence/"));
    // setPresence is no longer called in ensureInstance - it's called after connect()
    expect(presenceCall).toBeUndefined();
  });

  it("does not cache a partially provisioned instance and retries the setup", async () => {
    let webhookAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("/instance/fetchInstances")) {
        return Response.json([{ name: "tenant-instance" }]);
      }
      if (path.includes("/webhook/set/")) {
        webhookAttempts += 1;
        if (webhookAttempts === 1) return new Response("temporary failure", { status: 503 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.ensureInstance("tenant-instance")).rejects.toThrow("503");
    await expect(client.ensureInstance("tenant-instance")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/instance/fetchInstances"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/webhook/set/"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/settings/set/"))).toHaveLength(2);

    const callsAfterSuccessfulRetry = fetchMock.mock.calls.length;
    await client.ensureInstance("tenant-instance");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterSuccessfulRetry);
  });

  it("aborts a request that exceeds the configured timeout", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test", EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example", EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 10
    });
    await expect(client.connect("tenant-instance")).rejects.toThrow(/timeout|aborted/i);
  });

  it("sends read receipts using the readMessages array contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await client.markMessageAsRead("tenant-instance", {
      id: "wamid-1",
      remoteJid: "5511999999999@s.whatsapp.net",
      fromMe: false
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/chat/markMessageAsRead/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          readMessages: [{
            id: "wamid-1",
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: false
          }]
        })
      })
    );
  });

  it("sends multiple read receipts in a single call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await client.markMessageAsRead("tenant-instance", [
      { id: "wamid-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
      { id: "wamid-2", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
      { id: "wamid-3", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/chat/markMessageAsRead/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          readMessages: [
            { id: "wamid-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
            { id: "wamid-2", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
            { id: "wamid-3", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }
          ]
        })
      })
    );
  });

  it("sends chat presence to the bare number expected by Evolution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await client.sendPresence("tenant-instance", "5511999999999@s.whatsapp.net", "composing");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/chat/sendPresence/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ number: "5511999999999", presence: "composing", delay: 1_000 })
      })
    );
  });

  it("sends recorded audio through the WhatsApp voice-note endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ key: { id: "voice-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.sendMedia("tenant-instance", "5511999999999@s.whatsapp.net", {
      mediaType: "audio", mimeType: "audio/webm", fileName: "audio.webm", dataBase64: "V2ViTQ=="
    })).resolves.toEqual({ externalId: "voice-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/message/sendWhatsAppAudio/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ number: "5511999999999", audio: "V2ViTQ==" })
      })
    );
  });

  it("sends a WebP sticker through the dedicated Evolution endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ key: { id: "sticker-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.sendSticker("tenant-instance", "5511999999999@s.whatsapp.net", "UklGRg=="))
      .resolves.toEqual({ externalId: "sticker-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://evolution.test/message/sendSticker/tenant-instance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ number: "5511999999999", sticker: "UklGRg==" })
      })
    );
  });

  it("sends documents with filename, mime type and caption", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ key: { id: "document-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      EVOLUTION_API_URL: "http://evolution.test",
      EVOLUTION_API_KEY: "api-key-with-enough-characters",
      EVOLUTION_WEBHOOK_URL: "https://backend.example",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
      EVOLUTION_TIMEOUT_MS: 15_000
    });

    await expect(client.sendMedia("tenant-instance", "5511999999999", {
      mediaType: "document", mimeType: "application/pdf", fileName: "proposta.pdf", dataBase64: "JVBERg==", caption: "Proposta"
    })).resolves.toEqual({ externalId: "document-1" });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      number: "5511999999999",
      mediatype: "document",
      mimetype: "application/pdf",
      media: "JVBERg==",
      fileName: "proposta.pdf",
      caption: "Proposta"
    });
  });
});

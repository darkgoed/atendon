import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaInstagramProvider } from "../src/modules/instagram/provider.js";

type CapturedFetch = {
  url: string;
  init: RequestInit | undefined;
};

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function sequenceFetch(responses: Array<Response | Error>): {
  calls: CapturedFetch[];
  fetchImpl: typeof fetch;
} {
  const calls: CapturedFetch[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: urlOf(input), init });
    const response = responses[index++];
    if (!response) throw new Error("Unexpected simulated fetch");
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MetaInstagramProvider HTTP contract", () => {
  it("sends text to the versioned Instagram endpoint without redirecting the bearer token", async () => {
    const transport = sequenceFetch([
      Response.json({ recipient_id: "igsid-1", message_id: "mid-1" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: transport.fetchImpl
    });

    await expect(provider.sendText({
      instagramAccountId: "account/unsafe",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "Olá"
    })).resolves.toEqual({ outcome: "accepted", externalId: "mid-1" });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      "https://graph.instagram.com/v26.0/account%2Funsafe/messages"
    );
    expect(transport.calls[0]?.init?.method).toBe("POST");
    expect(transport.calls[0]?.init?.redirect).toBe("manual");
    expect(authorizationHeader(transport.calls[0]?.init)).toBe("Bearer access-token");
    expect(new Headers(transport.calls[0]?.init?.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(transport.calls[0]?.init?.body))).toEqual({
      recipient: { id: "igsid-1" },
      message: { text: "Olá" }
    });
  });

  it("uses the documented singular attachment envelope for every media type", async () => {
    const transport = sequenceFetch([
      Response.json({ recipient_id: "igsid-1", message_id: "image-mid" }),
      Response.json({ recipient_id: "igsid-1", message_id: "audio-mid" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    await provider.sendMedia({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      media: { type: "image", url: "https://cdn.example/image.png" }
    });
    await provider.sendMedia({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      media: { type: "audio", url: "https://cdn.example/audio.m4a" }
    });

    // Envelope singular (`message.attachment`): forma documentada para um
    // único anexo; a imagem única em `attachments: [...]` era recusada.
    expect(JSON.parse(String(transport.calls[0]?.init?.body))).toEqual({
      recipient: { id: "igsid-1" },
      message: {
        attachment: {
          type: "image",
          payload: { url: "https://cdn.example/image.png" }
        }
      }
    });
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({
      recipient: { id: "igsid-1" },
      message: {
        attachment: {
          type: "audio",
          payload: { url: "https://cdn.example/audio.m4a" }
        }
      }
    });
  });

  it("sends reply_to at the payload root and surfaces Meta's rejection detail", async () => {
    const transport = sequenceFetch([
      Response.json({ recipient_id: "igsid-1", message_id: "reply-mid" }),
      Response.json({
        error: {
          message: "(#10) The content of the media does not match the informed format",
          code: 10,
          error_subcode: 2018327,
          error_user_msg: "O formato da mídia não é suportado"
        }
      }, { status: 400 })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    const sent = await provider.sendText({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "Seguindo o assunto",
      replyTo: "mid-bruto-da-mensagem-citada"
    });
    expect(sent.outcome).toBe("accepted");
    // reply_to na RAIZ do payload, ao lado de message (doc Instagram Messaging).
    expect(JSON.parse(String(transport.calls[0]?.init?.body))).toEqual({
      recipient: { id: "igsid-1" },
      message: { text: "Seguindo o assunto" },
      reply_to: { mid: "mid-bruto-da-mensagem-citada" }
    });

    const rejected = await provider.sendMedia({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      media: { type: "audio", url: "https://cdn.example/audio.webm" }
    });
    expect(rejected.outcome).toBe("rejected");
    if (rejected.outcome === "rejected") {
      expect(rejected.message).toContain("O formato da mídia não é suportado");
      expect(rejected.message).toContain("10/2018327");
    }
  });

  it("accepts Meta's documented OAuth envelope while preserving endpoint contracts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const exchange = sequenceFetch([
      Response.json({
        data: [{
          access_token: "short-token",
          user_id: "account-1",
          permissions: "instagram_business_basic,instagram_business_manage_messages"
        }]
      }),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({
      accountId: "account-1",
      username: "business",
      accessToken: "long-token",
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });

    expect(exchange.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/oauth/access_token",
      "/access_token",
      "/v26.0/me"
    ]);
    expect(exchange.calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    expect(exchange.calls[0]?.init?.body).toBeInstanceOf(FormData);

    const refresh = sequenceFetch([
      Response.json({ access_token: "renewed-token", expires_in: 5_184_000 })
    ]);
    const refreshProvider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: refresh.fetchImpl
    });

    await expect(refreshProvider.refreshAccessToken({ accessToken: "long-token" }))
      .resolves.toMatchObject({ accessToken: "renewed-token" });
    expect(new URL(refresh.calls[0]?.url ?? "").pathname).toBe("/refresh_access_token");
    expect(refresh.calls[0]?.init?.redirect).toBe("manual");
  });

  it("retries the long-lived exchange as POST when Meta rejects the documented GET", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const exchange = sequenceFetch([
      Response.json({
        access_token: "short-token",
        user_id: "account-1",
        permissions: "instagram_business_basic,instagram_business_manage_messages"
      }),
      Response.json(
        { error: { message: "Unsupported request - method type: get", type: "IGApiException", code: 100 } },
        { status: 400 }
      ),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({
      accountId: "account-1",
      accessToken: "long-token"
    });

    expect(exchange.calls).toHaveLength(4);
    expect(exchange.calls[1]?.init?.method ?? "GET").toBe("GET");
    expect(exchange.calls[2]?.init?.method).toBe("POST");
    expect(new URL(exchange.calls[2]!.url).pathname).toBe("/access_token");
  });

  // A Meta rejeita este passo para contas legítimas, de forma reproduzível e
  // fora do nosso controle. Abortar aqui derruba a conexão inteira; o token
  // curto autentica /me, webhook e envios, e o refresh promove depois.
  it("keeps the connection on the short-lived token when Meta rejects both exchange attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const rejection = () => Response.json(
      { error: { message: "Unsupported request - method type: get", type: "IGApiException", code: 100 } },
      { status: 400 }
    );
    const exchange = sequenceFetch([
      Response.json({
        access_token: "short-token",
        user_id: "account-1",
        permissions: "instagram_business_basic,instagram_business_manage_messages"
      }),
      rejection(),
      rejection(),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const observed: Error[] = [];
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl,
      onTokenExchangeRejected: (error) => observed.push(error)
    });

    const identity = await provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    });

    expect(identity).toMatchObject({
      accountId: "account-1",
      username: "business",
      accessToken: "short-token",
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    expect(identity.tokenExpiresAt.getTime()).toBe(Date.parse("2026-09-15T01:00:00.000Z"));
    expect(observed).toHaveLength(1);
    // O /me precisa usar o token que ficou salvo, não o long-lived inexistente.
    expect(exchange.calls[3]?.url).toContain("access_token=short-token");
  });

  // Reproduz o caso real de produção: a autorização devolve código e token
  // válidos, mas TODA chamada em nome do usuário é recusada com o mesmo
  // code 100 genérico porque o app não tem acesso àquela conta. Sem esta
  // classificação o painel mandava o usuário "verificar as permissões" e
  // reautorizar em loop, o que nunca resolve.
  it("classifies Meta's generic code 100 rejection on /me as missing app access", async () => {
    const rejection = () => Response.json(
      { error: { message: "Unsupported request - method type: get", type: "IGApiException", code: 100 } },
      { status: 400 }
    );
    const exchange = sequenceFetch([
      Response.json({
        access_token: "short-token",
        user_id: "account-1",
        permissions: "instagram_business_basic,instagram_business_manage_messages"
      }),
      rejection(),
      rejection(),
      rejection()
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    const error = await provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "INSTAGRAM_APP_ACCESS_NOT_GRANTED", statusCode: 403 });
  });

  // Uma recusa do /me por outro motivo não pode ser rotulada como falta de
  // acesso do app: a orientação ao usuário seria errada.
  it("leaves unrelated /me rejections unclassified", async () => {
    const exchange = sequenceFetch([
      Response.json({
        access_token: "short-token",
        user_id: "account-1",
        permissions: "instagram_business_basic,instagram_business_manage_messages"
      }),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json(
        { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } },
        { status: 400 }
      )
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    const error = await provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBeUndefined();
  });

  it.each([
    [
      "comma-separated strings",
      " instagram_business_basic,instagram_business_manage_messages, instagram_business_basic, "
    ],
    [
      "string arrays",
      [
        " instagram_business_basic ",
        "instagram_business_manage_messages",
        "instagram_business_basic",
        ""
      ]
    ]
  ])("trims and deduplicates OAuth permissions from %s", async (_format, permissions) => {
    const exchange = sequenceFetch([
      Response.json({
        data: [{
          access_token: "short-token",
          user_id: "account-1",
          permissions
        }]
      }),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
  });

  it("rejects malformed permission arrays before using the short-lived token", async () => {
    const exchange = sequenceFetch([
      Response.json({
        data: [{
          access_token: "short-secret-token",
          user_id: "account-1",
          permissions: ["instagram_business_basic", 42, "instagram_business_manage_messages"]
        }]
      }),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: exchange.fetchImpl
    });

    const error = await provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Meta request outcome is ambiguous");
    expect(String((error as Error).cause)).not.toContain("short-secret-token");
    expect(exchange.calls).toHaveLength(1);
  });

  it("accepts the flat Instagram Login token response observed in production", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const exchange = sequenceFetch([
      Response.json({
        access_token: "short-token",
        user_id: "account-1",
        permissions: "instagram_business_basic,instagram_business_manage_messages"
      }),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      Response.json({ user_id: "account-1", username: "business" })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({
      accountId: "account-1",
      username: "business",
      accessToken: "long-token",
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    expect(exchange.calls).toHaveLength(3);
  });

  it("preserves Instagram user ids larger than Number.MAX_SAFE_INTEGER", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    // Raw wire format: numeric user_id beyond 2^53 that JSON.parse would round.
    const exchange = sequenceFetch([
      new Response(
        '{"access_token":"short-token","user_id":17841400000000001,"permissions":"instagram_business_basic,instagram_business_manage_messages"}'
      ),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      new Response('{"user_id":"17841400000000001","username":"business"}')
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({ accountId: "17841400000000001" });
  });

  it.each([
    ["missing data", {}],
    ["empty data", { data: [] }],
    ["multiple data entries", {
      data: [
        { access_token: "short-secret-token", user_id: "account-1", permissions: "instagram_business_basic" },
        { access_token: "other-token", user_id: "account-2", permissions: "instagram_business_basic" }
      ]
    }],
    ["non-object data entry", { data: ["short-secret-token"] }],
    ["entry without access token", {
      data: [{ user_id: "account-1", permissions: "instagram_business_basic" }]
    }],
    ["entry without user id", {
      data: [{ access_token: "short-secret-token", permissions: "instagram_business_basic" }]
    }]
  ])("rejects %s as ambiguous without leaking tokens", async (_label, shortResponse) => {
    const exchange = sequenceFetch([Response.json(shortResponse)]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: exchange.fetchImpl
    });

    const error = await provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Meta request outcome is ambiguous");
    expect(String((error as Error).cause)).not.toContain("short-secret-token");
    expect(String((error as Error).cause)).not.toContain("other-token");
    expect(exchange.calls).toHaveLength(1);
  });

  it("uses the /me professional account id even when the token returns an app-scoped user id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const exchange = sequenceFetch([
      new Response(
        '{"access_token":"short-token","user_id":28053816264300131,"permissions":"instagram_business_basic,instagram_business_manage_messages"}'
      ),
      Response.json({ access_token: "long-token", expires_in: 5_184_000 }),
      new Response('{"user_id":"17841448307996024","username":"business"}')
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v26.0",
      fetchImpl: exchange.fetchImpl
    });

    await expect(provider.exchangeOAuthCode({
      code: "one-time-code",
      redirectUri: "https://app.example/callback"
    })).resolves.toMatchObject({ accountId: "17841448307996024" });
    expect(exchange.calls).toHaveLength(3);
  });

  it("subscribes with a bearer header and form body instead of putting the token in the URL", async () => {
    const transport = sequenceFetch([Response.json({ success: true })]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    await provider.subscribeWebhook({
      instagramAccountId: "account-1",
      accessToken: "access-token"
    });

    const call = transport.calls[0];
    expect(call?.url).toBe(
      "https://graph.instagram.com/v26.0/account-1/subscribed_apps"
    );
    expect(authorizationHeader(call?.init)).toBe("Bearer access-token");
    expect(call?.url).not.toContain("access-token");
    expect(call?.init?.redirect).toBe("manual");
    expect(call?.init?.body).toBe(
      "subscribed_fields=messages%2Cmessaging_seen%2Cmessage_reactions%2Cmessaging_postbacks%2Cmessaging_referral"
    );
  });

  it.each([
    ["missing message id", Response.json({ recipient_id: "igsid-1" })],
    ["malformed success JSON", new Response("{", { status: 200 })],
    ["server error", Response.json({ error: { message: "unavailable" } }, { status: 503 })],
    ["redirect", new Response(null, { status: 302, headers: { location: "https://evil.example/" } })]
  ])("classifies %s as ambiguous and does not retry", async (_label, response) => {
    const transport = sequenceFetch([response]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    await expect(provider.sendText({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "hello"
    })).resolves.toEqual({
      outcome: "ambiguous",
      code: "ambiguous",
      message: "Resultado do envio Meta desconhecido"
    });
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    ["timeout", new DOMException("timed out", "AbortError")],
    ["transport crash", new Error("socket closed")]
  ])("classifies %s as ambiguous and does not retry", async (_label, error) => {
    const transport = sequenceFetch([error]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    await expect(provider.sendText({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "hello"
    })).resolves.toMatchObject({ outcome: "ambiguous" });
    expect(transport.calls).toHaveLength(1);
  });

  it("classifies an explicit 4xx Meta response as rejected", async () => {
    const transport = sequenceFetch([
      Response.json({ error: { message: "outside allowed window", code: 10 } }, { status: 400 })
    ]);
    const provider = new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      fetchImpl: transport.fetchImpl
    });

    await expect(provider.sendText({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "hello"
    })).resolves.toEqual({
      outcome: "rejected",
      code: "meta_400",
      // O motivo real da Meta vai na mensagem (era descartado antes).
      message: "Meta rejeitou a mensagem: outside allowed window (código 10)"
    });
    expect(transport.calls).toHaveLength(1);
  });
});

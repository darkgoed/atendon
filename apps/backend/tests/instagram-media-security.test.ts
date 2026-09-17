import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestOptions } from "node:https";
import type {
  HttpsRequestHandle,
  HttpsRequestLike,
  HttpsResponseLike
} from "../src/modules/instagram/provider.js";
import { MetaInstagramProvider } from "../src/modules/instagram/provider.js";
import { signMediaUrl, verifyMediaUrl } from "../src/modules/instagram/media.js";

type ResponseStep = {
  statusCode?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  requestTimeout?: boolean;
  responseTimeout?: boolean;
};

class SimulatedResponse implements HttpsResponseLike {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  yieldedChunks = 0;
  private destroyedWith: Error | undefined;

  constructor(private readonly step: ResponseStep) {
    this.statusCode = step.statusCode ?? 200;
    this.headers = step.headers ?? {};
  }

  setTimeout(_milliseconds: number, callback: () => void): this {
    if (this.step.responseTimeout) queueMicrotask(callback);
    return this;
  }

  destroy(error?: Error): void {
    this.destroyedWith = error ?? new Error("response destroyed");
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    for (const chunk of this.step.chunks ?? []) {
      await Promise.resolve();
      if (this.destroyedWith) throw this.destroyedWith;
      this.yieldedChunks += 1;
      yield chunk;
    }
    if (this.destroyedWith) throw this.destroyedWith;
  }
}

class SimulatedRequest implements HttpsRequestHandle {
  private errorListener: ((error: Error) => void) | undefined;
  private timeoutCallback: (() => void) | undefined;

  constructor(
    private readonly step: ResponseStep,
    private readonly respond: () => void
  ) {}

  once(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.errorListener = listener;
    return this;
  }

  setTimeout(_milliseconds: number, callback: () => void): this {
    this.timeoutCallback = callback;
    return this;
  }

  destroy(error?: Error): void {
    this.errorListener?.(error ?? new Error("request destroyed"));
  }

  end(): void {
    if (this.step.requestTimeout) {
      queueMicrotask(() => this.timeoutCallback?.());
      return;
    }
    queueMicrotask(this.respond);
  }
}

function requestSequence(steps: ResponseStep[]) {
  const calls: Array<{ url: URL; options: RequestOptions }> = [];
  const responses: SimulatedResponse[] = [];
  let index = 0;
  const requestImpl: HttpsRequestLike = (url, options, onResponse) => {
    const step = steps[index++];
    if (!step) throw new Error("Unexpected simulated HTTPS request");
    calls.push({ url: new URL(url.toString()), options });
    const response = new SimulatedResponse(step);
    responses.push(response);
    return new SimulatedRequest(step, () => onResponse(response));
  };
  return { calls, requestImpl, responses };
}

function requestHeader(options: RequestOptions, name: string): string | null {
  const match = options.headers && !Array.isArray(options.headers)
    ? Object.entries(options.headers).find(([header]) => header.toLowerCase() === name)
    : undefined;
  const value: unknown = match?.[1];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ");
  return null;
}

const publicLookup = async (hostname: string, options: { all: true }) => {
  void hostname;
  void options;
  return [
    { address: "93.184.216.34", family: 4 }
  ];
};

function providerWithRequest(
  requestImpl: HttpsRequestLike,
  overrides: { mediaMaxBytes?: number; timeoutMs?: number; lookup?: typeof publicLookup } = {}
): MetaInstagramProvider {
  return new MetaInstagramProvider({
    appId: "app-id",
    appSecret: "app-secret",
    requestImpl,
    lookup: overrides.lookup ?? publicLookup,
    mediaMaxBytes: overrides.mediaMaxBytes,
    timeoutMs: overrides.timeoutMs,
    fetchImpl: async () => {
      throw new Error("fetch must not be used for media downloads");
    }
  });
}

describe("Instagram signed media URLs", () => {
  it("binds the token to an exact id and rejects at the exact expiry second", () => {
    const token = signMediaUrl("media_1", "signing-secret", 60, 100_000);
    expect(verifyMediaUrl(token, "media_1", "signing-secret", 159_999)).toBe(true);
    expect(verifyMediaUrl(token, "media_1", "signing-secret", 160_000)).toBe(false);
    expect(verifyMediaUrl(token, "media_2", "signing-secret", 100_000)).toBe(false);
  });

  it.each([
    ["extra segment", (token: string) => `${token}.extra`],
    ["NaN expiry", (token: string) => token.replace(/\.\d+\./, ".NaN.")],
    ["fractional expiry", (token: string) => token.replace(/\.(\d+)\./, ".$1.5.")],
    ["invalid hex", (token: string) => `${token.slice(0, -1)}z`]
  ])("rejects a token with %s", (_label, mutate) => {
    const token = signMediaUrl("media_1", "signing-secret", 60, 100_000);
    expect(verifyMediaUrl(mutate(token), "media_1", "signing-secret", 100_000)).toBe(false);
  });

  it.each([
    ["empty secret", () => signMediaUrl("media_1", "", 60, 100_000)],
    ["zero ttl", () => signMediaUrl("media_1", "secret", 0, 100_000)],
    ["fractional ttl", () => signMediaUrl("media_1", "secret", 1.5, 100_000)],
    ["id with separator", () => signMediaUrl("media.1", "secret", 60, 100_000)]
  ])("refuses to sign with %s", (_label, operation) => {
    expect(operation).toThrow();
  });

  it("returns false instead of accepting invalid verification inputs", () => {
    const token = signMediaUrl("media_1", "secret", 60, 100_000);
    expect(verifyMediaUrl(token, "media_1", "", 100_000)).toBe(false);
    expect(verifyMediaUrl(token, "media_1", "secret", Number.NaN)).toBe(false);
  });
});

describe("MetaInstagramProvider secure media download", () => {
  it.each([
    ["zero timeout", { timeoutMs: 0 }],
    ["fractional timeout", { timeoutMs: 1.5 }],
    ["zero byte limit", { mediaMaxBytes: 0 }],
    ["fractional byte limit", { mediaMaxBytes: 1.5 }]
  ])("rejects an invalid %s configuration", (_label, invalid) => {
    expect(() => new MetaInstagramProvider({
      appId: "app-id",
      appSecret: "app-secret",
      ...invalid
    })).toThrow();
  });

  it("downloads a bounded valid PNG through HTTPS request with a public socket agent", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("payload")
    ]);
    const transport = requestSequence([{
      headers: {
        "content-type": "image/png",
        "content-length": String(png.length)
      },
      chunks: [png.subarray(0, 5), png.subarray(5)]
    }]);
    const provider = providerWithRequest(transport.requestImpl);

    await expect(provider.fetchMedia({
      url: "https://media.example/image.png",
      accessToken: "access-token"
    })).resolves.toMatchObject({
      bytes: png,
      contentType: "image/png",
      sizeBytes: png.length,
      finalUrl: "https://media.example/image.png"
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.options.method).toBe("GET");
    expect(transport.calls[0]?.options.agent).toBeDefined();
    expect(transport.calls[0]?.options.rejectUnauthorized).toBe(true);
    expect(transport.calls[0]?.options.servername).toBe("media.example");
  });

  // Regressão: a CDN da Meta (lookaside.fbsbx.com) redireciona requisições
  // sem User-Agent para facebook.com/unsupportedbrowser (HTML) em vez de
  // servir a mídia real — sem este header, todo download de áudio/imagem/
  // vídeo do Instagram falhava com "Unsupported media type" mesmo com token
  // e URL corretos.
  it("always sends a User-Agent header, including for non-graph media hosts", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("payload")
    ]);
    const transport = requestSequence([{
      headers: { "content-type": "image/png" },
      chunks: [png]
    }]);
    const provider = providerWithRequest(transport.requestImpl);

    await provider.fetchMedia({
      url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
      accessToken: "access-token"
    });

    const userAgent = requestHeader(transport.calls[0]?.options ?? {}, "user-agent");
    expect(userAgent).toBeTruthy();
    expect(userAgent).not.toBeNull();
  });

  it("validates every redirect hop and strips the bearer token outside graph.instagram.com", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("data")
    ]);
    const transport = requestSequence([
      {
        statusCode: 302,
        headers: { location: "https://cdn.example/file.png" }
      },
      {
        headers: { "content-type": "image/png" },
        chunks: [png]
      }
    ]);
    const provider = providerWithRequest(transport.requestImpl);

    await provider.fetchMedia({
      url: "https://graph.instagram.com/media/1",
      accessToken: "access-token"
    });

    expect(transport.calls.map((call) => call.url.hostname)).toEqual([
      "graph.instagram.com",
      "cdn.example"
    ]);
    expect(requestHeader(transport.calls[0]?.options ?? {}, "authorization"))
      .toBe("Bearer access-token");
    expect(requestHeader(transport.calls[1]?.options ?? {}, "authorization"))
      .toBeNull();
  });

  it("blocks a redirect that resolves to a private address before making the next request", async () => {
    const transport = requestSequence([{
      statusCode: 302,
      headers: { location: "https://private.example/file.png" }
    }]);
    const lookup = async (hostname: string, options: { all: true }) => {
      void options;
      return hostname === "private.example"
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];
    };
    const provider = providerWithRequest(transport.requestImpl, { lookup });

    await expect(provider.fetchMedia({
      url: "https://graph.instagram.com/media/1",
      accessToken: "access-token"
    })).rejects.toThrow("publicly");
    expect(transport.calls).toHaveLength(1);
  });

  it("stops reading the stream as soon as the configured byte limit is exceeded", async () => {
    const transport = requestSequence([{
      headers: { "content-type": "image/png" },
      chunks: [
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("must-not-be-consumed")
      ]
    }]);
    const provider = providerWithRequest(transport.requestImpl, { mediaMaxBytes: 6 });

    await expect(provider.fetchMedia({
      url: "https://media.example/image.png",
      accessToken: "access-token"
    })).rejects.toThrow("Media too large");
    expect(transport.responses[0]?.yieldedChunks).toBe(2);
  });

  it("rejects MIME content whose magic bytes do not match the declared type", async () => {
    const transport = requestSequence([{
      headers: { "content-type": "image/png" },
      chunks: [Buffer.from("%PDF-1.7 fake png")]
    }]);
    const provider = providerWithRequest(transport.requestImpl);

    await expect(provider.fetchMedia({
      url: "https://media.example/image.png",
      accessToken: "access-token"
    })).rejects.toThrow("Media content does not match MIME type");
  });

  it.each([
    ["request timeout", { requestTimeout: true }],
    ["response timeout", {
      responseTimeout: true,
      headers: { "content-type": "image/png" },
      chunks: [Buffer.from([0x89, 0x50, 0x4e, 0x47])]
    }]
  ])("aborts on %s", async (_label, step) => {
    const transport = requestSequence([step]);
    const provider = providerWithRequest(transport.requestImpl, { timeoutMs: 10 });

    await expect(provider.fetchMedia({
      url: "https://media.example/image.png",
      accessToken: "access-token"
    })).rejects.toThrow("Media request timed out");
  });

  it("rejects redirect chains beyond the fixed limit", async () => {
    const transport = requestSequence(Array.from({ length: 4 }, (_, index) => ({
      statusCode: 302,
      headers: { location: `https://media.example/hop-${index + 1}` }
    })));
    const provider = providerWithRequest(transport.requestImpl);

    await expect(provider.fetchMedia({
      url: "https://media.example/start",
      accessToken: "access-token"
    })).rejects.toThrow("Too many media redirects");
    expect(transport.calls).toHaveLength(4);
  });
});

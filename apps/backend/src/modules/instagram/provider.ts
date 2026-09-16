import { createHmac, timingSafeEqual } from "node:crypto";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestOptions } from "node:https";
import {
  publicHttpsAgent,
  resolvePublicHttpsUrl
} from "../../security/outbound-url.js";
import type {
  DownloadedMedia,
  InstagramProvider,
  NormalizedInstagramEvent,
  OAuthIdentity,
  OutboundMedia,
  ProviderSendResult,
  TokenResult
} from "./types.js";

type FetchLike = typeof fetch;

export type HttpsResponseLike = AsyncIterable<Uint8Array | string> & {
  readonly statusCode?: number;
  readonly headers: IncomingHttpHeaders;
  setTimeout(milliseconds: number, callback: () => void): HttpsResponseLike;
  destroy(error?: Error): void;
};

export type HttpsRequestHandle = {
  once(event: "error", listener: (error: Error) => void): HttpsRequestHandle;
  setTimeout(milliseconds: number, callback: () => void): HttpsRequestHandle;
  destroy(error?: Error): void;
  end(): void;
};

export type HttpsRequestLike = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: HttpsResponseLike) => void
) => HttpsRequestHandle;

const systemHttpsRequest: HttpsRequestLike = (url, options, onResponse) =>
  https.request(url, options, onResponse);

export type MetaProviderOptions = {
  appId: string;
  appSecret: string;
  graphVersion?: string;
  timeoutMs?: number;
  mediaMaxBytes?: number;
  fetchImpl?: FetchLike;
  requestImpl?: HttpsRequestLike;
  lookup?: Parameters<typeof resolvePublicHttpsUrl>[1];
};

class MetaRejectedError extends Error {
  constructor(readonly status: number, readonly detail?: string) {
    super(detail ? `Meta request rejected (${status}): ${detail}` : "Meta request rejected");
  }
}

class MetaAmbiguousError extends Error {
  constructor(cause?: unknown) {
    super("Meta request outcome is ambiguous", { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetaAmbiguousError(new Error(`Meta response missing ${field}`));
  }
  return value;
}

function oauthTokenEntry(response: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(response.data)
    && response.data.length === 1
    && isRecord(response.data[0])) {
    return response.data[0];
  }
  // A Business Login com Instagram Login responde com objeto plano
  // { access_token, user_id, permissions } na prática, embora a documentação
  // mostre o envelope { data: [...] }. Aceitar os dois formatos.
  if (typeof response.access_token === "string"
    && (typeof response.user_id === "string" || typeof response.user_id === "number")) {
    return { ...response, user_id: String(response.user_id) };
  }
  throw new MetaAmbiguousError(new Error("Meta OAuth response has invalid data envelope"));
}

function oauthPermissions(value: unknown): string[] {
  let permissions: string[];
  if (typeof value === "string") {
    permissions = value.split(",");
  } else if (Array.isArray(value) && value.every((permission) => typeof permission === "string")) {
    permissions = value;
  } else if (value === undefined) {
    permissions = [];
  } else {
    throw new MetaAmbiguousError(new Error("Meta OAuth response has invalid permissions"));
  }
  return [...new Set(
    permissions
      .map((permission) => permission.trim())
      .filter((permission) => permission.length > 0)
  )];
}

function tokenExpiry(value: unknown): Date {
  const expiresIn = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MetaAmbiguousError(new Error("Meta response has invalid expires_in"));
  }
  return new Date(Date.now() + expiresIn * 1_000);
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

function startsWithBytes(bytes: Buffer, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Buffer, offset: number, expected: string): boolean {
  return bytes.length >= offset + expected.length
    && bytes.subarray(offset, offset + expected.length).toString("ascii") === expected;
}

const SUPPORTED_MEDIA_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "video/mp4",
  "video/quicktime",
  "video/ogg",
  "video/x-msvideo",
  "video/webm"
]);

function matchesMimeMagic(contentType: string, bytes: Buffer): boolean {
  switch (contentType) {
    case "image/png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "application/pdf":
      return asciiAt(bytes, 0, "%PDF-");
    case "audio/aac":
      return asciiAt(bytes, 0, "ADIF")
        || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0);
    case "audio/wav":
    case "audio/x-wav":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
    case "video/quicktime":
      return asciiAt(bytes, 4, "ftyp");
    case "video/ogg":
      return asciiAt(bytes, 0, "OggS");
    case "video/x-msvideo":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "AVI ");
    case "video/webm":
      return startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}

function mediaLimit(contentType: string, configuredLimit: number): number {
  const providerLimit = contentType.startsWith("image/")
    ? 8 * 1024 * 1024
    : 25 * 1024 * 1024;
  return Math.min(configuredLimit, providerLimit);
}

export class MetaInstagramProvider implements InstagramProvider {
  private readonly fetchImpl: FetchLike;
  private readonly requestImpl: HttpsRequestLike;
  private readonly mediaAgent: https.Agent;
  private readonly versionedBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly mediaMaxBytes: number;

  constructor(private readonly options: MetaProviderOptions) {
    const graphVersion = options.graphVersion ?? "v26.0";
    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      throw new Error("Invalid Instagram Graph API version");
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    const mediaMaxBytes = options.mediaMaxBytes ?? 25 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Invalid Meta request timeout");
    }
    if (!Number.isSafeInteger(mediaMaxBytes) || mediaMaxBytes <= 0) {
      throw new Error("Invalid Instagram media byte limit");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestImpl = options.requestImpl ?? systemHttpsRequest;
    this.mediaAgent = publicHttpsAgent(options.lookup);
    this.versionedBaseUrl = `https://graph.instagram.com/${graphVersion}`;
    this.timeoutMs = timeoutMs;
    this.mediaMaxBytes = mediaMaxBytes;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status >= 400 && response.status < 500) {
        let detail: string | undefined;
        try {
          detail = (await response.text()).slice(0, 500);
        } catch {
          detail = undefined;
        }
        throw new MetaRejectedError(response.status, detail);
      }
      if (!response.ok) {
        throw new MetaAmbiguousError();
      }
      return response;
    } catch (error) {
      if (error instanceof MetaRejectedError || error instanceof MetaAmbiguousError) {
        throw error;
      }
      throw new MetaAmbiguousError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.request(url, init);
    try {
      const data: unknown = await response.json();
      if (!isRecord(data)) throw new Error("Meta response must be an object");
      return data;
    } catch (error) {
      throw new MetaAmbiguousError(error);
    }
  }

  async exchangeOAuthCode(input: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const body = new FormData();
    body.set("client_id", this.options.appId);
    body.set("client_secret", this.options.appSecret);
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", input.redirectUri);
    body.set("code", input.code);

    const shortTokenResponse = await this.requestJson(
      "https://api.instagram.com/oauth/access_token",
      { method: "POST", body }
    );
    const shortToken = oauthTokenEntry(shortTokenResponse);
    const shortAccessToken = requiredString(shortToken.access_token, "access_token");
    const shortUserId = requiredString(shortToken.user_id, "user_id");
    const scopes = oauthPermissions(shortToken.permissions);

    const longTokenUrl = new URL("https://graph.instagram.com/access_token");
    longTokenUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.options.appSecret,
      access_token: shortAccessToken
    }).toString();
    const longToken = await this.requestJson(longTokenUrl.toString());
    const longAccessToken = requiredString(longToken.access_token, "access_token");

    const identityUrl = new URL(`${this.versionedBaseUrl}/me`);
    identityUrl.search = new URLSearchParams({
      fields: "user_id,username",
      access_token: longAccessToken
    }).toString();
    const identity = await this.requestJson(identityUrl.toString());
    const accountId = requiredString(identity.user_id, "user_id");
    if (accountId !== shortUserId) throw new Error("Meta account identity mismatch");

    return {
      accountId,
      username: typeof identity.username === "string" ? identity.username : null,
      accessToken: longAccessToken,
      tokenExpiresAt: tokenExpiry(longToken.expires_in),
      scopes
    };
  }

  async refreshAccessToken(input: { accessToken: string }): Promise<TokenResult> {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.search = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: input.accessToken
    }).toString();
    const data = await this.requestJson(url.toString());
    return {
      accessToken: requiredString(data.access_token, "access_token"),
      expiresAt: tokenExpiry(data.expires_in)
    };
  }

  async subscribeWebhook(input: {
    instagramAccountId: string;
    accessToken: string;
  }): Promise<void> {
    const url = `${this.versionedBaseUrl}/${encodeURIComponent(input.instagramAccountId)}/subscribed_apps`;
    const body = new URLSearchParams({
      subscribed_fields: [
        "messages",
        "messaging_seen",
        "message_reactions",
        "messaging_postbacks",
        "messaging_referral"
      ].join(",")
    });
    const data = await this.requestJson(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    if (data.success !== true) throw new MetaAmbiguousError();
  }

  private async send(input: {
    instagramAccountId: string;
    accessToken: string;
    payload: unknown;
  }): Promise<ProviderSendResult> {
    try {
      const data = await this.requestJson(
        `${this.versionedBaseUrl}/${encodeURIComponent(input.instagramAccountId)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(input.payload)
        }
      );
      return {
        outcome: "accepted",
        externalId: requiredString(data.message_id, "message_id")
      };
    } catch (error) {
      if (error instanceof MetaRejectedError) {
        return {
          outcome: "rejected",
          code: `meta_${error.status}`,
          message: "Meta rejeitou a mensagem"
        };
      }
      return {
        outcome: "ambiguous",
        code: "ambiguous",
        message: "Resultado do envio Meta desconhecido"
      };
    }
  }

  sendText(input: {
    instagramAccountId: string;
    recipientId: string;
    accessToken: string;
    text: string;
  }): Promise<ProviderSendResult> {
    return this.send({
      instagramAccountId: input.instagramAccountId,
      accessToken: input.accessToken,
      payload: {
        recipient: { id: input.recipientId },
        message: { text: input.text }
      }
    });
  }

  sendMedia(input: {
    instagramAccountId: string;
    recipientId: string;
    accessToken: string;
    media: OutboundMedia;
  }): Promise<ProviderSendResult> {
    const attachment = {
      type: input.media.type,
      payload: { url: input.media.url }
    };
    return this.send({
      instagramAccountId: input.instagramAccountId,
      accessToken: input.accessToken,
      payload: {
        recipient: { id: input.recipientId },
        message: input.media.type === "image"
          ? { attachments: [attachment] }
          : { attachment }
      }
    });
  }

  private requestMedia(url: URL, accessToken: string): Promise<HttpsResponseLike> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(timeoutSignal.aborted ? new Error("Media request timed out") : error);
      };
      const timeoutError = () => new Error("Media request timed out");
      let request: HttpsRequestHandle;
      try {
        request = this.requestImpl(
          url,
          {
            method: "GET",
            agent: this.mediaAgent,
            rejectUnauthorized: true,
            servername: url.hostname,
            signal: timeoutSignal,
            headers: url.hostname === "graph.instagram.com"
              ? { authorization: `Bearer ${accessToken}` }
              : {}
          },
          (response) => {
            if (settled) {
              response.destroy();
              return;
            }
            settled = true;
            resolve(response);
          }
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Media request failed"));
        return;
      }
      request.once("error", fail);
      request.setTimeout(this.timeoutMs, () => request.destroy(timeoutError()));
      request.end();
    });
  }

  private async readMediaBody(response: HttpsResponseLike, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    const timeoutError = () => new Error("Media request timed out");
    const wallClockTimeout = setTimeout(
      () => response.destroy(timeoutError()),
      this.timeoutMs
    );
    response.setTimeout(this.timeoutMs, () => response.destroy(timeoutError()));
    try {
      for await (const chunk of response) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        sizeBytes += bytes.length;
        if (sizeBytes > limit) {
          response.destroy();
          throw new Error("Media too large");
        }
        chunks.push(bytes);
      }
    } finally {
      clearTimeout(wallClockTimeout);
    }
    return Buffer.concat(chunks, sizeBytes);
  }

  async fetchMedia(input: { url: string; accessToken: string }): Promise<DownloadedMedia> {
    let url = await resolvePublicHttpsUrl(input.url, this.options.lookup);
    let redirects = 0;

    while (true) {
      const response = await this.requestMedia(url, input.accessToken);
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        const location = singleHeader(response.headers, "location");
        response.destroy();
        if (!location) throw new Error("Invalid media redirect");
        if (redirects >= 3) throw new Error("Too many media redirects");
        url = await resolvePublicHttpsUrl(
          new URL(location, url).toString(),
          this.options.lookup
        );
        redirects += 1;
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.destroy();
        throw new Error("Media fetch rejected");
      }

      const rawContentType = singleHeader(response.headers, "content-type");
      const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
      if (!contentType || !SUPPORTED_MEDIA_MIME_TYPES.has(contentType)) {
        response.destroy();
        throw new Error("Unsupported media type");
      }

      const limit = mediaLimit(contentType, this.mediaMaxBytes);
      const rawLength = singleHeader(response.headers, "content-length");
      if (rawLength !== null) {
        const declaredLength = Number(rawLength);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          response.destroy();
          throw new Error("Invalid media content length");
        }
        if (declaredLength > limit) {
          response.destroy();
          throw new Error("Media too large");
        }
      }

      const bytes = await this.readMediaBody(response, limit);
      if (!matchesMimeMagic(contentType, bytes)) {
        throw new Error("Media content does not match MIME type");
      }
      return {
        bytes,
        contentType,
        sizeBytes: bytes.length,
        finalUrl: url.toString()
      };
    }
  }
}

export function verifyInstagramSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string
): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const supplied = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(supplied, expected);
}

export function verifyChallenge(
  query: { mode?: string; token?: string; challenge?: string },
  expected: string
): string {
  if (
    !expected
    || query.mode !== "subscribe"
    || !query.token
    || Buffer.byteLength(query.token) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(query.token), Buffer.from(expected))
    || !query.challenge
  ) {
    throw new Error("Invalid webhook challenge");
  }
  return query.challenge;
}

type WebhookMessaging = {
  sender?: unknown;
  recipient?: unknown;
  timestamp?: unknown;
  message?: unknown;
  read?: unknown;
  reaction?: unknown;
  postback?: unknown;
  referral?: unknown;
  thread?: unknown;
};

type WebhookEntry = {
  id?: unknown;
  time?: unknown;
  messaging?: unknown;
};

function stringId(container: unknown): string | null {
  if (!isRecord(container)) return null;
  return typeof container.id === "string" && container.id.length > 0 ? container.id : null;
}

function supportedMediaType(value: unknown): OutboundMedia["type"] | null {
  return value === "image" || value === "audio" || value === "video" || value === "file"
    ? value
    : null;
}

function normalizedMedia(message: Record<string, unknown>): OutboundMedia[] {
  if (!Array.isArray(message.attachments)) return [];
  return message.attachments.flatMap((attachment) => {
    if (!isRecord(attachment) || !isRecord(attachment.payload)) return [];
    const type = supportedMediaType(attachment.type);
    const url = attachment.payload.url;
    return type && typeof url === "string" && url.length > 0 ? [{ type, url }] : [];
  });
}

function classifyMessaging(messaging: WebhookMessaging): {
  kind: NormalizedInstagramEvent["kind"];
  payload: Record<string, unknown>;
} | null {
  for (const kind of ["message", "read", "reaction", "postback", "referral"] as const) {
    const payload = messaging[kind];
    if (isRecord(payload)) return { kind, payload };
  }
  return null;
}

function eventIdFor(
  kind: NormalizedInstagramEvent["kind"],
  payload: Record<string, unknown>,
  senderId: string,
  timestamp: number
): string | null {
  if (kind === "message" || kind === "read" || kind === "postback") {
    return typeof payload.mid === "string" && payload.mid.length > 0
      ? `${kind}:${payload.mid}`
      : null;
  }
  if (kind === "reaction") {
    if (typeof payload.mid !== "string" || payload.mid.length === 0) return null;
    if (payload.action !== "react" && payload.action !== "unreact") return null;
    const reaction = typeof payload.reaction === "string" ? payload.reaction : "";
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    return `reaction:${payload.mid}:${payload.action}:${reaction}:${emoji}:${timestamp}`;
  }
  const reference = typeof payload.ref === "string" ? payload.ref : "";
  return `referral:${senderId}:${reference}:${timestamp}`;
}

export function normalizeInstagramWebhook(
  raw: unknown,
  now = Date.now()
): NormalizedInstagramEvent[] {
  if (
    !isRecord(raw)
    || raw.object !== "instagram"
    || !Array.isArray(raw.entry)
    || !Number.isFinite(now)
    || now <= 0
  ) {
    return [];
  }
  const output: NormalizedInstagramEvent[] = [];

  for (const rawEntry of raw.entry) {
    if (!isRecord(rawEntry)) continue;
    const entry: WebhookEntry = rawEntry;
    const accountId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
    if (!accountId || !Array.isArray(entry.messaging)) continue;

    for (const rawMessaging of entry.messaging) {
      if (!isRecord(rawMessaging)) continue;
      const messaging: WebhookMessaging = rawMessaging;
      const classified = classifyMessaging(messaging);
      if (!classified) continue;

      const senderId = stringId(messaging.sender);
      const suppliedRecipientId = stringId(messaging.recipient);
      const recipientId: string | null = suppliedRecipientId
        ?? (classified.kind === "read" ? accountId : null);
      if (!senderId || !recipientId || senderId === recipientId) continue;

      const payloadTimestamp = messaging.timestamp ?? entry.time;
      const timestamp = typeof payloadTimestamp === "number"
        ? payloadTimestamp
        : Number(payloadTimestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      const safeTimestamp = Math.min(timestamp, now);

      const flaggedEcho = classified.kind === "message"
        && Boolean(classified.payload.is_echo || classified.payload.is_self);
      const businessIsSender = senderId === accountId;
      if (flaggedEcho && !businessIsSender) continue;
      const isEcho = classified.kind === "message" && businessIsSender;
      if (isEcho ? recipientId === accountId : recipientId !== accountId) continue;

      const eventId = eventIdFor(
        classified.kind,
        classified.payload,
        senderId,
        timestamp
      );
      if (!eventId) continue;

      const message = classified.kind === "message" ? classified.payload : undefined;
      const threadId = stringId(messaging.thread);
      output.push({
        kind: classified.kind,
        eventId,
        accountId,
        providerUserId: isEcho ? recipientId : senderId,
        providerThreadId: threadId ?? undefined,
        externalId: message && typeof message.mid === "string" ? message.mid : undefined,
        timestamp: new Date(safeTimestamp),
        text: message && typeof message.text === "string" ? message.text : undefined,
        media: message ? normalizedMedia(message) : [],
        isEcho,
        raw: rawMessaging
      });
    }
  }
  return output;
}

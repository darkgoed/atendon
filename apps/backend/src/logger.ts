import pino from "pino";
import { config } from "./config.js";

export function sanitizeRequestUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const pathname = value.split("?", 1)[0];
  return pathname.replace(/^\/invitations\/[^/]+$/, "/invitations/[redacted]");
}

export const LOGGER_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "req.headers.x-atendon-webhook-secret",
  "password",
  "password_hash",
  "token",
  "secret",
  "apiKey",
  "api_key",
  "clientSecret",
  "refreshToken",
  "accessToken",
  "email",
  "contactPhone",
  "contactJid",
  "remoteJid",
  "externalId",
  "instance",
  "instanceName",
  "ownerJid",
  "sourceUrl",
  "mediaUrl",
  "thumbnailUrl",
  "*.password",
  "*.password_hash",
  "*.token",
  "*.secret",
  "*.apiKey",
  "*.api_key",
  "*.clientSecret",
  "*.refreshToken",
  "*.accessToken",
  "*.email",
  "*.contactPhone",
  "*.contactJid",
  "*.remoteJid",
  "*.externalId",
  "*.instance",
  "*.instanceName",
  "*.ownerJid",
  "*.sourceUrl",
  "*.mediaUrl",
  "*.thumbnailUrl"
] as const;

export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [...LOGGER_REDACTION_PATHS],
    censor: "[Redacted]"
  },
  serializers: {
    req(request: {
      method?: string;
      url?: string;
      headers?: { host?: string };
      socket?: { remoteAddress?: string };
      raw?: { method?: string; url?: string; headers?: { host?: string }; socket?: { remoteAddress?: string } };
    }) {
      const raw = request.raw ?? request;
      return {
        method: request.method ?? raw.method,
        url: sanitizeRequestUrl(request.url ?? raw.url),
        host: request.headers?.host ?? raw.headers?.host,
        remoteAddress: request.socket?.remoteAddress ?? raw.socket?.remoteAddress
      };
    }
  }
});

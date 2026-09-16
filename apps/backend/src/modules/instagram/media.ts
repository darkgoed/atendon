import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePublicHttpsUrl } from "../../security/outbound-url.js";

export const MAX_MEDIA_URL_TTL_SECONDS = 3_600;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

function validNow(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}

function assertSigningInput(
  id: string,
  secret: string,
  ttlSeconds: number,
  now: number
): void {
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error("Invalid media id");
  if (!secret) throw new Error("Media signing secret is required");
  if (
    !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds <= 0
    || ttlSeconds > MAX_MEDIA_URL_TTL_SECONDS
  ) {
    throw new Error("Invalid media URL TTL");
  }
  if (!validNow(now)) throw new Error("Invalid media URL clock");
}

export function signMediaUrl(
  id: string,
  secret: string,
  ttlSeconds = 300,
  now = Date.now()
): string {
  assertSigningInput(id, secret, ttlSeconds, now);
  const expiresAt = Math.floor(now / 1_000) + ttlSeconds;
  const value = `${id}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${signature}`;
}

export function verifyMediaUrl(
  token: string,
  id: string,
  secret: string,
  now = Date.now()
): boolean {
  if (!MEDIA_ID_PATTERN.test(id) || !secret || !validNow(now)) return false;
  const segments = token.split(".");
  if (segments.length !== 3) return false;
  const [tokenId, rawExpiry, suppliedSignature] = segments;
  if (
    tokenId !== id
    || !/^\d+$/.test(rawExpiry ?? "")
    || !SIGNATURE_PATTERN.test(suppliedSignature ?? "")
  ) {
    return false;
  }
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1_000)) {
    return false;
  }
  const value = `${tokenId}.${rawExpiry}`;
  const expected = createHmac("sha256", secret).update(value).digest();
  const supplied = Buffer.from(suppliedSignature, "hex");
  return timingSafeEqual(supplied, expected);
}

export async function validateMediaUrl(
  url: string,
  lookup?: Parameters<typeof resolvePublicHttpsUrl>[1]
): Promise<URL> {
  return resolvePublicHttpsUrl(url, lookup);
}

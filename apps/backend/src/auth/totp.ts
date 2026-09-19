import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, errors } from "jose";
import type { FastifyReply } from "fastify";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { encryptSecret, decryptSecret } from "../modules/ai-router/secret-box.js";
import { httpError } from "../modules/scheduling/service.js";

/**
 * B2 Security (b): TOTP (RFC 6238) + desafio do 2º passo do login.
 * Sem dependência nova: HMAC-SHA1/30s/6 dígitos implementado em cima de
 * node:crypto. O segredo fica CIFRADO em users.totp_secret_encrypted
 * (secret-box v2 / DATA_ENCRYPTION_KEY). O QR é gerado no cliente (spec).
 */

const TOTP_ISSUER = "AtendON";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_VERIFY_WINDOW = 1; // ±1 período compensa deriva de relógio.
const CHALLENGE_COOKIE = "atendon_totp_challenge";
const CHALLENGE_TTL_SECONDS = 300;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  // 160 bits (RFC 4226 recomendado), base32 sem padding.
  return base32Encode(randomBytes(20));
}

function base32Encode(bytes: Buffer): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Secret TOTP inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpCode(secretBase32: string, at: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS));
}

export function verifyTotp(secretBase32: string, code: string, at: Date = new Date()): boolean {
  const normalized = code.replace(/\D/g, "");
  if (normalized.length !== TOTP_DIGITS) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  const presented = Buffer.from(normalized);
  for (let drift = -TOTP_VERIFY_WINDOW; drift <= TOTP_VERIFY_WINDOW; drift++) {
    const candidate = Buffer.from(hotp(secret, counter + drift));
    if (timingSafeEqual(presented, candidate)) return true;
  }
  return false;
}

export function totpAuthUrl(secretBase32: string, email: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function encryptTotpSecret(secretBase32: string): string {
  return encryptSecret(secretBase32, config.DATA_ENCRYPTION_KEY);
}

export function decryptTotpSecret(encrypted: string): string {
  return decryptSecret(encrypted, config.DATA_ENCRYPTION_KEY);
}

const challengeSecret = new TextEncoder().encode(config.JWT_SECRET);

/**
 * 2º passo do login: cookie de DESAFIO de 5 minutos (não é sessão). Não
 * carrega tenantId/role e requireIdentity o rejeita — só
 * /auth/totp/verify o consome. Login de usuário SEM 2FA nunca passa por aqui
 * (compat: fluxo atual intocado).
 */
export async function issueTotpChallenge(reply: FastifyReply, userId: string): Promise<void> {
  const token = await new SignJWT({ userId, totpChallenge: true })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(challengeSecret);
  reply.setCookie(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: "/",
    maxAge: CHALLENGE_TTL_SECONDS
  });
}

export async function readTotpChallenge(request: { cookies: Record<string, string | undefined> }): Promise<string> {
  const token = request.cookies[CHALLENGE_COOKIE];
  if (!token) throw Object.assign(new Error("Desafio de duas etapas expirado; faça login novamente"), { statusCode: 401 });
  try {
    const { payload } = await jwtVerify(token, challengeSecret, { algorithms: ["HS256"] });
    if (payload.totpChallenge !== true || typeof payload.userId !== "string") {
      throw new Error("invalid");
    }
    return payload.userId;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      throw Object.assign(new Error("Desafio de duas etapas expirado; faça login novamente"), { statusCode: 401 });
    }
    throw error;
  }
}

export function clearTotpChallenge(reply: FastifyReply): void {
  reply.clearCookie(CHALLENGE_COOKIE, { path: "/" });
}

export async function loadTotpState(userId: string): Promise<{ enabled: boolean; secretBase32: string | null }> {
  const result = await db.query<{ totp_secret_encrypted: string | null; totp_enabled_at: Date | string | null }>(
    "SELECT totp_secret_encrypted,totp_enabled_at FROM users WHERE id=$1",
    [userId]
  );
  const row = result.rows[0];
  if (!row) throw httpError(404, "Usuário não encontrado");
  return {
    enabled: Boolean(row.totp_enabled_at),
    secretBase32: row.totp_secret_encrypted
      ? decryptTotpSecret(row.totp_secret_encrypted)
      : null
  };
}

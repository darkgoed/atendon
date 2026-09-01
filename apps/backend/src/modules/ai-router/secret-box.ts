import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CURRENT_VERSION = "v2";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const INVALID_ENCRYPTED_SECRET = "Invalid encrypted secret";

export interface SecretKeyring {
  current: string;
  previous?: readonly string[];
  legacy?: readonly string[];
}

function key(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function keyId(secret: string): string {
  return createHash("sha256").update(`atendon-data-key:${secret}`).digest("base64url").slice(0, 16);
}

function uniqueKeys(keyring: SecretKeyring): string[] {
  return [...new Set([keyring.current, ...(keyring.previous ?? []), ...(keyring.legacy ?? [])])];
}

function normalizeKeyring(value: string | SecretKeyring): SecretKeyring {
  return typeof value === "string" ? { current: value } : value;
}

function decodeCanonical(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error(INVALID_ENCRYPTED_SECRET);
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) throw new Error(INVALID_ENCRYPTED_SECRET);
  return decoded;
}

export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [CURRENT_VERSION, keyId(secret), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptWithKey(iv: Buffer, tag: Buffer, encrypted: Buffer, secret: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(secret), iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function decryptSecret(value: string, keys: string | SecretKeyring): string {
  const keyring = normalizeKeyring(keys);
  const parts = value.split(".");
  const candidates = uniqueKeys(keyring);
  try {
    if (parts[0] === CURRENT_VERSION && parts.length === 5) {
      const [, encryptedKeyId, encodedIv, encodedTag, encodedValue] = parts;
      decodeCanonical(encryptedKeyId);
      const iv = decodeCanonical(encodedIv);
      const tag = decodeCanonical(encodedTag);
      const encrypted = decodeCanonical(encodedValue);
      if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) throw new Error(INVALID_ENCRYPTED_SECRET);
      const selected = candidates.find((candidate) => keyId(candidate) === encryptedKeyId);
      if (!selected) throw new Error(`${INVALID_ENCRYPTED_SECRET} (unavailable)`);
      return decryptWithKey(iv, tag, encrypted, selected);
    }
    if (parts[0] !== "v1" || parts.length !== 4) throw new Error(INVALID_ENCRYPTED_SECRET);
    const [, encodedIv, encodedTag, encodedValue] = parts;
    const iv = decodeCanonical(encodedIv);
    const tag = decodeCanonical(encodedTag);
    const encrypted = decodeCanonical(encodedValue);
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) throw new Error(INVALID_ENCRYPTED_SECRET);
    for (const candidate of candidates) {
      try {
        return decryptWithKey(iv, tag, encrypted, candidate);
      } catch {
        // Try the next rotation key.
      }
    }
  } catch (error) {
    // Keep malformed input and authentication failures indistinguishable.
    if (error instanceof Error && error.message === `${INVALID_ENCRYPTED_SECRET} (unavailable)`) throw error;
  }
  throw new Error(INVALID_ENCRYPTED_SECRET);
}

export function encryptedSecretNeedsRotation(value: string, currentKey: string): boolean {
  const [version, encryptedKeyId] = value.split(".");
  return version !== CURRENT_VERSION || encryptedKeyId !== keyId(currentKey);
}

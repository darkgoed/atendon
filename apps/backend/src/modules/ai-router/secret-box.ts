import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CURRENT_VERSION = "v2";

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

export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [CURRENT_VERSION, keyId(secret), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptWithKey(encodedIv: string, encodedTag: string, encodedValue: string, secret: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encodedValue, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptSecret(value: string, keys: string | SecretKeyring): string {
  const keyring = normalizeKeyring(keys);
  const parts = value.split(".");
  const candidates = uniqueKeys(keyring);
  let encodedIv: string;
  let encodedTag: string;
  let encodedValue: string;

  if (parts[0] === CURRENT_VERSION && parts.length === 5) {
    const [, encryptedKeyId, iv, tag, encrypted] = parts;
    encodedIv = iv;
    encodedTag = tag;
    encodedValue = encrypted;
    const selected = candidates.find((candidate) => keyId(candidate) === encryptedKeyId);
    if (!selected) throw new Error("Encrypted secret key is unavailable");
    try {
      return decryptWithKey(encodedIv, encodedTag, encodedValue, selected);
    } catch {
      throw new Error("Invalid encrypted secret");
    }
  }

  // v1 ciphertexts did not carry a key identifier and were derived from
  // JWT_SECRET. Try the supplied keyring so they can be read and rotated
  // without rewriting or losing the stored value during deployment.
  if (parts[0] !== "v1" || parts.length !== 4) throw new Error("Invalid encrypted secret");
  [, encodedIv, encodedTag, encodedValue] = parts;
  for (const candidate of candidates) {
    try {
      return decryptWithKey(encodedIv, encodedTag, encodedValue, candidate);
    } catch {
      // AES-GCM authentication failure means this candidate is not the key.
    }
  }
  throw new Error("Encrypted secret key is unavailable");
}

export function encryptedSecretNeedsRotation(value: string, currentKey: string): boolean {
  const [version, encryptedKeyId] = value.split(".");
  return version !== CURRENT_VERSION || encryptedKeyId !== keyId(currentKey);
}

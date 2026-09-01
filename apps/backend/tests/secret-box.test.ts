import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptedSecretNeedsRotation, encryptSecret } from "../src/modules/ai-router/secret-box.js";

function legacyEncrypt(value: string, secret: string): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function malformedV2(value: string, secret: string, ivLength: number, authTagLength?: number): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv, authTagLength ? { authTagLength } : undefined);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", createHash("sha256").update(`atendon-data-key:${secret}`).digest("base64url").slice(0, 16), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

describe("secret box", () => {
  it("writes versioned ciphertext without exposing plaintext", () => {
    const encrypted = encryptSecret("sk-or-secret", "a-runtime-secret");
    expect(encrypted).toMatch(/^v2\.[^.]+\.[^.]+\.[^.]+\.[^.]+$/);
    expect(encrypted).not.toContain("sk-or-secret");
    expect(decryptSecret(encrypted, "a-runtime-secret")).toBe("sk-or-secret");
  });

  it("reads ciphertext encrypted with the previous key during rotation", () => {
    const encrypted = encryptSecret("sk-or-secret", "old-data-key");
    expect(decryptSecret(encrypted, { current: "new-data-key", previous: ["old-data-key"] })).toBe("sk-or-secret");
    expect(encryptedSecretNeedsRotation(encrypted, "new-data-key")).toBe(true);
    const rotated = encryptSecret(decryptSecret(encrypted, { current: "new-data-key", previous: ["old-data-key"] }), "new-data-key");
    expect(encryptedSecretNeedsRotation(rotated, "new-data-key")).toBe(false);
    expect(decryptSecret(rotated, "new-data-key")).toBe("sk-or-secret");
  });

  it("reads legacy v1 ciphertext through the JWT fallback", () => {
    const encrypted = legacyEncrypt("sk-or-legacy", "legacy-jwt-secret");
    expect(decryptSecret(encrypted, { current: "new-data-key", legacy: ["legacy-jwt-secret"] })).toBe("sk-or-legacy");
    expect(encryptedSecretNeedsRotation(encrypted, "new-data-key")).toBe(true);
  });

  it("rejects ciphertext when no configured key can authenticate it", () => {
    const encrypted = encryptSecret("sk-or-secret", "key-one");
    expect(() => decryptSecret(encrypted, { current: "key-two", previous: ["key-three"] })).toThrow("Invalid encrypted secret");
  });

  it("rejects a valid ciphertext with a 4-byte authentication tag", () => {
    expect(() => decryptSecret(malformedV2("secret", "key", 12, 4), "key")).toThrow("Invalid encrypted secret");
  });

  it("rejects a valid ciphertext with an IV other than 12 bytes", () => {
    expect(() => decryptSecret(malformedV2("secret", "key", 8), "key")).toThrow("Invalid encrypted secret");
  });

  it("rejects ciphertext with an empty authentication tag", () => {
    const encrypted = encryptSecret("secret", "key").split(".");
    encrypted[3] = "";
    expect(() => decryptSecret(encrypted.join("."), "key")).toThrow("Invalid encrypted secret");
  });

  it.each([
    ["keyId", 1],
    ["IV", 2],
    ["tag", 3],
    ["ciphertext", 4],
  ])("rejects non-canonical base64url in v2 %s", (_segment, index) => {
    for (const suffix of ["=", "+", "/"]) {
      const encrypted = encryptSecret("secret", "key").split(".");
      encrypted[index] += suffix;
      expect(() => decryptSecret(encrypted.join("."), "key")).toThrow("Invalid encrypted secret");
    }
  });

  it.each([
    ["IV", 1],
    ["tag", 2],
    ["ciphertext", 3],
  ])("rejects non-canonical base64url in v1 %s", (_segment, index) => {
    for (const suffix of ["=", "+", "/"]) {
      const encrypted = legacyEncrypt("secret", "key").split(".");
      encrypted[index] += suffix;
      expect(() => decryptSecret(encrypted.join("."), "key")).toThrow("Invalid encrypted secret");
    }
  });
});

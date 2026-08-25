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
    expect(() => decryptSecret(encrypted, { current: "key-two", previous: ["key-three"] })).toThrow("unavailable");
  });
});

import { describe, expect, it, vi } from "vitest";
import { rotateGoogleMeetDataKeys, rotateOpenRouterDataKeys } from "../src/db/data-key-rotation.js";
import { decryptSecret, encryptSecret } from "../src/modules/ai-router/secret-box.js";

describe("OpenRouter data-key rotation", () => {
  it("rotates fallback ciphertext atomically and leaves the current key untouched", async () => {
    const oldCiphertext = encryptSecret("old-provider-key", "old-data-key");
    const currentCiphertext = encryptSecret("current-provider-key", "new-data-key");
    const updates: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM tenant_ai_settings")) {
        return { rows: [
          { tenant_id: "tenant-old", openrouter_api_key_encrypted: oldCiphertext },
          { tenant_id: "tenant-current", openrouter_api_key_encrypted: currentCiphertext }
        ] };
      }
      if (sql.includes("UPDATE tenant_ai_settings")) updates.push(values ?? []);
      return { rows: [] };
    });

    const result = await rotateOpenRouterDataKeys({ query }, { current: "new-data-key", previous: ["old-data-key"] });

    expect(result).toEqual({ rotated: 1, unchanged: 1 });
    expect(updates).toHaveLength(1);
    expect(decryptSecret(String(updates[0][2]), "new-data-key")).toBe("old-provider-key");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });

  it("rolls back every row when a legacy key is unavailable", async () => {
    const ciphertext = encryptSecret("provider-key", "unknown-key");
    const query = vi.fn(async (sql: string) => sql.includes("FROM tenant_ai_settings")
      ? { rows: [{ tenant_id: "tenant", openrouter_api_key_encrypted: ciphertext }] }
      : { rows: [] });

    await expect(rotateOpenRouterDataKeys({ query }, { current: "new-data-key" })).rejects.toThrow("unavailable");
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  });
});

describe("Google Meet data-key rotation", () => {
  it("rotates encrypted OAuth refresh tokens without exposing their plaintext", async () => {
    const oldCiphertext = encryptSecret("google-refresh-token", "old-data-key");
    const updates: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM scheduling_google_meet_settings")) {
        return { rows: [{ tenant_id: "tenant-meet", oauth_refresh_token_encrypted: oldCiphertext }] };
      }
      if (sql.includes("UPDATE scheduling_google_meet_settings")) updates.push(values ?? []);
      return { rows: [] };
    });

    const result = await rotateGoogleMeetDataKeys({ query }, { current: "new-data-key", previous: ["old-data-key"] });

    expect(result).toEqual({ rotated: 1, unchanged: 0 });
    expect(updates).toHaveLength(1);
    expect(decryptSecret(String(updates[0][2]), "new-data-key")).toBe("google-refresh-token");
  });
});

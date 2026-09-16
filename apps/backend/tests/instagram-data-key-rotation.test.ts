import { describe, expect, it, vi } from "vitest";
import { rotateInstagramDataKeys } from "../src/db/data-key-rotation.js";
import { decryptSecret, encryptSecret } from "../src/modules/ai-router/secret-box.js";

describe("Instagram data-key rotation", () => {
  it("rotates every encrypted Instagram token atomically", async () => {
    const oldCiphertext = encryptSecret("instagram-access-token", "old-data-key");
    const currentCiphertext = encryptSecret("already-current", "new-data-key");
    const updates: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM whatsapp_sessions")) {
        return { rows: [
          { id: "connection-old", tenant_id: "tenant-old", credentials_encrypted: oldCiphertext },
          { id: "connection-current", tenant_id: "tenant-current", credentials_encrypted: currentCiphertext }
        ] };
      }
      if (sql.includes("UPDATE whatsapp_sessions")) updates.push(values ?? []);
      return { rows: [] };
    });

    const result = await rotateInstagramDataKeys(
      { query },
      { current: "new-data-key", previous: ["old-data-key"] }
    );

    expect(result).toEqual({ rotated: 1, unchanged: 1 });
    expect(updates).toHaveLength(1);
    expect(decryptSecret(String(updates[0][3]), "new-data-key")).toBe("instagram-access-token");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });

  it("rolls back all Instagram token changes when a previous key is unavailable", async () => {
    const ciphertext = encryptSecret("instagram-access-token", "unknown-key");
    const query = vi.fn(async (sql: string) => sql.includes("FROM whatsapp_sessions")
      ? { rows: [{ id: "connection", tenant_id: "tenant", credentials_encrypted: ciphertext }] }
      : { rows: [] });

    await expect(rotateInstagramDataKeys({ query }, { current: "new-data-key" })).rejects.toThrow("unavailable");
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  });
});

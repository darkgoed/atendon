import { describe, expect, it, vi } from "vitest";
import { runFollowUpOnce } from "../src/modules/messages/follow-up-idempotency.js";
import { payloadFingerprint } from "../src/modules/messages/idempotency.js";

function fakeDb(rows: unknown[][] = []) {
  let i = 0;
  const queries: string[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: (rows[i++] ?? []) as any[], rowCount: 1 };
    })
  };
}

describe("follow-up persistent idempotency", () => {
  it("does not run the operation twice and returns the stored message", async () => {
    const hash = payloadFingerprint({ conversationId: "c" });
    const db = fakeDb([[{ id: "r1" }], [], [], [{ request_hash: hash, status: "sent", external_message_id: "ext-new" }], [{ id: "msg-new" }]]);
    const operation = vi.fn(async () => ({ externalId: "ext-new", messageId: "msg-new" }));
    const input = { tenantId: "t", conversationId: "c", idempotencyKey: "follow-up-1" };
    const first = await runFollowUpOnce(db, input, operation);
    const second = await runFollowUpOnce(db, input, operation);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(second.result.messageId).toBe("msg-new");
  });

  it("rejects a reused key when the stored payload hash differs", async () => {
    const db = fakeDb([[], [{ request_hash: "different", status: "sent", external_message_id: "ext" }]]);
    await expect(runFollowUpOnce(db, { tenantId: "t", conversationId: "c", idempotencyKey: "follow-up-2" }, vi.fn())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not advance lead stage when AI or sending fails", async () => {
    const db = fakeDb([[{ id: "r1" }]]);
    const stageUpdate = vi.fn();
    await expect(runFollowUpOnce(db, { tenantId: "t", conversationId: "c", idempotencyKey: "follow-up-3" }, async () => {
      throw new Error("AI/send failed");
    })).rejects.toThrow("AI/send failed");
    expect(stageUpdate).not.toHaveBeenCalled();
    expect(db.queries.some((sql) => sql.includes("scheduling_leads"))).toBe(false);
  });
});

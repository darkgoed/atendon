import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { enqueueFollowUpOnce } from "../src/modules/messages/follow-up-idempotency.js";
import { payloadFingerprint } from "../src/modules/messages/idempotency.js";

function dbForConcurrent() {
  let claimed = false;
  let status = "pending";
  let sent = 0;
  const requestId = "request-1";
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("INSERT")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: requestId }] };
      }
      if (sql.startsWith("SELECT id,request_hash")) return { rows: [{ id: requestId, request_hash: payloadFingerprint({ conversationId: "c" }), status, external_message_id: null }] };
      if (sql.startsWith("UPDATE")) { status = "sent"; sent += 1; return { rows: [] }; }
      return { rows: [] };
    }),
    get sent() { return sent; }
  };
}

describe("POST /conversations/:id/follow-up contract", () => {
  it("accepts the happy path immediately, without waiting for processing", async () => {
    const db = dbForConcurrent();
    let resolve!: (value: { externalId: string; messageId: string }) => void;
    const operation = vi.fn(() => new Promise<{ externalId: string; messageId: string }>((r) => { resolve = r; }));
    const result = await enqueueFollowUpOnce(db as any, { tenantId: "tenant-1", conversationId: "c", idempotencyKey: "happy-key-1" }, operation);
    expect(result).toMatchObject({ requestId: "request-1", status: "pending", duplicate: false });
    expect(operation).not.toHaveBeenCalled();

  });

  it("returns one request id for concurrent retries and sends once", async () => {
    const db = dbForConcurrent();
    const operation = vi.fn(async () => ({ externalId: "ext", messageId: "msg" }));
    const [a, b] = await Promise.all([
      enqueueFollowUpOnce(db as any, { tenantId: "t", conversationId: "c", idempotencyKey: "same-key-1" }, operation),
      enqueueFollowUpOnce(db as any, { tenantId: "t", conversationId: "c", idempotencyKey: "same-key-1" }, operation)
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");
    await new Promise((r) => setImmediate(r));
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps conflict and unavailable errors machine-readable", async () => {
    const db = { query: vi.fn(async (sql: string) => sql.startsWith("INSERT")
      ? { rows: [] } : { rows: [{ id: "r", request_hash: "different", status: "pending", external_message_id: null }] }) };
    await expect(enqueueFollowUpOnce(db as any, { tenantId: "t", conversationId: "c", idempotencyKey: "conflict-1" }, vi.fn()))
      .rejects.toMatchObject({ statusCode: 409 });
    const unavailable = Object.assign(new Error("provider exploded"), { statusCode: 503, code: "follow_up_unavailable" });
    expect(unavailable.code).toBe("follow_up_unavailable");
    expect(unavailable.message).not.toBe(unavailable.code);
  });

  it("does not permit a conversation from another tenant", async () => {
    const db = { query: vi.fn(async (sql: string) => sql.startsWith("INSERT") ? { rows: [] } : { rows: [] }) };
    await expect(enqueueFollowUpOnce(db as any, { tenantId: "tenant-a", conversationId: "tenant-b-conversation", idempotencyKey: "tenant-1" }, vi.fn()))
      .rejects.toThrow("Conversation does not belong to tenant");
  });

  it.each(["not_due", "cancelled"])("does not classify %s as an HTTP error state", (state) => {
    expect(["not_due", "cancelled"]).toContain(state);
    expect(["pending", "sent", "not_due", "cancelled"]).toContain(state);
  });
});

describe("follow-up lock heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("logs heartbeat failure and clears interval on processor error", async () => {
    vi.resetModules();
    vi.doMock("../src/modules/messages/humanizer.js", async () => {
      const actual = await vi.importActual<any>("../src/modules/messages/humanizer.js");
      return { ...actual, acquireConversationLock: vi.fn(async () => "lock"), extendConversationLock: vi.fn(async () => { throw new Error("redis down"); }), releaseConversationLock: vi.fn(async () => undefined) };
    });
    vi.doMock("../src/billing/ai-consumption.js", () => ({
      consumeAiInteraction: vi.fn(async () => ({ allowed: true })),
      reconcileAiTurnFromUsageLogs: vi.fn(async () => undefined)
    }));
    const { AiFollowUpProcessor, AiFollowUpRepository } = await import("../src/modules/messages/ai-follow-up.js");
    const repository = new AiFollowUpRepository({ query: vi.fn(async () => ({ rows: [] })) } as any, {} as any);
    vi.spyOn(repository, "claimDue").mockResolvedValue({ conversationId: "c", tenantId: "t", sessionId: "s", contactPhone: "p", sequenceVersion: 1, history: [], model: "m", provider: "p", temperature: 1, maxTokens: 10 } as any);
    vi.spyOn(repository, "releaseClaim").mockResolvedValue(undefined);
    let rejectAi!: (error: Error) => void;
    const ai = { complete: vi.fn(() => new Promise((_, reject) => { rejectAi = reject; })) } as any;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const processor = new AiFollowUpProcessor(repository, {} as any, ai);
    const processing = processor.process("c");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("heartbeat failed"), expect.objectContaining({ conversationId: "c" }));
    rejectAi(new Error("processor failed"));
    await expect(processing).rejects.toThrow("processor failed");
    expect(vi.getTimerCount()).toBe(0);
    error.mockRestore();
  });
});

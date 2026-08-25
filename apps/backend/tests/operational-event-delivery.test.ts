import { describe, expect, it, vi } from "vitest";
import {
  reconcileAiFollowUps,
  reconcileEvaluationEvents,
  reconcileHandoffNotifications,
  reconciliationLogLevel
} from "../src/modules/operations/event-reconciliation.js";
import {
  EvaluatorCircuitBreaker,
  EvaluatorCircuitOpenError,
  type CircuitBreakerRedis
} from "../src/modules/agent-improvement/evaluator-circuit-breaker.js";
import { EvaluationEventProcessor } from "../src/modules/agent-improvement/evaluation-event-processor.js";
import { evaluationEventErrorClass } from "../src/modules/agent-improvement/evaluation-events.js";

class MemoryRedis implements CircuitBreakerRedis {
  readonly values = new Map<string, string>();

  async get(key: string) { return this.values.get(key) ?? null; }
  async incr(key: string) {
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    return next;
  }
  async pexpire() { return 1; }
  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    return keys.reduce((count, key) => count + Number(this.values.delete(key)), 0);
  }
}

describe("operational event delivery", () => {
  it("keyset-paginates recovery and reports enqueue, deduplication and errors", async () => {
    const handoffRepository = {
      findPendingHandoffNotificationPage: vi.fn()
        .mockResolvedValueOnce({ ids: ["h1", "h2"], nextCursor: "h2", oldestAgeMs: 9_000 })
        .mockResolvedValueOnce({ ids: ["h3"], nextCursor: null, oldestAgeMs: 1_000 })
    };
    const handoff = await reconcileHandoffNotifications(
      handoffRepository,
      vi.fn()
        .mockResolvedValueOnce("enqueued")
        .mockResolvedValueOnce("deduplicated")
        .mockRejectedValueOnce(new Error("redis unavailable")),
      2
    );
    expect(handoff).toEqual({
      examined: 3,
      enqueued: 1,
      deduplicated: 1,
      errors: 1,
      oldestAgeMs: 9_000
    });
    expect(handoffRepository.findPendingHandoffNotificationPage)
      .toHaveBeenNthCalledWith(2, 2, "h2");

    const dueAt = new Date();
    const followUpRepository = {
      findDuePage: vi.fn().mockResolvedValue({
        events: [{ conversationId: "c1", sequenceVersion: 4, dueAt }],
        nextCursor: null,
        oldestAgeMs: 500
      })
    };
    const enqueueFollowUp = vi.fn().mockResolvedValue("enqueued");
    await expect(reconcileAiFollowUps(followUpRepository, enqueueFollowUp)).resolves.toMatchObject({
      examined: 1,
      enqueued: 1
    });
    expect(enqueueFollowUp).toHaveBeenCalledWith("c1", { sequenceVersion: 4, dueAt });

    const evaluationRepository = {
      findPendingPage: vi.fn().mockResolvedValue({
        events: [{ id: "e1" }],
        nextCursor: null,
        oldestAgeMs: 700
      }),
      markEnqueueAttempt: vi.fn()
    };
    await expect(reconcileEvaluationEvents(
      evaluationRepository as never,
      vi.fn().mockResolvedValue("deduplicated")
    )).resolves.toMatchObject({ examined: 1, deduplicated: 1 });
    expect(evaluationRepository.markEnqueueAttempt).toHaveBeenCalledWith("e1");
  });

  it("persists evaluator circuit state across breaker instances and recovers on success", async () => {
    const redis = new MemoryRedis();
    const firstProcess = new EvaluatorCircuitBreaker(async () => redis);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await firstProcess.recordFailure("tenant-1");
    }

    const restartedProcess = new EvaluatorCircuitBreaker(async () => redis);
    await expect(restartedProcess.assertAvailable("tenant-1"))
      .rejects.toBeInstanceOf(EvaluatorCircuitOpenError);
    await restartedProcess.recordSuccess("tenant-1");
    await expect(restartedProcess.assertAvailable("tenant-1")).resolves.toBeUndefined();
  });

  it("completes an evaluation event only after the idempotent effect and processes it at most once", async () => {
    const event = {
      id: "event-1",
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      agentConfigVersionId: "version-1",
      trigger: "handoff" as const,
      createdAt: new Date()
    };
    let pending = true;
    const events = {
      getPending: vi.fn(async () => pending ? event : null),
      markCompleted: vi.fn(async () => {
        pending = false;
        return true;
      })
    };
    const evaluator = { process: vi.fn().mockResolvedValue("created") };
    const breaker = {
      assertAvailable: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn()
    };
    const processor = new EvaluationEventProcessor(
      events as never,
      evaluator as never,
      breaker as never,
      vi.fn()
    );

    await expect(processor.process({ eventId: event.id })).resolves.toBe("created");
    await expect(processor.process({ eventId: event.id })).resolves.toBe("already_completed");
    expect(evaluator.process).toHaveBeenCalledTimes(1);
    expect(events.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("keeps evaluation events pending while the global evaluator kill switch is off", async () => {
    const events = {
      getPending: vi.fn(),
      markCompleted: vi.fn()
    };
    const evaluator = { process: vi.fn() };
    const breaker = {
      assertAvailable: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn()
    };
    const processor = new EvaluationEventProcessor(
      events as never,
      evaluator as never,
      breaker as never,
      vi.fn(),
      false
    );

    await expect(processor.process({ eventId: "event-disabled" })).resolves.toBe("disabled");
    expect(events.getPending).not.toHaveBeenCalled();
    expect(events.markCompleted).not.toHaveBeenCalled();
    expect(evaluator.process).not.toHaveBeenCalled();
    expect(breaker.assertAvailable).not.toHaveBeenCalled();
  });

  it("promotes reconciliation logs only for activity or errors", () => {
    expect(reconciliationLogLevel({ examined: 0, enqueued: 0, deduplicated: 0, errors: 0, oldestAgeMs: 0 }))
      .toBe("debug");
    expect(reconciliationLogLevel({ examined: 1, enqueued: 0, deduplicated: 1, errors: 0, oldestAgeMs: 25 }))
      .toBe("info");
    expect(reconciliationLogLevel({ examined: 1, enqueued: 0, deduplicated: 0, errors: 1, oldestAgeMs: 25 }))
      .toBe("warn");
  });

  it("leaves the event pending when the evaluator effect fails", async () => {
    const event = {
      id: "event-2",
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      agentConfigVersionId: "version-1",
      trigger: "tool_error" as const,
      createdAt: new Date()
    };
    const events = {
      getPending: vi.fn().mockResolvedValue(event),
      markCompleted: vi.fn()
    };
    const processor = new EvaluationEventProcessor(
      events as never,
      { process: vi.fn().mockRejectedValue(new Error("provider failed")) } as never,
      {
        assertAvailable: vi.fn(),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn().mockResolvedValue({ failures: 1, opened: false })
      } as never,
      vi.fn()
    );
    await expect(processor.process({ eventId: event.id })).rejects.toThrow("provider failed");
    expect(events.markCompleted).not.toHaveBeenCalled();
  });

  it("stores only an allowlisted enqueue error class", () => {
    expect(evaluationEventErrorClass(new Error("redis connect failed for user@example.com token=secretvalue")))
      .toBe("connection");
    expect(evaluationEventErrorClass(new Error("tenant 123 custom failure"))).toBe("unknown");
  });
});

import { describe, expect, it, vi } from "vitest";
import { adjustDelayedInboundJobList, createInboundJobData, ensureInboundAiTurn, INBOUND_JOB_ATTEMPTS } from "../src/queue/message-queue.js";

function delayedJob(tenantId = "tenant-1") {
  return {
    data: {
      tenantId,
      sessionId: "session-1",
      externalId: "wamid-1",
      contactPhone: "5511999999999",
      text: "Oi"
    },
    getState: vi.fn().mockResolvedValue("delayed"),
    promote: vi.fn().mockResolvedValue(undefined),
    changeDelay: vi.fn().mockResolvedValue(undefined)
  };
}

describe("delayed inbound queue adjustment", () => {
  const hours = { timezone: "UTC", start: "07:00", end: "23:00" };

  it("promotes a workspace job once when expanded hours now include it", async () => {
    const job = delayedJob();
    await expect(adjustDelayedInboundJobList([job], "tenant-1", hours, new Date("2030-01-07T22:00:00.000Z")))
      .resolves.toEqual({ promoted: 1, rescheduled: 0, skipped: 0 });
    expect(job.promote).toHaveBeenCalledTimes(1);
    expect(job.changeDelay).not.toHaveBeenCalled();
  });

  it("keeps the end of business hours exclusive and reschedules without duplicating", async () => {
    const job = delayedJob();
    await expect(adjustDelayedInboundJobList([job], "tenant-1", hours, new Date("2030-01-07T23:00:00.000Z")))
      .resolves.toEqual({ promoted: 0, rescheduled: 1, skipped: 0 });
    expect(job.promote).not.toHaveBeenCalled();
    expect(job.changeDelay).toHaveBeenCalledTimes(1);
    expect(job.changeDelay).toHaveBeenCalledWith(8 * 60 * 60 * 1000);
  });

  it("counts a concurrent state change as skipped", async () => {
    const job = delayedJob();
    job.getState.mockResolvedValue("active");
    await expect(adjustDelayedInboundJobList([job], "tenant-1", hours, new Date("2030-01-07T22:00:00.000Z")))
      .resolves.toEqual({ promoted: 0, rescheduled: 0, skipped: 1 });
  });
});

describe("logical AI turn identity", () => {
  it("keeps busy messages retrying across a long in-flight AI turn", () => {
    expect(INBOUND_JOB_ATTEMPTS).toBeGreaterThanOrEqual(8);
  });

  it("preserves the id on automatic retry and creates a new one on manual re-enqueue", () => {
    const message = delayedJob().data;
    const first = createInboundJobData(message);
    const automaticRetry = ensureInboundAiTurn(first);
    const manualRetry = createInboundJobData(message);
    expect(automaticRetry.aiTurnId).toBe(first.aiTurnId);
    expect(manualRetry.aiTurnId).not.toBe(first.aiTurnId);
    expect(first.aiTurnId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

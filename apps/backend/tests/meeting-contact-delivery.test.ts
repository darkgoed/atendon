import { describe, expect, it, vi } from "vitest";
import {
  decideMeetingContactDeliveryClaim,
  MeetingContactDeliveryProcessor,
  type ClaimedMeetingContactDelivery,
  type MeetingContactDeliveryRepository
} from "../src/modules/scheduling/meeting-contact-delivery.js";

const delivery: ClaimedMeetingContactDelivery = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  appointmentId: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8444-444444444444",
  sessionId: "55555555-5555-4555-8555-555555555555",
  destination: "5511999999999",
  messageText: "Link: https://meet.google.com/abc-defg-hij"
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    claim: vi.fn().mockResolvedValue(delivery),
    markAttemptStarted: vi.fn().mockResolvedValue(true),
    markSent: vi.fn().mockResolvedValue(undefined),
    markUncertain: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("MeetingContactDeliveryProcessor", () => {
  it("reclaims a pre-send crash but terminates a post-attempt crash as uncertain", () => {
    const expired = new Date("2030-01-01T00:00:00.000Z");
    const base = {
      status: "processing" as const,
      processingStartedAt: expired,
      available: true,
      turnInProgress: false,
      leaseMs: 1_000,
      nowMs: expired.getTime() + 1_001
    };
    expect(decideMeetingContactDeliveryClaim({
      ...base,
      attemptedAt: null
    })).toBe("claim");
    expect(decideMeetingContactDeliveryClaim({
      ...base,
      attemptedAt: expired
    })).toBe("uncertain");
  });

  it("waits for the normal AI turn before claiming the durable fallback", () => {
    expect(decideMeetingContactDeliveryClaim({
      status: "pending",
      attemptedAt: null,
      processingStartedAt: null,
      available: true,
      turnInProgress: true,
      leaseMs: 60_000
    })).toBe("skip");
    expect(decideMeetingContactDeliveryClaim({
      status: "pending",
      attemptedAt: null,
      processingStartedAt: null,
      available: true,
      turnInProgress: false,
      leaseMs: 60_000
    })).toBe("claim");
  });

  it("records the durable attempt before one external send and finalizes it", async () => {
    const calls: string[] = [];
    const repo = repository({
      markAttemptStarted: vi.fn(async () => {
        calls.push("attempted");
        return true;
      }),
      markSent: vi.fn(async () => {
        calls.push("sent");
      })
    });
    const sendText = vi.fn(async () => {
      calls.push("http");
      return { externalId: "provider-message-1" };
    });
    const processor = new MeetingContactDeliveryProcessor(
      repo as unknown as MeetingContactDeliveryRepository,
      { sendText }
    );

    await expect(processor.process(delivery.id)).resolves.toBe("sent");
    expect(calls).toEqual(["attempted", "http", "sent"]);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(repo.markUncertain).not.toHaveBeenCalled();
  });

  it("does not send again when a duplicate job cannot claim the terminal row", async () => {
    const repo = repository({
      claim: vi.fn()
        .mockResolvedValueOnce(delivery)
        .mockResolvedValueOnce(null)
    });
    const sendText = vi.fn().mockResolvedValue({ externalId: "provider-message-1" });
    const processor = new MeetingContactDeliveryProcessor(
      repo as unknown as MeetingContactDeliveryRepository,
      { sendText }
    );

    await expect(processor.process(delivery.id)).resolves.toBe("sent");
    await expect(processor.process(delivery.id)).resolves.toBe("skipped");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("classifies an ambiguous provider failure as uncertain and never asks BullMQ to retry", async () => {
    const repo = repository();
    const sendText = vi.fn().mockRejectedValue(new Error("timeout after write"));
    const processor = new MeetingContactDeliveryProcessor(
      repo as unknown as MeetingContactDeliveryRepository,
      { sendText }
    );

    await expect(processor.process(delivery.id)).resolves.toBe("uncertain");
    expect(repo.markUncertain).toHaveBeenCalledWith(delivery, expect.any(Error));
    expect(repo.markSent).not.toHaveBeenCalled();
  });
});

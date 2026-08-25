import { describe, expect, it, vi } from "vitest";
import {
  APPOINTMENT_STATUS_REACTIONS,
  AppointmentStatusReactionProcessor,
  type AppointmentStatusReactionRepository,
  type PendingAppointmentStatusReaction
} from "../src/modules/scheduling/status-reaction.js";

const reaction: PendingAppointmentStatusReaction = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  destination: "120363000000000000@g.us",
  receipt: {
    id: "provider-message-1",
    remoteJid: "120363000000000000@g.us",
    fromMe: true
  },
  emoji: "✅"
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    getPending: vi.fn().mockResolvedValue(reaction),
    markSent: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("appointment status WhatsApp reactions", () => {
  it("maps every final appointment status to an explicit reaction", () => {
    expect(APPOINTMENT_STATUS_REACTIONS).toEqual({
      concluido: "✅",
      cancelado: "❌",
      no_show: "⚠️"
    });
  });

  it("reacts to the persisted scheduling notification and marks it sent", async () => {
    const repo = repository();
    const sendReaction = vi.fn().mockResolvedValue(undefined);
    const processor = new AppointmentStatusReactionProcessor(
      repo as unknown as AppointmentStatusReactionRepository,
      { sendReaction }
    );

    await expect(processor.process(reaction.id)).resolves.toBe("sent");
    expect(sendReaction).toHaveBeenCalledWith(
      reaction.sessionId,
      reaction.destination,
      reaction.receipt,
      "✅"
    );
    expect(repo.markSent).toHaveBeenCalledWith(reaction.id);
  });

  it("records provider failures before allowing the queue to retry", async () => {
    const repo = repository();
    const failure = new Error("provider unavailable");
    const processor = new AppointmentStatusReactionProcessor(
      repo as unknown as AppointmentStatusReactionRepository,
      { sendReaction: vi.fn().mockRejectedValue(failure) }
    );

    await expect(processor.process(reaction.id)).rejects.toThrow("provider unavailable");
    expect(repo.recordFailure).toHaveBeenCalledWith(reaction.id, failure);
    expect(repo.markSent).not.toHaveBeenCalled();
  });
});

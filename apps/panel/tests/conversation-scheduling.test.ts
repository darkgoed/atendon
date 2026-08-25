import { describe, expect, it } from "vitest";
import {
  availableConversationSlots,
  futureConversationSlots,
  isoDay,
  shiftIsoDay
} from "../lib/conversation-scheduling";

describe("conversation scheduling helpers", () => {
  it("keeps only future slots with vacancies in chronological order", () => {
    const slots = availableConversationSlots([
      { start: "2030-01-08T11:00:00.000Z", end: "2030-01-08T12:00:00.000Z", vagas: 1, capacidade: 1 },
      { start: "2030-01-08T09:00:00.000Z", end: "2030-01-08T10:00:00.000Z", vagas: 1, capacidade: 1 },
      { start: "2030-01-08T10:00:00.000Z", end: "2030-01-08T11:00:00.000Z", vagas: 0, capacidade: 1 },
      { start: "2029-01-08T09:00:00.000Z", end: "2029-01-08T10:00:00.000Z", vagas: 1, capacidade: 1 }
    ], new Date("2030-01-08T08:00:00.000Z"));

    expect(slots.map((slot) => slot.start)).toEqual([
      "2030-01-08T09:00:00.000Z",
      "2030-01-08T11:00:00.000Z"
    ]);
  });

  it("keeps occupied future slots available as closer-selection anchors", () => {
    const slots = futureConversationSlots([
      { start: "2030-01-08T10:00:00.000Z", end: "2030-01-08T11:00:00.000Z", vagas: 0, capacidade: 1 },
      { start: "2030-01-08T09:00:00.000Z", end: "2030-01-08T10:00:00.000Z", vagas: 0, capacidade: 1 }
    ], new Date("2030-01-08T08:00:00.000Z"));

    expect(slots.map((slot) => slot.start)).toEqual([
      "2030-01-08T09:00:00.000Z",
      "2030-01-08T10:00:00.000Z"
    ]);
  });

  it("moves ISO calendar days without local timezone drift", () => {
    expect(isoDay(new Date("2030-01-31T23:59:59.000Z"))).toBe("2030-01-31");
    expect(shiftIsoDay("2030-01-31", 1)).toBe("2030-02-01");
    expect(shiftIsoDay("2030-03-01", -1)).toBe("2030-02-28");
  });
});

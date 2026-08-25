import { describe, expect, it } from "vitest";
import { displayFollowUpInterval, followUpIntervalBounds, followUpIntervalToMinutes, formatFollowUpDelay, isValidFollowUpDelays, normalizeFollowUpDelivery } from "../lib/ai-follow-ups";

describe("AI follow-up interval helpers", () => {
  it("converts the selected unit to whole minutes", () => {
    expect(followUpIntervalToMinutes(45, "minutes")).toBe(45);
    expect(followUpIntervalToMinutes(6, "hours")).toBe(360);
    expect(followUpIntervalToMinutes(3, "days")).toBe(4320);
  });

  it("chooses the most readable exact unit returned by the API", () => {
    expect(displayFollowUpInterval(90)).toEqual({ value: 90, unit: "minutes" });
    expect(displayFollowUpInterval(360)).toEqual({ value: 6, unit: "hours" });
    expect(displayFollowUpInterval(2880)).toEqual({ value: 2, unit: "days" });
  });

  it("keeps every unit inside the backend thirty-day limit", () => {
    expect(followUpIntervalBounds("minutes")).toEqual({ min: 1, max: 43_200 });
    expect(followUpIntervalBounds("hours")).toEqual({ min: 1, max: 720 });
    expect(followUpIntervalBounds("days")).toEqual({ min: 1, max: 30 });
  });

  it("validates and renders the complete cumulative sequence", () => {
    expect(isValidFollowUpDelays([120, 1440, 4320])).toBe(true);
    expect(isValidFollowUpDelays([120, 120, 4320])).toBe(false);
    expect(isValidFollowUpDelays([1440, 120])).toBe(false);
    expect(formatFollowUpDelay(120)).toBe("2 hora(s)");
    expect(formatFollowUpDelay(4320)).toBe("3 dia(s)");
  });

  it("keeps delivery choices aligned with cadence attempts", () => {
    const image = { type: "image" as const, assetId: "case-1" };
    expect(normalizeFollowUpDelivery([120, 1440, 4320], [{ type: "text" }, image])).toEqual([
      { type: "text" },
      image,
      { type: "text" }
    ]);
    expect(normalizeFollowUpDelivery([120], [{ type: "text" }, image])).toEqual([{ type: "text" }]);
  });
});

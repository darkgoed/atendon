import { describe, expect, it } from "vitest";
import { resolvePeriod } from "../src/modules/dashboard/service.js";
import { capReportingLimit, reportingScopeParams, resolveReportingRange } from "../src/modules/reporting.js";

describe("reporting policy golden values", () => {
  const now = new Date("2024-05-15T12:00:00.000Z");
  it.each([
    ["today", "2024-05-15", "2024-05-16"],
    ["week", "2024-05-13", "2024-05-20"],
    ["month", "2024-05-01", "2024-06-01"],
    ["custom", "2024-05-02", "2024-05-05"]
  ])("normalizes %s identically in dashboard and shared policy", (period, startKey, endKey) => {
    const input = period === "custom" ? { period: "custom" as const, start: "2024-05-02", end: "2024-05-04", now } : { period: period as "today" | "week" | "month", now };
    expect(resolvePeriod("UTC", input).startKey).toBe(startKey);
    expect(resolvePeriod("UTC", input).endKey).toBe(endKey);
    expect(resolvePeriod("UTC", input)).toEqual(resolveReportingRange("UTC", input));
  });
  it("preserves DST boundary and half-open UTC instants", () => {
    const range = resolveReportingRange("America/New_York", { period: "today", now: new Date("2024-03-10T12:00:00.000Z") });
    expect(range.start.toISOString()).toBe("2024-03-10T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2024-03-11T04:00:00.000Z");
  });
  it("caps pagination and preserves mine/workspace scope", () => {
    expect(capReportingLimit(undefined)).toBe(20);
    expect(capReportingLimit(1000)).toBe(100);
    expect(reportingScopeParams({ type: "mine", memberId: "m" }, "t")).toEqual(["t", false, "m"]);
    expect(reportingScopeParams({ type: "workspace" }, "t")).toEqual(["t", true, null]);
  });
});

import { describe, expect, it } from "vitest";
import { trendDelta, type CommercialDashboardSeries } from "../lib/commercial-dashboard";

function series(scheduled: number[]): CommercialDashboardSeries {
  return scheduled.map((value, index) => ({
    day: `2026-08-${String(index + 1).padStart(2, "0")}`,
    scheduled: value,
    completed: 0,
    no_show: 0,
    cancelled: 0
  }));
}

describe("commercial dashboard charts", () => {
  it("preserves the half-period trend calculation", () => {
    expect(trendDelta(series([2, 2, 3, 5]))).toBe(100);
    expect(trendDelta(series([5, 5, 2, 3]))).toBe(-50);
  });

  it("omits a misleading trend without enough baseline data", () => {
    expect(trendDelta(series([]))).toBeNull();
    expect(trendDelta(series([3]))).toBeNull();
    expect(trendDelta(series([0, 0, 2, 4]))).toBeNull();
  });
});

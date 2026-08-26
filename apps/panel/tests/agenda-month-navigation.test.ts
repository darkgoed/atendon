import { describe, expect, it } from "vitest";
import { addCalendarMonths, dayKey } from "../app/agenda/agenda-utils";

describe("agenda monthly navigation", () => {
  it.each([
    ["2024-01-28", "2024-02-28"], ["2024-01-29", "2024-02-29"],
    ["2024-01-30", "2024-02-29"], ["2024-01-31", "2024-02-29"],
    ["2023-01-31", "2023-02-28"], ["2024-12-31", "2025-01-31"],
    ["2025-01-31", "2025-02-28"], ["2025-03-31", "2025-04-30"]
  ])("moves %s to %s using calendar months", (from, expected) => {
    expect(dayKey(addCalendarMonths(new Date(`${from}T00:00:00.000Z`), 1))).toBe(expected);
  });
  it("moves backwards across a year", () => {
    expect(dayKey(addCalendarMonths(new Date("2025-01-31T00:00:00.000Z"), -1))).toBe("2024-12-31");
  });
});

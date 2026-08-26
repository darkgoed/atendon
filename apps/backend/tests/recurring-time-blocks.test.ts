import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://unit-test:unit-test@localhost:5432/unit-test";
process.env.PANEL_SEED_PASSWORD ??= "unit-test-password";

const {
  recurringOccurrences,
  recurringTimeBlockBody,
  recurringTimeBlockPatch
} = await import("../src/modules/scheduling/service.js");

const base: {
  start_local_time: string;
  end_local_time: string;
  weekdays: number[];
  starts_on: string;
  ends_on?: string | null;
  timezone: string;
  reason: string;
  active: boolean;
} = {
  start_local_time: "12:00",
  end_local_time: "13:00",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  starts_on: "2026-01-01",
  ends_on: null,
  timezone: "UTC",
  reason: "Almoço",
  active: true
};

const row = (overrides: Partial<typeof base> = {}) => ({
  ...base,
  id: "rule-1",
  tenant_id: "tenant-1",
  member_id: "member-1",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
  ...overrides
});

const weekStart = new Date("2026-01-05T00:00:00Z");
const weekEnd = new Date("2026-01-12T00:00:00Z");

describe("recurring time block validation", () => {
  it.each([
    ["empty reason", ""],
    ["whitespace-only reason", "   "],
    ["reason over 500 characters", "x".repeat(501)]
  ])("rejects %s", (_label, reason) => {
    expect(recurringTimeBlockBody.safeParse({ ...base, reason }).success).toBe(false);
    expect(recurringTimeBlockPatch.safeParse({ reason }).success).toBe(false);
  });

  it("accepts a valid reason", () => {
    expect(recurringTimeBlockBody.safeParse(base).success).toBe(true);
    expect(recurringTimeBlockPatch.safeParse({ reason: "Pausa" }).success).toBe(true);
  });

  it.each([
    ["empty", []],
    ["zero", [0]],
    ["eight", [8]]
  ])("rejects invalid weekdays: %s", (_label, weekdays) => {
    expect(recurringTimeBlockBody.safeParse({ ...base, weekdays }).success).toBe(false);
    expect(recurringTimeBlockPatch.safeParse({ weekdays }).success).toBe(false);
  });

  it("rejects duplicate weekdays in both schemas", () => {
    expect(recurringTimeBlockBody.safeParse({ ...base, weekdays: [1, 1] }).success).toBe(false);
    expect(recurringTimeBlockPatch.safeParse({ weekdays: [1, 1] }).success).toBe(false);
  });

  it("accepts non-empty weekdays in the 1..7 range", () => {
    expect(recurringTimeBlockBody.safeParse({ ...base, weekdays: [1, 2, 3] }).success).toBe(true);
    expect(recurringTimeBlockPatch.safeParse({ weekdays: [1, 2, 3] }).success).toBe(true);
  });

  it("rejects a non-positive time range", () => {
    expect(recurringTimeBlockBody.safeParse({ ...base, start_local_time: "13:00", end_local_time: "13:00" }).success).toBe(false);
    expect(recurringTimeBlockBody.safeParse({ ...base, start_local_time: "14:00", end_local_time: "13:00" }).success).toBe(false);
    expect(recurringTimeBlockPatch.safeParse({ start_local_time: "13:00", end_local_time: "13:00" }).success).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    expect(recurringTimeBlockBody.safeParse({ ...base, starts_on: "2026-01-10", ends_on: "2026-01-09" }).success).toBe(false);
  });

  it("rejects unknown payload fields because schemas are strict", () => {
    expect(recurringTimeBlockBody.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(recurringTimeBlockPatch.safeParse({ reason: "Pausa", unexpected: true }).success).toBe(false);
  });
});

describe("recurring time block occurrence expansion", () => {
  it("expands a daily lunch rule to seven occurrences in a week", () => {
    const occurrences = recurringOccurrences(row(), weekStart, weekEnd);
    expect(occurrences).toHaveLength(7);
    expect(occurrences.map((item) => item.start)).toEqual([
      "2026-01-05T12:00:00.000Z", "2026-01-06T12:00:00.000Z", "2026-01-07T12:00:00.000Z",
      "2026-01-08T12:00:00.000Z", "2026-01-09T12:00:00.000Z", "2026-01-10T12:00:00.000Z",
      "2026-01-11T12:00:00.000Z"
    ]);
  });

  it("expands only the configured weekdays", () => {
    const occurrences = recurringOccurrences(row({ weekdays: [1, 3, 5] }), weekStart, weekEnd);
    expect(occurrences.map((item) => item.start)).toEqual([
      "2026-01-05T12:00:00.000Z", "2026-01-07T12:00:00.000Z", "2026-01-09T12:00:00.000Z"
    ]);
  });

  it("does not generate occurrences before starts_on or after ends_on", () => {
    const occurrences = recurringOccurrences(row({ starts_on: "2026-01-07", ends_on: "2026-01-09" }), weekStart, weekEnd);
    expect(occurrences.map((item) => item.start)).toEqual([
      "2026-01-07T12:00:00.000Z", "2026-01-08T12:00:00.000Z", "2026-01-09T12:00:00.000Z"
    ]);
  });

  it("does not expand an inactive rule", () => {
    expect(recurringOccurrences(row({ active: false }), weekStart, weekEnd)).toHaveLength(0);
  });

  it("returns no occurrences when the queried range does not intersect the rule", () => {
    expect(recurringOccurrences(row({ starts_on: "2026-02-01" }), weekStart, weekEnd)).toHaveLength(0);
  });
});

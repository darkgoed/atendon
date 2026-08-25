import { describe, expect, it } from "vitest";
import {
  defaultManualAppointmentStart,
  instantFromLocalMinute,
  localMinute
} from "../lib/timezone";

describe("panel workspace timezone conversion", () => {
  it("round-trips valid local minutes", () => {
    const instant = instantFromLocalMinute("2030-01-07T09:15", "America/Sao_Paulo");

    expect(instant).toBe("2030-01-07T12:15:00.000Z");
    expect(localMinute(instant, "America/Sao_Paulo")).toBe("2030-01-07T09:15");
  });

  it("rejects a local minute skipped by daylight-saving time", () => {
    expect(instantFromLocalMinute("2030-03-10T02:30", "America/New_York")).toBe("");
  });

  it("rejects normalized calendar overflow instead of changing the selected date", () => {
    expect(instantFromLocalMinute("2030-02-31T09:00", "UTC")).toBe("");
  });

  it("does not default a manual appointment to a past day when browsing history", () => {
    const now = new Date("2030-01-07T13:16:30.000Z");

    expect(defaultManualAppointmentStart("2030-01-01", "America/Sao_Paulo", now))
      .toBe("2030-01-07T13:30:00.000Z");
  });

  it("keeps a future anchor day and defaults it to 09:00 in the workspace", () => {
    const now = new Date("2030-01-07T13:16:30.000Z");

    expect(defaultManualAppointmentStart("2030-01-09", "America/Sao_Paulo", now))
      .toBe("2030-01-09T12:00:00.000Z");
  });
});

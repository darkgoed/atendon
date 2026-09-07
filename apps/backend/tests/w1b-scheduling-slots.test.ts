import { describe, expect, it } from "vitest";
import {
  assertFutureAppointmentStart,
  validateManualAppointmentInterval,
  validateSlot,
  workspaceLocalDateTime,
  type UnitRow
} from "../src/modules/scheduling/service.js";

describe("scheduling slot characterization", () => {
  const unit = {
    id: "unit",
    name: "Agenda",
    opening_time: "08:30:00",
    closing_time: "18:30:00",
    operating_days: [1, 2, 3, 4, 5],
    slot_duration_min: 60,
    simultaneous_capacity: 1,
    timezone: "America/Sao_Paulo"
  } satisfies UnitRow;

  it("preserves timezone conversion and DST-safe local boundaries", () => {
    expect(workspaceLocalDateTime("2026-07-23", "08:30", unit.timezone).toISOString())
      .toBe("2026-07-23T11:30:00.000Z");
    expect(() => workspaceLocalDateTime("2026-03-08", "02:30", "America/New_York"))
      .toThrow();
  });

  it("accepts an exact opening slot and rejects a slot whose end crosses closing", () => {
    const opening = workspaceLocalDateTime("2026-07-23", "08:30", unit.timezone);
    expect(validateSlot(unit, opening).toISOString()).toBe("2026-07-23T12:30:00.000Z");
    const late = workspaceLocalDateTime("2026-07-23", "17:31", unit.timezone);
    expect(() => validateSlot(unit, late)).toThrow("fora do funcionamento");
  });

  it("preserves manual interval limits independently of slot duration", () => {
    const start = new Date("2026-07-23T12:00:00.000Z");
    expect(validateManualAppointmentInterval(unit, start, "2026-07-23T13:00:00.000Z").toISOString())
      .toBe("2026-07-23T13:00:00.000Z");
    expect(() => validateManualAppointmentInterval(unit, start, "2026-07-24T12:00:01.000Z"))
      .toThrow("24 horas");
  });

  it("preserves strict future and minimum lead-time boundaries", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    expect(() => assertFutureAppointmentStart(now, now)).toThrow("futuro");
    expect(() => assertFutureAppointmentStart(new Date("2026-07-23T12:30:00.000Z"), now, 30))
      .toThrow("pelo menos 30 minutos");
  });
});

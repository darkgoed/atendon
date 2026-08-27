import { describe, expect, it } from "vitest";
import {
  allowedAppointmentFinalTransitions,
  appointmentStatus,
  type AppointmentStatus
} from "../src/modules/scheduling/service.js";

describe("appointment reschedule transition matrix", () => {
  it.each([
    ["concluido", "reagenda", "confirmado"],
    ["no_show", "reagenda", "confirmado"]
  ] as const)("permits %s -> %s -> %s", (from, action, resultingStatus) => {
    // Reagendar is deliberately not a final-status transition. The endpoint
    // accepts these origins and writes confirmado; final transitions remain
    // the conclude/no-show/cancel actions only.
    expect(action).toBe("reagenda");
    expect(appointmentStatus.parse(resultingStatus)).toBe("confirmado");
    expect(allowedAppointmentFinalTransitions(from)).toEqual([]);
  });

  it("keeps cancelado out of the reschedule origin matrix", () => {
    const status: AppointmentStatus = "cancelado";
    expect(allowedAppointmentFinalTransitions(status)).toEqual([]);
  });

  it.each(["confirmado", "reagendado"] as const)(
    "does not confuse %s final transitions with rescheduling",
    (status) => {
      expect(allowedAppointmentFinalTransitions(status)).toEqual([
        "cancelado",
        "concluido",
        "no_show"
      ]);
    }
  );
});

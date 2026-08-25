import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, nextBusinessHoursStart } from "../src/modules/whatsapp/business-hours.js";

const config = { timezone: "America/Sao_Paulo", start: "07:00", end: "20:00" };

describe("business hours gate", () => {
  it("is open at the boundaries and closed outside them", () => {
    expect(isWithinBusinessHours(new Date("2024-06-10T10:00:00.000Z"), config)).toBe(true); // 07:00 local
    expect(isWithinBusinessHours(new Date("2024-06-10T09:59:00.000Z"), config)).toBe(false); // 06:59 local
    expect(isWithinBusinessHours(new Date("2024-06-10T22:59:00.000Z"), config)).toBe(true); // 19:59 local
    expect(isWithinBusinessHours(new Date("2024-06-10T23:00:00.000Z"), config)).toBe(false); // 20:00 local
  });

  it("resolves the next start to later today when still before opening", () => {
    const now = new Date("2024-06-10T05:00:00.000Z"); // 02:00 local
    expect(nextBusinessHoursStart(now, config).toISOString()).toBe("2024-06-10T10:00:00.000Z");
  });

  it("rolls over to tomorrow when already past closing", () => {
    const now = new Date("2024-06-10T23:30:00.000Z"); // 20:30 local
    expect(nextBusinessHoursStart(now, config).toISOString()).toBe("2024-06-11T10:00:00.000Z");
  });
});

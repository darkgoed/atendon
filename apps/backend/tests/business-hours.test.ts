import type { Pool } from "pg";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config as appConfig } from "../src/config.js";
import { isWithinBusinessHours, nextBusinessHoursStart } from "../src/modules/whatsapp/business-hours.js";
import { EvolutionClient } from "../src/modules/whatsapp/evolution-client.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

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

describe("DST", () => {
  it("does not skip a day when the next local day is 23h long (spring forward)", () => {
    const ny = { timezone: "America/New_York", start: "09:00", end: "18:00" };
    const now = new Date("2026-03-08T04:30:00.000Z"); // 2026-03-07 23:30 local
    expect(nextBusinessHoursStart(now, ny).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("WhatsApp presence refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops publishing available once business hours close (API process has no hours ticker)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-10T20:59:30.000Z")); // 17:59:30 local, open until 18:00
    const presence = vi.spyOn(EvolutionClient.prototype, "setPresence").mockResolvedValue();
    const query = vi.fn(async () => ({ rows: [{
      instance_name: "inst", tenant_id: "tenant-1",
      timezone: "America/Sao_Paulo", business_hours_start: "08:00", business_hours_end: "18:00"
    }] }));
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...appConfig, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );
    await manager.goOnline("session-1");
    expect(presence.mock.calls.map((call) => call[1])).toEqual(["available"]);

    await vi.advanceTimersByTimeAsync(5 * 60_000); // overnight ticks

    expect(presence.mock.calls.slice(1).map((call) => call[1])).toEqual(["unavailable"]);
    await manager.stopAll();
  });
});

describe("expediente em fuso com horário de verão (auditoria runtime #7)", () => {
  it("início às 00:00 no dia da virada em Santiago não lança", () => {
    const next = nextBusinessHoursStart(new Date("2026-09-06T02:00:00Z"), { timezone: "America/Santiago", start: "00:00", end: "23:00" });
    expect(next.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });
});

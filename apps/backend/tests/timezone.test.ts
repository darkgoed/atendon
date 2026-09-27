import { describe, expect, it } from "vitest";
import { isValidIanaTimeZone, localDateKey, localDateTimeToUtc, localDateTimeToUtcLenient } from "../src/timezone.js";

describe("workspace timezone conversion", () => {
  it("converts ordinary local times to UTC", () => {
    expect(localDateTimeToUtc("2024-02-01", "09:30", "America/Sao_Paulo").toISOString()).toBe("2024-02-01T12:30:00.000Z");
    expect(localDateKey(new Date("2024-02-02T01:00:00.000Z"), "America/Sao_Paulo")).toBe("2024-02-01");
  });

  it("rejects nonexistent wall-clock times during the DST spring transition", () => {
    expect(localDateTimeToUtc("2024-03-10", "01:30", "America/New_York").toISOString()).toBe("2024-03-10T06:30:00.000Z");
    expect(() => localDateTimeToUtc("2024-03-10", "02:30", "America/New_York")).toThrow("Horário local inexistente");
    expect(localDateTimeToUtc("2024-03-10", "03:30", "America/New_York").toISOString()).toBe("2024-03-10T07:30:00.000Z");
  });

  it("chooses the earliest instant for an ambiguous DST fall transition", () => {
    expect(localDateTimeToUtc("2024-11-03", "01:30", "America/New_York").toISOString()).toBe("2024-11-03T05:30:00.000Z");
  });

  it("validates IANA timezone identifiers", () => {
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("not/a-timezone")).toBe(false);
  });
});

describe("buraco do horário de verão (auditoria runtime #7)", () => {
  it("versão tolerante avança para o primeiro instante válido; a estrita segue recusando", () => {
    expect(() => localDateTimeToUtc("2026-09-06", "00:00", "America/Santiago")).toThrow(RangeError);
    expect(localDateTimeToUtcLenient("2026-09-06", "00:00", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localDateTimeToUtcLenient("2026-03-08", "02:30", "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(localDateTimeToUtcLenient("2026-09-10", "09:00", "America/Sao_Paulo").toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });
});

describe("versão tolerante não aceita data impossível", () => {
  it("2026-13-99 e 25:00 seguem lançando", () => {
    expect(() => localDateTimeToUtcLenient("2026-13-99", "00:00", "America/Sao_Paulo")).toThrow(RangeError);
    expect(() => localDateTimeToUtcLenient("2026-09-10", "25:00", "America/Sao_Paulo")).toThrow(RangeError);
  });
});

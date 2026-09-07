import { describe, expect, it } from "vitest";
import { formatBRLFromCents, formatPhone, formatTimeInZone } from "../lib/format";
describe("w2 formatting", () => { it("formats golden values", () => { expect(formatBRLFromCents(12345)).toBe("R$ 123,45"); expect(formatPhone("12996062155")).toBe("12 99606-2155"); expect(formatTimeInZone("2030-01-07T12:15:00.000Z", "America/Sao_Paulo")).toBe("09:15"); }); });

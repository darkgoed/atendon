import { describe, expect, it } from "vitest";
import { formatBrazilianPhone, isValidBrazilianPhone } from "../lib/phone";

describe("formatBrazilianPhone", () => {
  it("formats a national WhatsApp number without requiring country code", () => {
    expect(formatBrazilianPhone("12996062155")).toBe("12 99606-2155");
  });

  it("accepts a pasted Brazilian country code and displays the national format", () => {
    expect(formatBrazilianPhone("+55 12 99606-2155")).toBe("12 99606-2155");
  });

  it("limits input to DDD and a nine-digit number", () => {
    expect(formatBrazilianPhone("12996062155999")).toBe("12 99606-2155");
  });

  it("accepts only complete Brazilian landline or mobile numbers", () => {
    expect(isValidBrazilianPhone("12 99606-2155")).toBe(true);
    expect(isValidBrazilianPhone("12 3606-2155")).toBe(true);
    expect(isValidBrazilianPhone("123")).toBe(false);
  });
});

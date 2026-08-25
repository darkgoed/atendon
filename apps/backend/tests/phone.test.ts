import { describe, expect, it } from "vitest";
import { isQuarantinedPhone, normalizePhoneE164, normalizeWhatsAppJid, phoneE164Schema } from "../src/phone.js";

describe("normalizePhoneE164", () => {
  it.each([
    ["43 23412-3431", "5543234123431"],
    ["(43) 3412-3431", "554334123431"],
    ["55 (43) 23412-3431", "5543234123431"],
    ["0 43 23412-3431", "5543234123431"],
    ["041 43 23412-3431", "5543234123431"],
    ["+55 43 23412-3431", "5543234123431"],
    ["+1 (415) 555-2671", "14155552671"],
    ["+351 912 345 678", "351912345678"]
  ])("canonicaliza %s", (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
  });

  it.each([
    "3412-3431",
    "1234567",
    "123456789",
    "00000000000",
    "551234",
    "10155552671",
    "+0123456789",
    "+1234567890123456",
    "++14155552671",
    "141+55552671",
    "43 23412-3431 ramal 2"
  ])("rejeita %s sem truncar", (input) => {
    expect(() => normalizePhoneE164(input)).toThrow(/telefone/i);
  });

  it("preserva JIDs especiais e atualiza apenas s.whatsapp.net", () => {
    expect(normalizeWhatsAppJid("123@lid", "5543234123431")).toBe("123@lid");
    expect(normalizeWhatsAppJid("43999999999:7@s.whatsapp.net", "5543234123431"))
      .toBe("5543234123431:7@s.whatsapp.net");
  });
});

describe("legacy phone quarantine", () => {
  it("recognizes reserved sentinel numbers with or without a WhatsApp JID", () => {
    expect(isQuarantinedPhone("+999000000001")).toBe(true);
    expect(isQuarantinedPhone("999000000001:4@s.whatsapp.net")).toBe(true);
    expect(isQuarantinedPhone("5511999999999@s.whatsapp.net")).toBe(false);
  });

  it("keeps sentinels canonicalizable for migration audits but rejects them at API boundaries", () => {
    expect(normalizePhoneE164("+999000000001")).toBe("999000000001");
    expect(normalizePhoneE164("999000000001")).toBe("999000000001");
    expect(phoneE164Schema.safeParse("+999000000001").success).toBe(false);
    expect(phoneE164Schema.safeParse("999000000001").success).toBe(false);
  });
});

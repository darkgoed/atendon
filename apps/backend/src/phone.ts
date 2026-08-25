import { z } from "zod";

const BRAZIL_COUNTRY_CODE = "55";
const QUARANTINED_PHONE_PREFIX = "999";
const E164_DIGITS = /^[1-9]\d{7,14}$/;
const BRAZIL_NATIONAL_NUMBER = /^[1-9]\d{9,10}$/;
const BRAZIL_DDDS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38", "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55", "61", "62", "63", "64", "65", "66", "67", "68", "69", "71", "73", "74",
  "75", "77", "79", "81", "82", "83", "84", "85", "86", "87", "88", "89", "91", "92", "93", "94",
  "95", "96", "97", "98", "99"
]);

export class InvalidPhoneError extends Error {
  constructor(message = "Telefone inválido. Informe DDD e número; para números estrangeiros, use + e o E.164 completo.") {
    super(message);
    this.name = "InvalidPhoneError";
  }
}

/**
 * +999 is reserved by ITU and is used only for legacy records whose original
 * phone cannot be recovered. These identifiers must never leave Atendon as a
 * routable destination.
 */
export function isQuarantinedPhone(value: string): boolean {
  const address = value.trim().split("@", 1)[0]?.split(":", 1)[0] ?? "";
  return address.replace(/\D/g, "").startsWith(QUARANTINED_PHONE_PREFIX);
}

function brazilianNationalNumber(digits: string): string | null {
  const candidate = BRAZIL_NATIONAL_NUMBER.test(digits) ? digits
    : /^0[1-9]\d{9,10}$/.test(digits) ? digits.slice(1)
      : /^0\d{2}[1-9]\d{9,10}$/.test(digits) ? digits.slice(3)
        : null;
  if (candidate && BRAZIL_DDDS.has(candidate.slice(0, 2))) return candidate;
  return null;
}

/**
 * Canonicaliza um telefone para E.164 sem o sinal de +, formato usado pelos
 * endereços do WhatsApp. Entradas nacionais são interpretadas como Brasil;
 * outros países precisam ser explicitados com +.
 */
export function normalizePhoneE164(value: string): string {
  const input = value.trim();
  if (!input) throw new InvalidPhoneError();
  const explicitInternational = input.startsWith("+");
  const plusCount = input.match(/\+/g)?.length ?? 0;
  if (/[^\d\s()+.\-/]/.test(input) || plusCount > 1 || (plusCount === 1 && !explicitInternational)) {
    throw new InvalidPhoneError("Telefone contém caracteres inválidos.");
  }
  const digits = input.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(digits)) throw new InvalidPhoneError();

  // Migrations persist E.164 without '+'. The reserved sentinel must remain
  // readable by internal audits; phoneE164Schema still rejects it at inputs.
  if (digits.startsWith(QUARANTINED_PHONE_PREFIX) && E164_DIGITS.test(digits)) return digits;

  if (explicitInternational) {
    if (!E164_DIGITS.test(digits)) throw new InvalidPhoneError();
    if (digits.startsWith(BRAZIL_COUNTRY_CODE)) {
      const national = brazilianNationalNumber(digits.slice(2));
      if (!national || national !== digits.slice(2)) throw new InvalidPhoneError("Telefone brasileiro inválido: informe DDD e 8 ou 9 dígitos.");
    }
    return digits;
  }

  if (digits.startsWith(BRAZIL_COUNTRY_CODE)) {
    const national = brazilianNationalNumber(digits.slice(2));
    if (national && national === digits.slice(2)) return `${BRAZIL_COUNTRY_CODE}${national}`;
  }
  const national = brazilianNationalNumber(digits);
  if (!national) throw new InvalidPhoneError();
  return `${BRAZIL_COUNTRY_CODE}${national}`;
}

export const phoneE164Schema = z.string().trim().min(1).max(64).transform((value, context) => {
  try {
    return normalizePhoneE164(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Telefone inválido"
    });
    return z.NEVER;
  }
}).refine((value) => !isQuarantinedPhone(value), {
  message: "Telefone reservado para quarentena de dados legados."
});

export function normalizeWhatsAppJid(jid: string | null | undefined, canonicalPhone: string): string | null | undefined {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return jid;
  const device = jid.split("@", 1)[0]?.split(":", 2)[1];
  return `${canonicalPhone}${device ? `:${device}` : ""}@s.whatsapp.net`;
}

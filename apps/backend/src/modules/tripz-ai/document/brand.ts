export interface TripzBrandConfig {
  agencyName: string;
  agentName?: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  mutedColor: string;
  phone?: string;
  email?: string;
  address?: string;
  logo?: {
    mimeType: "image/jpeg" | "image/png";
    data: Uint8Array;
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return cleaned || undefined;
}

function color(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

/**
 * Centralizes the public Tripz Turismo identity used by its official website.
 * Deployments may still override individual fields without changing templates.
 */
export function createTripzBrandConfig(input: Partial<TripzBrandConfig> = {}): TripzBrandConfig {
  return {
    agencyName: cleanText(input.agencyName, 100) ?? "Tripz Turismo",
    agentName: cleanText(input.agentName, 100),
    primaryColor: color(input.primaryColor, "#041f3b"),
    secondaryColor: color(input.secondaryColor, "#1a6eb5"),
    backgroundColor: color(input.backgroundColor, "#f6f9fd"),
    textColor: color(input.textColor, "#041f3b"),
    mutedColor: color(input.mutedColor, "#54677a"),
    phone: cleanText(input.phone, 80),
    email: cleanText(input.email, 160),
    address: cleanText(input.address, 220),
    ...(input.logo ? { logo: input.logo } : {})
  };
}

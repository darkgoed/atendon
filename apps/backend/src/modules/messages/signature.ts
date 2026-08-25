import type { Pool } from "pg";

export type SignatureFormat = "name_colon" | "bold_name_colon" | "role_name_colon" | "separate_line";
export type SignatureNameStyle = "full" | "first_name";

export interface SignatureSettings {
  enabled: boolean;
  format: SignatureFormat;
  nameStyle: SignatureNameStyle;
}

function displayName(name: string, style: SignatureNameStyle): string {
  const trimmed = name.trim();
  if (style !== "first_name") return trimmed;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function applySignature(text: string, senderName: string, settings: Pick<SignatureSettings, "format" | "nameStyle">): string {
  const name = displayName(senderName, settings.nameStyle);
  switch (settings.format) {
    case "bold_name_colon": return `*${name}:* ${text}`;
    case "role_name_colon": return `Atendente ${name}: ${text}`;
    case "separate_line": return `${name}\n${text}`;
    case "name_colon":
    default: return `${name}: ${text}`;
  }
}

export async function resolveSignatureSettings(
  db: Pool,
  tenantId: string,
  conversationId: string
): Promise<SignatureSettings | null> {
  const result = await db.query<{
    tenant_enabled: boolean | null;
    format: SignatureFormat | null;
    name_style: SignatureNameStyle | null;
    conversation_override: boolean | null;
  }>(
    `SELECT s.enabled tenant_enabled, s.format, s.name_style, c.signature_enabled conversation_override
     FROM conversations c
     LEFT JOIN attendant_signature_settings s ON s.tenant_id=c.tenant_id
     WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, tenantId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const enabled = row.conversation_override ?? row.tenant_enabled ?? false;
  if (!enabled) return null;
  return { enabled: true, format: row.format ?? "name_colon", nameStyle: row.name_style ?? "full" };
}

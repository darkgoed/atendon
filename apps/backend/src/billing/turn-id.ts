import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Derives a stable UUID-shaped identifier for one logical billing turn. */
export function deriveBillingTurnId(tenantId: string, purpose: string, logicalKey: string): string {
  const digest = createHash("sha256")
    .update(`${tenantId.length}:${tenantId}|${purpose.length}:${purpose}|${logicalKey.length}:${logicalKey}`, "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(uuid)) throw new Error("Failed to derive a valid billing turn UUID");
  return uuid;
}

export const billingTurnId = deriveBillingTurnId;

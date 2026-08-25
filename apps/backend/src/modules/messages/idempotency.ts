import { createHash } from "node:crypto";
import { z } from "zod";

export const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Idempotency-Key contém caracteres inválidos");

export function parseIdempotencyKey(value: unknown): string {
  return idempotencyKeySchema.parse(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function payloadFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

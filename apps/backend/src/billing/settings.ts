import type { PoolClient } from "pg";
import { db } from "../db/client.js";

/** Billing configuration. PostgreSQL BIGINT/BIGINT[] values are returned as strings and converted to numbers here. */
export type BillingSettings = {
  id: boolean;
  default_rollover_rate_bps: number;
  default_rollover_max_percentage_bps: number;
  default_rollover_expiration_periods: number;
  usd_brl_rate_micros: number;
  credit_min_cents: number;
  credit_max_cents: number;
  credit_suggested_cents: number[];
  allow_custom_credit: boolean;
  allow_unlimited_credit: boolean;
  quota_alert_thresholds_bps: number[];
  credit_alert_thresholds_bps: number[];
  min_overage_estimate_cents: number;
  reservation_ttl_minutes: number;
  webhook_tolerance_seconds: number;
  created_at: Date;
  updated_at: Date;
};

let cached: { value: BillingSettings; expiresAt: number } | undefined;
const TTL_MS = 30_000;

export function invalidateBillingSettingsCache(): void { cached = undefined; }

export async function getBillingSettings(client?: PoolClient): Promise<BillingSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const connection = client ?? db;
  const result = await connection.query("SELECT * FROM billing_settings WHERE id = true LIMIT 1");
  if (!result.rows[0]) throw new Error("billing_settings singleton is missing");
  const row = result.rows[0] as Record<string, unknown>;
  const bigint = (value: unknown): number => Number(value ?? 0);
  const settings: BillingSettings = {
    id: Boolean(row.id),
    default_rollover_rate_bps: Number(row.default_rollover_rate_bps),
    default_rollover_max_percentage_bps: Number(row.default_rollover_max_percentage_bps),
    default_rollover_expiration_periods: Number(row.default_rollover_expiration_periods),
    usd_brl_rate_micros: bigint(row.usd_brl_rate_micros),
    credit_min_cents: bigint(row.credit_min_cents),
    credit_max_cents: bigint(row.credit_max_cents),
    credit_suggested_cents: (row.credit_suggested_cents as unknown[]).map(bigint),
    allow_custom_credit: Boolean(row.allow_custom_credit),
    allow_unlimited_credit: Boolean(row.allow_unlimited_credit),
    quota_alert_thresholds_bps: (row.quota_alert_thresholds_bps as unknown[]).map(Number),
    credit_alert_thresholds_bps: (row.credit_alert_thresholds_bps as unknown[]).map(Number),
    min_overage_estimate_cents: bigint(row.min_overage_estimate_cents),
    reservation_ttl_minutes: Number(row.reservation_ttl_minutes),
    webhook_tolerance_seconds: Number(row.webhook_tolerance_seconds),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date
  };
  cached = { value: settings, expiresAt: Date.now() + TTL_MS };
  return settings;
}

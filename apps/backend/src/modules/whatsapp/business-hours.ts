import type { Pool } from "pg";
import { localDateKey, localDateTimeToUtc, zonedParts } from "../../timezone.js";

export interface BusinessHoursConfig {
  timezone: string;
  start: string;
  end: string;
}

function minutesOfDay(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

export async function loadBusinessHoursConfig(db: Pool, tenantId: string): Promise<BusinessHoursConfig> {
  const result = await db.query<{ timezone: string; business_hours_start: string; business_hours_end: string }>(
    "SELECT timezone,business_hours_start,business_hours_end FROM tenants WHERE id=$1",
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Tenant não encontrado: ${tenantId}`);
  return { timezone: row.timezone, start: row.business_hours_start, end: row.business_hours_end };
}

export function isWithinBusinessHours(now: Date, config: BusinessHoursConfig): boolean {
  const parts = zonedParts(now, config.timezone);
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= minutesOfDay(config.start) && minutes < minutesOfDay(config.end);
}

export function nextBusinessHoursStart(now: Date, config: BusinessHoursConfig): Date {
  const todayKey = localDateKey(now, config.timezone);
  const today = localDateTimeToUtc(todayKey, config.start, config.timezone);
  if (today.getTime() > now.getTime()) return today;
  // Aritmética na data local (não no instante): dia de 23h no DST não pula D+1.
  const [year, month, day] = todayKey.split("-").map(Number);
  const tomorrowKey = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return localDateTimeToUtc(tomorrowKey, config.start, config.timezone);
}

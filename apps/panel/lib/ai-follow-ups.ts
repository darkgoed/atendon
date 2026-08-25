export type FollowUpIntervalUnit = "minutes" | "hours" | "days";

export type FollowUpDelivery =
  | { type: "text" }
  | { type: "image"; assetId: string }
  | { type: "sticker"; assetId: string };

export interface AiFollowUpSettings {
  enabled: boolean;
  delaysMinutes: number[];
  delivery: FollowUpDelivery[];
  /** Campos derivados retornados apenas para clientes legados. */
  maxCount?: number;
  intervalMinutes?: number;
}

export function normalizeFollowUpDelivery(
  delaysMinutes: number[],
  delivery?: FollowUpDelivery[]
): FollowUpDelivery[] {
  return delaysMinutes.map((_, index) => delivery?.[index] ?? { type: "text" });
}

export function formatFollowUpDelay(minutes: number): string {
  const display = displayFollowUpInterval(minutes);
  const label = display.unit === "days" ? "dia(s)" : display.unit === "hours" ? "hora(s)" : "minuto(s)";
  return `${display.value} ${label}`;
}

export function isValidFollowUpDelays(delays: number[]): boolean {
  return delays.length >= 1
    && delays.length <= 10
    && delays.every((delay, index) =>
      Number.isInteger(delay)
      && delay >= 1
      && delay <= 43_200
      && (index === 0 || delay > delays[index - 1]!)
    );
}

const UNIT_MINUTES: Record<FollowUpIntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440
};

export function followUpIntervalToMinutes(value: number, unit: FollowUpIntervalUnit): number {
  return Math.round(value * UNIT_MINUTES[unit]);
}

export function displayFollowUpInterval(intervalMinutes: number): { value: number; unit: FollowUpIntervalUnit } {
  if (intervalMinutes >= UNIT_MINUTES.days && intervalMinutes % UNIT_MINUTES.days === 0) {
    return { value: intervalMinutes / UNIT_MINUTES.days, unit: "days" };
  }
  if (intervalMinutes >= UNIT_MINUTES.hours && intervalMinutes % UNIT_MINUTES.hours === 0) {
    return { value: intervalMinutes / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { value: intervalMinutes, unit: "minutes" };
}

export function followUpIntervalBounds(unit: FollowUpIntervalUnit): { min: number; max: number } {
  return {
    min: 1,
    max: 43_200 / UNIT_MINUTES[unit]
  };
}

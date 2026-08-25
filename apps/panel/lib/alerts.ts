export interface ServerAlertToast {
  id: string;
  message: string;
  should_toast?: boolean;
}

export interface OperationalAlert {
  id: string;
  message: string;
  kind: "operational" | "meeting";
  metadata: Record<string, unknown>;
  created_at: string;
  notified_at: string | null;
  read_at: string | null;
  can_acknowledge: boolean;
}

export interface AlertsResponse {
  alerts: OperationalAlert[];
  unread: number;
  total: number;
  offset: number;
  limit: number;
  receipt_mode: "member" | "root_read_only";
}

export function notificationBadgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  const normalized = Math.floor(unread);
  return normalized > 99 ? "99+" : String(normalized);
}

export function toastableAlerts(alerts: readonly ServerAlertToast[]): ServerAlertToast[] {
  return alerts.filter((alert) => alert.should_toast !== false);
}

export interface AdaptivePollingDelayOptions {
  failures: number;
  visibilityState: string;
  baseMs: number;
  maxMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export function adaptivePollingDelay({
  failures,
  visibilityState,
  baseMs,
  maxMs = 120_000,
  jitterRatio = 0.2,
  random = Math.random
}: AdaptivePollingDelayOptions): number | null {
  if (visibilityState !== "visible") return null;
  const safeBase = Math.max(1, Math.floor(baseMs));
  const safeMax = Math.max(safeBase, Math.floor(maxMs));
  const exponent = Math.min(30, Math.max(0, Math.floor(failures)));
  const exponential = Math.min(safeMax, safeBase * (2 ** exponent));
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const boundedJitter = Math.min(1, Math.max(0, jitterRatio));
  const multiplier = 1 + ((boundedRandom * 2) - 1) * boundedJitter;
  return Math.max(1, Math.min(safeMax, Math.round(exponential * multiplier)));
}

export function alertHistoryPollingDelay({
  deliveryV2,
  failures,
  visibilityState,
  baseMs = 10_000,
  random = Math.random
}: {
  deliveryV2: boolean;
  failures: number;
  visibilityState: string;
  baseMs?: number;
  random?: () => number;
}): number | null {
  if (visibilityState !== "visible") return null;
  if (!deliveryV2) return baseMs;
  return adaptivePollingDelay({
    failures,
    visibilityState,
    baseMs: Math.min(baseMs, 5_000),
    maxMs: 10_000,
    random
  });
}

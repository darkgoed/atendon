export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE_PERIOD" | "SUSPENDED" | "CANCELED" | "EXPIRED";
export const CHARGEABLE_SUBSCRIPTION_STATUSES = ["ACTIVE", "PAST_DUE", "GRACE_PERIOD", "TRIALING"] as const;
export interface EffectiveEntitlements {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
}

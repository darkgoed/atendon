export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE_PERIOD" | "SUSPENDED" | "CANCELED" | "EXPIRED";
export interface EffectiveEntitlements {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
}

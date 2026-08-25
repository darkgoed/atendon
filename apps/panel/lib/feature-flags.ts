import { ApiError } from "./api";

export type PanelFeatureFlagKey =
  | "ai_turn_visibility_v1"
  | "conversations_delta_v2"
  | "alerts_delivery_v2"
  | "case_organization_v1"
  | "dashboard_widgets_v1"
  | "web_push_v1";

export interface PanelFeatureFlagsResponse {
  flags: Partial<Record<PanelFeatureFlagKey, boolean>>;
}

export function panelFeatureEnabled(
  response: PanelFeatureFlagsResponse | undefined,
  key: PanelFeatureFlagKey
): boolean {
  return response?.flags[key] === true;
}

export function isFeatureFlagDisabledError(
  error: unknown,
  key: PanelFeatureFlagKey
): boolean {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== "object") {
    return false;
  }
  const body = error.body as { code?: unknown; feature?: unknown };
  return body.code === "FEATURE_FLAG_DISABLED" && body.feature === key;
}

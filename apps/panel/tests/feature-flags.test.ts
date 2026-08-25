import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import {
  isFeatureFlagDisabledError,
  panelFeatureEnabled
} from "../lib/feature-flags";

describe("panel feature flags", () => {
  it("fails closed while flags are absent or explicitly off", () => {
    expect(panelFeatureEnabled(undefined, "conversations_delta_v2")).toBe(false);
    expect(panelFeatureEnabled({ flags: {} }, "alerts_delivery_v2")).toBe(false);
    expect(panelFeatureEnabled({
      flags: { conversations_delta_v2: false }
    }, "conversations_delta_v2")).toBe(false);
  });

  it("enables only an explicit tenant-effective true decision", () => {
    expect(panelFeatureEnabled({
      flags: { conversations_delta_v2: true, alerts_delivery_v2: false }
    }, "conversations_delta_v2")).toBe(true);
  });

  it("recognizes the backend fallback signal for the matching feature", () => {
    const error = new ApiError("fallback", 409, {
      code: "FEATURE_FLAG_DISABLED",
      feature: "conversations_delta_v2",
      fallback: "/conversations/id/messages"
    });
    expect(isFeatureFlagDisabledError(error, "conversations_delta_v2")).toBe(true);
    expect(isFeatureFlagDisabledError(error, "alerts_delivery_v2")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deploymentSnapshotHash
} from "../src/modules/operations/deployment-snapshots.js";
import {
  decideFeatureFlag,
  featureFlagMetricLabels,
  NON_REGRESSIVE_SECURITY_FLAG_KEYS
} from "../src/modules/operations/feature-flags.js";

const base = {
  flag_key: "compact_prompt_v2" as const,
  description: "Compact prompt",
  default_enabled: false,
  global_enabled: null,
  kill_switch_enabled: false,
  tenant_override: null,
  updated_at: "2026-07-25T00:00:00.000Z"
};

describe("feature flag decisions", () => {
  it("marks confirmation evidence and evaluator PII redaction as non-regressive invariants", () => {
    expect(NON_REGRESSIVE_SECURITY_FLAG_KEYS).toEqual([
      "ai_deterministic_confirmations_v2",
      "evaluator_payload_redaction_v2"
    ]);
  });

  it("uses kill > tenant > global > default and emits tenant-free metric labels", () => {
    expect(decideFeatureFlag(base)).toMatchObject({ enabled: false, source: "default" });
    expect(decideFeatureFlag({ ...base, global_enabled: true }))
      .toMatchObject({ enabled: true, source: "global" });
    expect(decideFeatureFlag({ ...base, global_enabled: true, tenant_override: false }))
      .toMatchObject({ enabled: false, source: "tenant_override" });
    const killed = decideFeatureFlag({
      ...base,
      global_enabled: true,
      tenant_override: true,
      kill_switch_enabled: true
    });
    expect(killed).toMatchObject({ enabled: false, source: "kill_switch" });
    expect(featureFlagMetricLabels(killed)).toEqual({
      flag: "compact_prompt_v2",
      source: "kill_switch",
      enabled: "false"
    });
    expect(featureFlagMetricLabels(killed)).not.toHaveProperty("tenantId");
  });

  it("fails closed for unsupported capabilities before every rollout value", () => {
    expect(decideFeatureFlag({
      ...base,
      flag_key: "tripz_ai_v1",
      kind: "capability",
      supported: false,
      global_enabled: true,
      tenant_override: true,
      kill_switch_enabled: true
    })).toMatchObject({
      enabled: false,
      supported: false,
      source: "unsupported",
      tenantOverride: true
    });
  });

  it("ignores workspace overrides for the three globally released panel phases", () => {
    for (const flag_key of ["case_organization_v1", "dashboard_widgets_v1", "web_push_v1"] as const) {
      expect(decideFeatureFlag({ ...base, flag_key, global_enabled: true, tenant_override: false }))
        .toMatchObject({ enabled: true, source: "global", tenantOverride: null });
      expect(decideFeatureFlag({ ...base, flag_key, global_enabled: true, tenant_override: true, kill_switch_enabled: true }))
        .toMatchObject({ enabled: false, source: "kill_switch", tenantOverride: null });
    }
  });

  it("hashes canonical snapshots independently of object insertion order", () => {
    expect(canonicalJson({ b: 2, a: { d: false, c: true } }))
      .toBe('{"a":{"c":true,"d":false},"b":2}');
    const first = deploymentSnapshotHash({
      deployVersion: "build-1",
      latestMigration: "0076_feature_flags_deployment_snapshots.sql",
      globalFlags: {
        compact_prompt_v2: {
          defaultEnabled: false,
          globalEnabled: null,
          killSwitchEnabled: false,
          enabled: false
        }
      } as never,
      effectiveFlags: {} as never
    });
    const second = deploymentSnapshotHash({
      latestMigration: "0076_feature_flags_deployment_snapshots.sql",
      deployVersion: "build-1",
      effectiveFlags: {} as never,
      globalFlags: {
        compact_prompt_v2: {
          enabled: false,
          killSwitchEnabled: false,
          globalEnabled: null,
          defaultEnabled: false
        }
      } as never
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

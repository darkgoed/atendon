import type { CapabilityKey } from "./panel-manifest";
import type { EffectiveCapability } from "./capabilities";

export type CapabilityOverride = boolean | null;

export function capabilityOverrideValue(capability: EffectiveCapability): "inherit" | "on" | "off" {
  return capability.tenantOverride === null ? "inherit" : capability.tenantOverride ? "on" : "off";
}

export function parseCapabilityOverride(value: string): CapabilityOverride {
  return value === "on" ? true : value === "off" ? false : null;
}

export function capabilityCascadeImpact(catalog: readonly EffectiveCapability[], key: CapabilityKey, override: CapabilityOverride): CapabilityKey[] {
  const byKey = new Map(catalog.map((item) => [item.key, item]));
  const affected = new Set<CapabilityKey>();
  const visited = new Set<CapabilityKey>();
  if (override === true) {
    const visit = (candidate: CapabilityKey) => {
      if (visited.has(candidate)) return;
      visited.add(candidate);
      for (const dependency of byKey.get(candidate)?.dependencies ?? []) {
        if (byKey.get(dependency)?.enabled !== true) affected.add(dependency);
        visit(dependency);
      }
    };
    visit(key);
  } else if (override === false) {
    const visit = (dependency: CapabilityKey) => {
      if (visited.has(dependency)) return;
      visited.add(dependency);
      for (const candidate of catalog) {
        if (!candidate.enabled || !candidate.dependencies.includes(dependency) || affected.has(candidate.key)) continue;
        affected.add(candidate.key);
        visit(candidate.key);
      }
    };
    visit(key);
  }
  return [...affected];
}

export function affectedCapabilityKeys(body: unknown): CapabilityKey[] {
  if (!body || typeof body !== "object" || !("affectedCapabilities" in body)) return [];
  const raw = (body as { affectedCapabilities?: unknown }).affectedCapabilities;
  return Array.isArray(raw) ? raw.filter((item): item is CapabilityKey => typeof item === "string") : [];
}

"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import useSWR from "swr";
import { api } from "./api";
import type { CapabilityKey } from "./panel-manifest";

export type CapabilitySource = "kill_switch" | "tenant_override" | "global" | "default" | "dependency" | "unsupported";

export type EffectiveCapability = {
  key: CapabilityKey;
  displayName: string;
  description: string;
  kind: "capability";
  tenantConfigurable: boolean;
  availabilityMode: string;
  uiOrder: number;
  dependencies: CapabilityKey[];
  supported: boolean;
  tenantOverride: boolean | null;
  enabled: boolean;
  source: CapabilitySource;
  blockedBy: CapabilityKey[];
};

export type CapabilitiesResponse = { capabilities: EffectiveCapability[] };

export const capabilitiesCacheKey = (tenantId: string | null | undefined) =>
  tenantId ? (["tenant-capabilities", tenantId] as const) : null;

const fetchCapabilities = () => api<CapabilitiesResponse>("/capabilities");

export type CapabilitiesState = {
  capabilities: EffectiveCapability[];
  byKey: ReadonlyMap<CapabilityKey, EffectiveCapability>;
  isLoading: boolean;
  error: Error | undefined;
  retry: () => Promise<CapabilitiesResponse | undefined>;
  isEnabled: (key: CapabilityKey) => boolean;
};

const emptyMap = new Map<CapabilityKey, EffectiveCapability>();
const defaultState: CapabilitiesState = {
  capabilities: [],
  byKey: emptyMap,
  isLoading: false,
  error: undefined,
  retry: async () => undefined,
  isEnabled: () => false
};

const CapabilitiesContext = createContext<CapabilitiesState>(defaultState);

export function useTenantCapabilities(tenantId: string | null | undefined): CapabilitiesState {
  const key = capabilitiesCacheKey(tenantId);
  const { data, error, isLoading, mutate } = useSWR<CapabilitiesResponse>(key, fetchCapabilities, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    shouldRetryOnError: false,
    keepPreviousData: false
  });
  const capabilities = useMemo(() => data?.capabilities ?? [], [data?.capabilities]);
  const byKey = useMemo(
    () => new Map(capabilities.map((capability) => [capability.key, capability])),
    [capabilities]
  );
  return useMemo(() => ({
    capabilities,
    byKey,
    isLoading: Boolean(key && isLoading && !data),
    error: error instanceof Error ? error : error ? new Error("Falha ao carregar capabilities") : undefined,
    retry: async () => mutate(),
    // Fail-closed: somente uma decisão efetiva, suportada e explicitamente true libera o módulo.
    isEnabled: (capabilityKey: CapabilityKey) => byKey.get(capabilityKey)?.enabled === true
  }), [byKey, capabilities, data, error, isLoading, key, mutate]);
}

export function CapabilitiesProvider({ tenantId, children }: { tenantId?: string | null; children: ReactNode }) {
  const state = useTenantCapabilities(tenantId);
  return <CapabilitiesContext.Provider value={state}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): CapabilitiesState {
  return useContext(CapabilitiesContext);
}

export const capabilitySourceLabel: Record<CapabilitySource, string> = {
  kill_switch: "Bloqueio global",
  tenant_override: "Override da empresa",
  global: "Configuração global",
  default: "Padrão do catálogo",
  dependency: "Dependência",
  unsupported: "Não provisionada"
};

"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import useSWR from "swr";
import { api } from "./api";

export type EntitlementsResponse = {
  tenantId?: string;
  plan?: { code?: string; name?: string } | null;
  status?: string;
  features?: Record<string, boolean>;
  limits?: Record<string, number | null>;
  usage?: Record<string, number>;
};

export type EntitlementsState = EntitlementsResponse & {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  isLoading: boolean;
  error?: Error;
  isFeatureEnabled: (featureKey: string) => boolean;
  retry: () => Promise<EntitlementsResponse | undefined>;
};

const fetchMyPlan = () => api<EntitlementsResponse>("/billing/my-plan");
const defaults: EntitlementsState = {
  features: {}, limits: {}, usage: {}, isLoading: false,
  isFeatureEnabled: () => false, retry: async () => undefined
};
const EntitlementsContext = createContext<EntitlementsState>(defaults);

export function useEntitlements(): EntitlementsState {
  const { data, error, isLoading, mutate } = useSWR<EntitlementsResponse>("billing-my-plan", fetchMyPlan, {
    revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false
  });
  return useMemo(() => {
    const features = data?.features ?? {};
    const limits = data?.limits ?? {};
    const usage = data?.usage ?? {};
    return { ...data, features, limits, usage,
      isLoading: isLoading && !data,
      error: error instanceof Error ? error : error ? new Error("Falha ao carregar plano") : undefined,
      // Enquanto a consulta falha ou está pendente, o frontend permanece aberto.
      isFeatureEnabled: (key: string) => error || (isLoading && !data) ? true : features[key] === true,
      retry: async () => mutate()
    };
  }, [data, error, isLoading, mutate]);
}

export function EntitlementsProvider({ children }: { children: ReactNode }) {
  const state = useEntitlements();
  return <EntitlementsContext.Provider value={state}>{children}</EntitlementsContext.Provider>;
}

export function useFeature(featureKey: string): boolean {
  return useContext(EntitlementsContext).isFeatureEnabled(featureKey);
}

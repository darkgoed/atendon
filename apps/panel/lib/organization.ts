"use client";

import useSWR from "swr";
import { api } from "./api";
import type { PanelFeatureFlagsResponse } from "./feature-flags";
import type { LeadFilters } from "./lead-filters";

const fetcher = (url: string) => api<PanelFeatureFlagsResponse>(url);

export function useCaseOrganizationEnabled(): boolean | null {
  const { data, error } = useSWR<PanelFeatureFlagsResponse>("/feature-flags", fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000
  });
  if (error) return false;
  if (!data) return null;
  return data.flags.case_organization_v1 === true;
}

const SAVED_LEAD_FILTER_KEYS = [
  "status",
  "busca",
  "unidade_id",
  "categoria_id",
  "parceiro_id",
  "estrelas"
] as const satisfies readonly (keyof LeadFilters)[];

export function leadFiltersForSavedView(filters: LeadFilters): Record<string, string | number> {
  const saved: Record<string, string | number> = {};
  for (const key of SAVED_LEAD_FILTER_KEYS) {
    const value = filters[key];
    if (!value) continue;
    saved[key] = key === "estrelas" ? Number(value) : value;
  }
  return saved;
}

export function applyLeadSavedViewFilters(current: LeadFilters, saved: Record<string, unknown>): LeadFilters {
  const next = Object.fromEntries(Object.keys(current).map((key) => [key, ""])) as LeadFilters;
  for (const key of SAVED_LEAD_FILTER_KEYS) {
    const value = saved[key];
    if (key === "estrelas" && typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5) {
      next[key] = String(value);
    } else if (typeof value === "string") {
      next[key] = value;
    }
  }
  return next;
}

"use client";

import useSWR from "swr";
import { api } from "./api";
import { canAccessWithSession, type PanelSession } from "./session";

const fetchSession = (url: string) => api<PanelSession>(url);

export function usePermission(permission: string): boolean {
  const { data: session } = useSWR<PanelSession>("/me", fetchSession, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  return session ? canAccessWithSession(session, [permission]) : false;
}

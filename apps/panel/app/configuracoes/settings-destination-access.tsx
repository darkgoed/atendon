"use client";

import type { ReactNode } from "react";
import useSWR from "swr";
import { LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import { canAccessRootWorkspace, canAccessWithSession, type PanelSession } from "@/lib/session";

const fetcher = (url: string) => api<PanelSession>(url);

/**
 * Guarda de rota das páginas de destino das configurações. A sidebar não é
 * autorização: valida a sessão (SWR /me) antes de montar o conteúdo e não
 * renderiza nada quando o acesso não é permitido (deep-link direto).
 */
export function SettingsDestinationAccess({
  required,
  requireRootWorkspace,
  children
}: {
  required?: readonly string[];
  requireRootWorkspace?: boolean;
  children: ReactNode;
}) {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  if (!session) return <LoadingState />;
  const allowed = requireRootWorkspace
    ? canAccessRootWorkspace(session)
    : canAccessWithSession(session, required);
  return allowed ? <>{children}</> : null;
}

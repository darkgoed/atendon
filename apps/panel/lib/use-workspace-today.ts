"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { api } from "./api";
import type { PanelSession } from "./session";
import { localDay } from "./timezone";

const fetchSession = (url: string) => api<PanelSession>(url);

/**
 * Período personalizado do dashboard começa em "hoje" do WORKSPACE (o backend
 * agrupa por dia no fuso do workspace). `toISOString()` dava o dia UTC: em BRT,
 * das 21h à meia-noite abria em "amanhã", vazio (auditoria painel P3-3).
 * Enquanto a sessão carrega usa o fuso do navegador; ao chegar o do workspace,
 * troca as datas que o usuário ainda não mexeu.
 */
export function useWorkspaceCustomRange() {
  const { data: session } = useSWR<PanelSession>("/me", fetchSession, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const timezone = session?.activeWorkspace?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDay(new Date(), timezone);
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const previousToday = useRef(today);
  useEffect(() => {
    const previous = previousToday.current;
    if (previous === today) return;
    previousToday.current = today;
    setCustomStart((current) => current === previous ? today : current);
    setCustomEnd((current) => current === previous ? today : current);
  }, [today]);
  return { today, customStart, setCustomStart, customEnd, setCustomEnd };
}

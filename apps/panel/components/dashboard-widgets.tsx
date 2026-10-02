"use client";

import { useState } from "react";
import { DashboardReferenceOverview } from "@/components/dashboard-reference-overview";
import { Shell } from "@/components/shell";
import { Input, Segmented } from "@/components/ui";
import { useSWRConfig } from "swr";
import { useRealtimeSignals } from "@/lib/realtime";
import styles from "./metrics-dashboard.module.css";

const PERIOD_OPTIONS: Array<[string, string]> = [["today", "Hoje"], ["week", "Semana"], ["month", "Mês"], ["custom", "Período"]];

/* A Visão geral é uma tela única no visual de referência (Painel.dc.html): o
   funil de conversão é o funil definitivo e as seções do overview substituem
   os cards do board antigo — não há alternância nem personalização de board. */
export function DashboardWidgets() {
  const today = new Date().toISOString().slice(0, 10);
  const [period, setPeriod] = useState("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const { mutate: mutateCache } = useSWRConfig();

  // Um único filtro alimenta todas as seções: elas recalculam juntas.
  const periodQuery = period === "custom"
    ? `period=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
    : `period=${period}`;
  const periodSummary = period === "custom"
    ? `${new Date(`${customStart}T12:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" })} — ${new Date(`${customEnd}T12:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" })}`
    : PERIOD_OPTIONS.find(([key]) => key === period)?.[1] ?? "Hoje";
  // Data do dia do cabeçalho da referência Painel.dc.html; caixa alta fica no CSS.
  const toolbarDate = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Sao_Paulo" });

  // Uma única requisição consolidada alimenta a visão geral
  // (/dashboard?include=widgets). Realtime revalida ESSE endereço — não há mais
  // rajada de ~20 requests por sinal.
  const consolidateKey = (key: unknown) => typeof key === "string" && key.startsWith("/dashboard?include=widgets");
  useRealtimeSignals({
    onCatchUp: () => { if (document.visibilityState === "visible") void mutateCache(consolidateKey); },
    onSignal: (signal) => {
      if (document.visibilityState === "visible" && (signal.type === "appointment.changed" || signal.type === "case.assignment.changed" || signal.type === "conversation.messages.changed")) {
        void mutateCache(consolidateKey);
      }
    }
  });

  return (
    <Shell>
      <div className={styles.pageFrame}>
        {/* Toolbar única: título, período e ações na mesma linha, grudada no
            topo ao rolar. Antes eram um PageHeader alto com descrição + uma
            fileira de controles — duas linhas de chrome antes do primeiro dado. */}
        <header className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <span className={styles.toolbarDate}>{toolbarDate}</span>
            <h1>Visão geral</h1>
            <span className={styles.toolbarLive}><span aria-hidden="true" className={`${styles.liveDot} on-live`} />{periodSummary}</span>
          </div>
          <div className={styles.toolbarActions}>
            <Segmented aria-label="Período" className={styles.toolbarSegmented}>
              {PERIOD_OPTIONS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>
              ))}
            </Segmented>
            {period === "custom" ? (
              <div className={styles.toolbarDates}>
                <label className="sr-only" htmlFor="dashboard-start">Data inicial</label>
                <Input id="dashboard-start" type="date" value={customStart} max={customEnd} onChange={(event) => { setCustomStart(event.target.value); if (customEnd < event.target.value) setCustomEnd(event.target.value); }} />
                <label className="sr-only" htmlFor="dashboard-end">Data final</label>
                <Input id="dashboard-end" type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} />
              </div>
            ) : null}
          </div>
        </header>

        <DashboardReferenceOverview periodQuery={periodQuery} />
      </div>
    </Shell>
  );
}

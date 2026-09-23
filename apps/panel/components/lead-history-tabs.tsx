"use client";

// R9/R10 — Card colapsável do histórico do lead na página do contato:
// colapsado por padrão (não rouba espaço; nada é carregado fechado), aba local
// "Histórico | Atividades". O componente fica isolado aqui para a integração
// na página ser de uma linha (e o orquestrador poder inserir seções vizinhas
// sem conflito).

import { CaretDown } from "@/components/icons";
import { useId, useState } from "react";
import { LeadActivities } from "@/components/lead-activities";
import { LeadTimeline } from "@/components/lead-timeline";
import styles from "./lead-history.module.css";

export function LeadEventHistory({ leadId, timezone }: { leadId: string; timezone?: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"history" | "activities">("history");
  const panelId = useId();

  return (
    <section className="card" aria-labelledby={`${panelId}-title`}>
      <h3 id={`${panelId}-title`} className={styles.heading}>
        <button
          type="button"
          className={styles.header}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="cardtitle">Histórico do lead</span>
          <CaretDown aria-hidden="true" className={styles.chevron} data-open={open} size={16} />
        </button>
      </h3>
      {open ? (
        <div id={panelId} className={styles.panel}>
          <div className={styles.tabs} role="tablist" aria-label="Visão do histórico">
            <button type="button" role="tab" aria-selected={tab === "history"} className={styles.tab} onClick={() => setTab("history")}>
              Histórico
            </button>
            <button type="button" role="tab" aria-selected={tab === "activities"} className={styles.tab} onClick={() => setTab("activities")}>
              Atividades
            </button>
          </div>
          {tab === "history" ? <LeadTimeline leadId={leadId} timezone={timezone} /> : <LeadActivities leadId={leadId} timezone={timezone} />}
        </div>
      ) : null}
    </section>
  );
}

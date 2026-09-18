"use client";

// R10 — Atividades do contato (compacta): mesma fonte de eventos da timeline,
// visão operacional (ação, ator, quando) sem agrupamento nem detalhe longo.
// O filtro de categoria é do endpoint (?view=activities / /activities) — o
// backend pode escolher o formato; 404 → seção vazia.

import { LeadEventRow } from "@/components/lead-timeline";
import { Empty } from "@/components/page-state";
import { useLeadEvents } from "@/lib/lead-history";
import styles from "./lead-history.module.css";

export function LeadActivities({ leadId, timezone }: { leadId: string; timezone?: string }) {
  const { items, loading, notFound, error, canLoadMore, loadingMore, loadMoreError, loadMore, reload } = useLeadEvents("activities", leadId, true);

  if (loading && items.length === 0) {
    return <div aria-label="Carregando atividades" className="skeleton h-24" role="status" />;
  }
  if (notFound || (!error && items.length === 0)) {
    return (
      <Empty>
        Sem atividades ainda.
        <button type="button" className="btn mt-2" onClick={reload}>
          Atualizar
        </button>
      </Empty>
    );
  }
  if (error) {
    return (
      <div role="alert" className="grid gap-2">
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={reload}>
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div>
      <ol className={styles.compactList}>
        {items.map((event, index) => (
          <LeadEventRow key={`${event.type}|${event.at}|${event.actor ?? ""}|${index}`} event={event} timezone={timezone} compact />
        ))}
      </ol>
      {canLoadMore ? (
        <div className={styles.loadMore}>
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      ) : null}
      {loadMoreError ? (
        <p className="error" role="alert">
          {loadMoreError}
        </p>
      ) : null}
    </div>
  );
}

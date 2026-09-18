"use client";

// R9 — Timeline completa do lead: eventos agrupados por tipo (origem →
// qualificações → tags → pipeline → responsáveis → transferências →
// agendamentos → observações → encerramento), paginada por keyset com
// "Carregar mais". Eventos de IA são visualmente separados dos eventos de
// robô/etapas e humanos (ícone + badge por fonte). Contratos pendentes do
// backend: GET /scheduling/leads/:id/timeline (shape { items, page });
// 404 → "Sem eventos ainda".

import { MagicWand, Robot, User } from "@phosphor-icons/react";
import { Empty } from "@/components/page-state";
import { formatPanelDateTime } from "@/lib/format";
import {
  groupLeadEvents,
  LEAD_EVENT_GROUP_LABELS,
  LEAD_EVENT_SOURCE_LABELS,
  leadEventActor,
  leadEventDetail,
  leadEventSource,
  leadEventTitle,
  relativeEventTime,
  useLeadEvents,
  type LeadTimelineEvent
} from "@/lib/lead-history";
import styles from "./lead-history.module.css";

/**
 * Linha única de evento — compartilhada pela timeline (R9) e pela visão
 * compacta de atividades (R10): mesma fonte de listagem, sem duplicação.
 */
export function LeadEventRow({
  event,
  timezone,
  compact = false
}: {
  event: LeadTimelineEvent;
  timezone?: string;
  compact?: boolean;
}) {
  const source = leadEventSource(event);
  const sourceLabel = LEAD_EVENT_SOURCE_LABELS[source];
  const detailText = leadEventDetail(event.detail);
  const actorText = leadEventActor(event.actor);
  const absolute = event.at
    ? formatPanelDateTime(event.at, { dateStyle: "short", timeStyle: "medium" }, "pt-BR", timezone)
    : "";
  const SourceIcon = source === "ai" ? MagicWand : source === "robot" ? Robot : User;
  return (
    <li className={styles.row} data-source={source}>
      <span aria-hidden="true" className={styles.sourceIcon}>
        <SourceIcon size={14} weight={source === "ai" ? "fill" : "regular"} />
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.title}>{leadEventTitle(event.type ?? "")}</span>
          <span className={styles.sourceBadge}>{LEAD_EVENT_SOURCE_LABELS[source]}</span>
        </div>
        {!compact && detailText ? <p className={styles.detail}>{detailText}</p> : null}
        <footer className={styles.meta}>
          {/* O rodapé não repete o rótulo da fonte: quando o ator É a fonte
              ("IA" age e o badge já diz "IA"), o rótulo duplicado some — a
              informação fica só no badge, fonte e ator sem redundância. */}
          {actorText.trim().toLowerCase() !== sourceLabel.trim().toLowerCase() ? <span>{actorText}</span> : null}
          {event.at ? (
            <time className="mono" dateTime={event.at} title={absolute}>
              {relativeEventTime(event.at)}
            </time>
          ) : null}
        </footer>
      </div>
    </li>
  );
}

export function LeadTimeline({ leadId, timezone }: { leadId: string; timezone?: string }) {
  const { items, loading, notFound, error, canLoadMore, loadingMore, loadMoreError, loadMore, reload } = useLeadEvents("timeline", leadId, true);

  if (loading && items.length === 0) {
    return <div aria-label="Carregando histórico" className="skeleton h-32" role="status" />;
  }
  if (notFound || (!error && items.length === 0)) {
    return (
      <Empty>
        Sem eventos ainda.
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

  const sections = groupLeadEvents(items);
  return (
    <div>
      {sections.map((section) => (
        <section key={section.group} className={styles.group} aria-label={LEAD_EVENT_GROUP_LABELS[section.group]}>
          <h4 className={styles.groupTitle}>{LEAD_EVENT_GROUP_LABELS[section.group]}</h4>
          <ol className={styles.timeline}>
            {section.events.map((event, index) => (
              <LeadEventRow key={`${event.type}|${event.at}|${index}`} event={event} timezone={timezone} />
            ))}
          </ol>
        </section>
      ))}
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

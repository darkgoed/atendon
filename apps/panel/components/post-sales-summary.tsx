import { CalendarCheck, CalendarDots, CheckCircle, ClockCountdown, UsersThree } from "@phosphor-icons/react";
import React from "react";
import type { PostSaleSummary } from "../lib/post-sales";

export function PostSalesSummaryStrip({ summary }: { summary: PostSaleSummary }) {
  const items = [
    { label: "Carteira ativa", value: summary.active, Icon: UsersThree },
    { label: "Atrasados", value: summary.overdue, Icon: ClockCountdown, tone: summary.overdue ? "warn" : "" },
    { label: "Para hoje", value: summary.today, Icon: CalendarCheck },
    { label: "Próximos", value: summary.upcoming, Icon: CalendarDots },
    { label: "Completos", value: summary.complete, Icon: CheckCircle }
  ];
  return (
    <dl className="post-sales-summary" aria-label="Resumo da carteira">
      {items.map(({ label, value, Icon, tone }) => (
        <div key={label} data-tone={tone || undefined}>
          <dt><Icon size={15} aria-hidden="true" /> {label}</dt>
          <dd className="mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

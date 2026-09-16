import { readableDetails } from "@/lib/labels";

export function ReadableDetails({ details, emptyLabel = "Sem detalhes adicionais." }: { details?: Record<string, unknown> | null; emptyLabel?: string }) {
  const entries = readableDetails(details);

  if (entries.length === 0) {
    return <span className="text-xs text-[var(--text-muted)]">{emptyLabel}</span>;
  }

  return (
    <dl className="crm-detail-list">
      {entries.map((entry) => (
        <div key={entry.key} className="crm-detail-list__item">
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

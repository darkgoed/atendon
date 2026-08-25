import { readableDetails } from "@/lib/labels";

export function ReadableDetails({ details, emptyLabel = "Sem detalhes adicionais." }: { details?: Record<string, unknown> | null; emptyLabel?: string }) {
  const entries = readableDetails(details);

  if (entries.length === 0) {
    return <span className="text-xs text-[var(--faint)]">{emptyLabel}</span>;
  }

  return (
    <dl className="grid min-w-52 gap-2 text-xs">
      {entries.map((entry) => (
        <div key={entry.key} className="grid gap-0.5">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--faint)]">{entry.label}</dt>
          <dd className="break-words text-[var(--body)]">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

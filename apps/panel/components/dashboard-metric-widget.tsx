"use client";

export type DashboardMetricData = { value: number; currency?: "BRL" };
export type DashboardTeamItem = { member_id: string; name: string; value: number };
export type DashboardTeamData = { items: DashboardTeamItem[]; currency?: "BRL" };

function formatValue(value: number, currency?: "BRL") {
  if (currency === "BRL") {
    return (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  return value.toLocaleString("pt-BR");
}

export function DashboardMetricWidget({ data, percentage = false }: { data: DashboardMetricData; percentage?: boolean }) {
  const value = Number.isFinite(data.value) ? data.value : 0;
  return <p className="metric">{percentage ? `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : formatValue(value, data.currency)}</p>;
}

export function DashboardTeamWidget({ data, percentage = false }: { data: DashboardTeamData; percentage?: boolean }) {
  if (!data.items.length) return <p className="py-6 text-sm text-[var(--text-secondary)]">Nenhum resultado por equipe no período.</p>;
  return (
    <div className="space-y-2">
      {data.items.map((item) => (
        <div key={item.member_id} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2 last:border-b-0">
          <span className="truncate text-sm">{item.name}</span>
          <strong className="mono shrink-0 tabular-nums">{percentage ? `${Number(item.value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : formatValue(item.value, data.currency)}</strong>
        </div>
      ))}
    </div>
  );
}

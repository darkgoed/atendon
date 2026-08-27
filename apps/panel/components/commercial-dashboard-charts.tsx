import { Empty } from "@/components/page-state";
import type { CommercialDashboardSeries } from "@/lib/commercial-dashboard";

export function Sparkline({ values, tone = "var(--accent)", className = "mt-4 h-9 w-full" }: { values: number[]; tone?: string; className?: string }) {
  if (values.length < 2 || !values.some((value) => value > 0)) return null;
  const width = 140;
  const height = 34;
  const pad = 3;
  const maximum = Math.max(...values, 1);
  const points = values
    .map((value, index) => `${((index / (values.length - 1)) * width).toFixed(1)},${(height - pad - (value / maximum) * (height - pad * 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`color-mix(in srgb, ${tone} 16%, transparent)`} />
      <polyline points={points} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function RateRing({ value, tone }: { value: number; tone: string }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <svg viewBox="0 0 64 64" className="size-16 flex-none" role="img" aria-label={`${Math.round(clamped)}%`}>
      <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--active)" strokeWidth="5" />
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke={tone}
        strokeWidth="5"
        strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        transform="rotate(-90 32 32)"
        style={{ transition: "stroke-dasharray .6s cubic-bezier(.22,1,.36,1)" }}
      />
      <text x="32" y="36" textAnchor="middle" fill="var(--text)" fontSize="13" fontWeight="600" fontFamily="var(--font-mono)">
        {Math.round(clamped)}%
      </text>
    </svg>
  );
}

export function TrendChart({ data }: { data: CommercialDashboardSeries }) {
  const width = 760;
  const height = 230;
  const left = 42;
  const right = 18;
  const top = 18;
  const bottom = 36;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const maximum = Math.max(1, ...data.flatMap((item) => [item.scheduled, item.completed, item.no_show]));
  const x = (index: number) => left + (data.length <= 1 ? graphWidth / 2 : index * (graphWidth / (data.length - 1)));
  const y = (value: number) => top + graphHeight - (value / maximum) * graphHeight;
  const points = (key: "scheduled" | "completed" | "no_show") => data.map((item, index) => `${x(index)},${y(item[key])}`).join(" ");
  const tickEvery = Math.max(1, Math.ceil(data.length / 7));

  if (!data.length) return <Empty>Ainda não há dados neste período.</Empty>;

  return (
    <div className="overflow-x-auto" tabIndex={0} aria-label="Gráfico de evolução de calls">
      <svg className="min-w-[620px]" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Evolução de reuniões marcadas, realizadas e não comparecidas">
        {[0, 0.5, 1].map((ratio) => {
          const tickY = top + graphHeight * ratio;
          const value = Math.round(maximum * (1 - ratio));
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={tickY} y2={tickY} stroke="var(--border)" strokeDasharray="3 5" />
              <text x={left - 9} y={tickY + 4} textAnchor="end" fill="var(--faint)" fontSize="10">{value}</text>
            </g>
          );
        })}
        {data.map((item, index) => index % tickEvery === 0 || index === data.length - 1 ? (
          <text key={item.day} x={x(index)} y={height - 10} textAnchor="middle" fill="var(--faint)" fontSize="10">
            {new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${item.day}T12:00:00.000Z`))}
          </text>
        ) : null)}
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={points("scheduled")} />
        <polyline fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="7 5" points={points("completed")} />
        <polyline fill="none" stroke="var(--warn)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="2 4" points={points("no_show")} />
        {data.map((item, index) => (
          <g key={`${item.day}-points`}>
            <circle cx={x(index)} cy={y(item.scheduled)} r="3" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
            <circle cx={x(index)} cy={y(item.completed)} r="3" fill="var(--surface)" stroke="var(--ok)" strokeWidth="2" />
            <circle cx={x(index)} cy={y(item.no_show)} r="3" fill="var(--surface)" stroke="var(--warn)" strokeWidth="2" />
          </g>
        ))}
      </svg>
    </div>
  );
}

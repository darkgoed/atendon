"use client";

import { useId, useState, type MouseEvent } from "react";

const SPARK_WIDTH = 160;
const SPARK_HEIGHT = 56;
const SPARK_PAD = 4;

/**
 * Converte uma sequência de pontos em um path de curva suave
 * (Catmull-Rom → Bézier cúbica), sem "quinas" entre os dias.
 */
function smoothPath(points: Array<[number, number]>) {
  if (points.length < 3) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");
  }
  let path = `M ${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(index - 1, 0)];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[Math.min(index + 2, points.length - 1)];
    const control1X = current[0] + (next[0] - previous[0]) / 6;
    const control1Y = current[1] + (next[1] - previous[1]) / 6;
    const control2X = next[0] - (afterNext[0] - current[0]) / 6;
    const control2Y = next[1] - (afterNext[1] - current[1]) / 6;
    path += ` C ${control1X.toFixed(2)},${control1Y.toFixed(2)} ${control2X.toFixed(2)},${control2Y.toFixed(2)} ${next[0].toFixed(2)},${next[1].toFixed(2)}`;
  }
  return path;
}

/**
 * Mini gráfico de área para KPIs: curva suave, preenchimento com gradiente
 * vertical (opacidade 0.3 → 0.05) e ponto destacado com tooltip do valor no
 * hover. Tudo em SVG próprio — nenhuma dependência de charts.
 *
 * Acessibilidade: permanece `aria-hidden` — o valor numérico já é texto no card.
 * Séries sem dados (<2 pontos ou todos zeros) não renderizam nada.
 */
export function Sparkline({ values, tone = "var(--primary)", className = "mt-4 h-9 w-full" }: { values: number[]; tone?: string; className?: string }) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (values.length < 2 || !values.some((value) => value > 0)) return null;

  const maximum = Math.max(...values, 1);
  const points = values.map((value, index): [number, number] => [
    (index / (values.length - 1)) * SPARK_WIDTH,
    SPARK_HEIGHT - SPARK_PAD - (value / maximum) * (SPARK_HEIGHT - SPARK_PAD * 2)
  ]);
  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${SPARK_WIDTH},${SPARK_HEIGHT} L 0,${SPARK_HEIGHT} Z`;

  function handleMove(event: MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) : 0;
    setHoverIndex(Math.round(ratio * (values.length - 1)));
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredValue = hoverIndex !== null ? values[hoverIndex] : null;

  return (
    <div className={className} style={{ position: "relative" }} onMouseMove={handleMove} onMouseLeave={() => setHoverIndex(null)}>
      <svg viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} className="block h-full w-full" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity={0.3} />
            <stop offset="100%" stopColor={tone} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" stroke={tone} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        {hovered ? (
          <circle
            cx={hovered[0]}
            cy={hovered[1]}
            r={2.75}
            fill={tone}
            stroke="var(--surface-elevated, #fff)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {hovered && hoveredValue !== null ? (
        <span
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--text)] shadow-sm"
          style={{
            left: `${(hovered[0] / SPARK_WIDTH) * 100}%`,
            top: `${(hovered[1] / SPARK_HEIGHT) * 100}%`,
            transform: "translate(-50%, calc(-100% - 4px))"
          }}
        >
          {hoveredValue.toLocaleString("pt-BR")}
        </span>
      ) : null}
    </div>
  );
}

"use client";

import { useId } from "react";
import { useChartTokens, type ChartTokens } from "@/lib/use-chart-tokens";
import { ChartEmptyState } from "@/components/ui/chart";

export type FunnelStage = {
  label: string;
  value: number;
  /** Taxa de conversão vinda do estágio anterior (ex.: "42%"). Omitida no primeiro estágio. */
  conversionLabel?: string;
  tone?: "primary" | "success" | "warning" | "danger" | "info";
};

function toneColor(tokens: ChartTokens, tone: FunnelStage["tone"]) {
  switch (tone) {
    case "success": return tokens.success;
    case "warning": return tokens.warning;
    case "danger": return tokens.danger;
    case "info": return tokens.info;
    default: return tokens.primary;
  }
}

/**
 * Funil real em SVG: silhueta centralizada no meio do gráfico, cada estágio
 * com largura proporcional ao volume e afunilamento suave entre estágios.
 * Rótulo e valor ficam dentro do estágio quando couberem (silhueta larga) e
 * ao lado quando o estágio é estreito demais; a taxa de conversão aparece
 * entre estágios, sempre legível. Texto em SVG permanece alinhado ao formato
 * em qualquer viewport (viewBox escala) sem cortar.
 */
export function Funnel({ stages, height = 240, ariaLabel }: { stages: FunnelStage[]; height?: number; ariaLabel: string }) {
  const tokens = useChartTokens();
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!stages.length) return <ChartEmptyState />;

  const width = 640;
  const top = 6;
  const bottom = 6;
  const stageGap = 20;
  const plotHeight = height - top - bottom;
  const stageHeight = (plotHeight - stageGap * (stages.length - 1)) / stages.length;
  const maxValue = Math.max(...stages.map((s) => s.value), 1);
  const minRatio = 0.28;
  const shapeHalfWidth = width * 0.42;
  const cx = width / 2;

  const widthFor = (value: number) => (minRatio + (1 - minRatio) * (value / maxValue)) * shapeHalfWidth;

  return (
    <div role="img" aria-label={ariaLabel} className="funnel-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="funnel-chart__svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          {stages.map((stage, index) => {
            const color = toneColor(tokens, stage.tone);
            return (
              <linearGradient key={stage.label} id={`${gradientId}-${index}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                <stop offset="100%" stopColor={color} stopOpacity={0.08} />
              </linearGradient>
            );
          })}
        </defs>
        {stages.map((stage, index) => {
          const y = top + index * (stageHeight + stageGap);
          const currentHalf = widthFor(stage.value);
          const nextStage = stages[index + 1];
          const nextHalf = nextStage ? widthFor(nextStage.value) : currentHalf;
          const color = toneColor(tokens, stage.tone);
          const points = [
            `${cx - currentHalf},${y}`,
            `${cx + currentHalf},${y}`,
            `${cx + nextHalf},${y + stageHeight}`,
            `${cx - nextHalf},${y + stageHeight}`
          ].join(" ");
          const midY = y + stageHeight / 2;
          // Dentro da silhueta quando a largura comporta o rótulo; ao lado quando não couber.
          const inside = currentHalf * 2 >= 190;
          const labelSize = Math.min(12, Math.max(10, stageHeight * 0.28));
          const valueSize = Math.min(15, Math.max(12, stageHeight * 0.38));
          const textX = inside ? cx : cx + currentHalf + 10;
          const anchor = inside ? "middle" : "start";
          const twoLines = stageHeight >= 30;
          return (
            <g key={stage.label}>
              <polygon points={points} fill={`url(#${gradientId}-${index})`} stroke={color} strokeWidth={1.25} strokeOpacity={0.6} />
              {index > 0 && stage.conversionLabel ? (
                <text x={cx} y={y - stageGap / 2 + 3} textAnchor="middle" fontSize="10.5" fill={tokens.textMuted} fontFamily={tokens.fontMono}>
                  {stage.conversionLabel}
                </text>
              ) : null}
              {twoLines ? (
                <>
                  <text x={textX} y={midY - 3} textAnchor={anchor} fontSize={labelSize} fill={tokens.textSecondary} fontFamily={tokens.fontSans}>
                    {stage.label}
                  </text>
                  <text x={textX} y={midY + 13} textAnchor={anchor} fontSize={valueSize} fontWeight={600} fill={color} fontFamily={tokens.fontMono}>
                    {stage.value.toLocaleString("pt-BR")}
                  </text>
                </>
              ) : (
                <text x={textX} y={midY + valueSize / 3} textAnchor={anchor} fontSize={valueSize} fontWeight={600} fill={color} fontFamily={tokens.fontMono}>
                  {stage.label} · {stage.value.toLocaleString("pt-BR")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

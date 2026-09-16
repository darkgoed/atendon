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
 * Funil real em SVG: cada estágio é um trapézio cuja largura é proporcional
 * ao volume, com afunilamento suave entre estágios — não caixas empilhadas
 * do mesmo tamanho fingindo ser um funil. Rótulo, valor e taxa de conversão
 * são desenhados como texto SVG para permanecerem alinhados ao formato em
 * qualquer viewport, sem depender de uma grade CSS paralela.
 */
export function Funnel({ stages, height = 240, ariaLabel }: { stages: FunnelStage[]; height?: number; ariaLabel: string }) {
  const tokens = useChartTokens();
  const gradientId = useId();
  if (!stages.length) return <ChartEmptyState />;

  const width = 640;
  const top = 6;
  const bottom = 6;
  const stageGap = 4;
  const plotHeight = height - top - bottom;
  const stageHeight = (plotHeight - stageGap * (stages.length - 1)) / stages.length;
  const maxValue = Math.max(...stages.map((s) => s.value), 1);
  const minRatio = 0.32;
  const shapeHalfWidth = width * 0.34;
  const cx = width * 0.38;

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
          const textX = cx + shapeHalfWidth + 20;
          return (
            <g key={stage.label}>
              <polygon points={points} fill={`url(#${gradientId}-${index})`} stroke={color} strokeWidth={1.25} strokeOpacity={0.6} />
              {index > 0 && stage.conversionLabel ? (
                <text x={cx} y={y - stageGap / 2 + 3} textAnchor="middle" fontSize="10" fill={tokens.textMuted} fontFamily={tokens.fontMono}>
                  {stage.conversionLabel}
                </text>
              ) : null}
              <text x={textX} y={midY - 4} fontSize="12" fill={tokens.text} fontFamily={tokens.fontSans}>
                {stage.label}
              </text>
              <text x={textX} y={midY + 14} fontSize="15" fontWeight={600} fill={color} fontFamily={tokens.fontMono}>
                {stage.value.toLocaleString("pt-BR")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

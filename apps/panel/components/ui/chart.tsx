"use client";

import dynamic from "next/dynamic";
import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useChartTokens, type ChartTokens } from "@/lib/use-chart-tokens";
import { cn } from "@/lib/cn";

/**
 * echarts + echarts-for-react pesam ~500kB minificados. Importados direto,
 * eles entram no bundle de TODA página que toca `@/components/ui` (o barrel
 * export reexporta este módulo). `next/dynamic` com `ssr: false` isola a
 * biblioteca no seu próprio chunk, carregado só quando um gráfico realmente
 * renderiza — páginas sem dashboard não pagam esse peso.
 */
const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false, loading: () => <div className="chart-canvas__loading" aria-hidden="true" /> });

/**
 * Base chrome que todo gráfico ECharts do produto herda: fonte do design
 * system, grid enxuto, eixo discreto, tooltip no estilo popover do produto.
 * Cada componente de gráfico monta seu próprio `series`/`legend` em cima
 * disto — nunca use `ReactECharts` cru numa tela de produto.
 */
export function baseChartOption(tokens: ChartTokens): EChartsOption {
  return {
    textStyle: { fontFamily: tokens.fontSans, color: tokens.textSecondary },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: tokens.surfaceElevated,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: tokens.text, fontFamily: tokens.fontSans, fontSize: 12 },
      extraCssText: `border-radius: 7px; box-shadow: 0 8px 24px -8px rgb(16 24 40 / 0.14);`
    },
    axisPointer: { lineStyle: { color: tokens.borderSubtle } }
  };
}

export function axisLabelStyle(tokens: ChartTokens) {
  return { color: tokens.textMuted, fontFamily: tokens.fontSans, fontSize: 10.5 };
}

export type ChartProps = {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  ariaLabel: string;
};

/** Wrapper único de ECharts — todo gráfico do produto passa por aqui. */
export function Chart({ option, height = 240, className, ariaLabel }: ChartProps) {
  return (
    <div className={cn("chart-canvas", className)} role="img" aria-label={ariaLabel}>
      <ReactECharts
        option={option}
        style={{ height, width: "100%" }}
        notMerge
        lazyUpdate
        opts={{ renderer: "svg" }}
      />
    </div>
  );
}

/** Estado vazio padrão para qualquer superfície de gráfico do produto. */
export function ChartEmptyState({ message = "Sem dados neste período." }: { message?: string }) {
  return (
    <div className="chart-empty" role="status">
      <span className="chart-empty__icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path d="M4 19V5M4 19h16M8 15v-4M12 15V7M16 15v-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <p>{message}</p>
    </div>
  );
}

export type SeriesPoint = { x: string; [key: string]: string | number };
export type LineSeriesDef = { key: string; label: string; tone?: "primary" | "success" | "warning" | "danger" | "info"; area?: boolean };

/**
 * Gráfico de linha/área multi-série. Substitui o polyline artesanal por um
 * componente com tooltip real, legenda interativa (clique para isolar série)
 * e formatação de eixo consistente com o restante do produto.
 */
export function LineAreaChart({
  data,
  series,
  height = 240,
  ariaLabel,
  xLabelFormatter
}: {
  data: SeriesPoint[];
  series: LineSeriesDef[];
  height?: number;
  ariaLabel: string;
  xLabelFormatter?: (value: string) => string;
}) {
  const tokens = useChartTokens();
  const option = useMemo<EChartsOption>(() => {
    const toneColor: Record<NonNullable<LineSeriesDef["tone"]>, string> = {
      primary: tokens.primary,
      success: tokens.success,
      warning: tokens.warning,
      danger: tokens.danger,
      info: tokens.info
    };
    return {
      ...baseChartOption(tokens),
      legend: series.length > 1 ? {
        top: 0,
        right: 0,
        icon: "roundRect",
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 16,
        textStyle: { color: tokens.textMuted, fontSize: 11.5, fontFamily: tokens.fontSans }
      } : undefined,
      grid: { left: 4, right: 8, top: series.length > 1 ? 30 : 12, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: data.map((point) => point.x),
        boundaryGap: false,
        axisLine: { lineStyle: { color: tokens.border } },
        axisTick: { show: false },
        axisLabel: { ...axisLabelStyle(tokens), formatter: xLabelFormatter }
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: tokens.borderSubtle, type: "dashed" } },
        axisLabel: axisLabelStyle(tokens),
        axisLine: { show: false },
        axisTick: { show: false }
      },
      series: series.map((definition) => ({
        name: definition.label,
        type: "line",
        smooth: 0.25,
        symbol: "circle",
        symbolSize: 6,
        showSymbol: data.length <= 14,
        color: toneColor[definition.tone ?? "primary"],
        lineStyle: { width: 2.25 },
        areaStyle: definition.area ? { opacity: 0.1 } : undefined,
        data: data.map((point) => point[definition.key] as number)
      }))
    };
  }, [data, series, tokens, xLabelFormatter]);

  if (!data.length) return <ChartEmptyState />;
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
}

export type DonutSlice = { label: string; value: number; tone?: "primary" | "success" | "warning" | "danger" | "info" | "neutral" };

/**
 * Donut compacto para composição/participação. Centro exibe o total ou um
 * rótulo, como no RateRing anterior, mas com tooltip e legenda reais.
 */
export function DonutChart({
  data,
  height = 200,
  ariaLabel,
  centerLabel,
  centerValue
}: {
  data: DonutSlice[];
  height?: number;
  ariaLabel: string;
  centerLabel?: string;
  centerValue?: string;
}) {
  const tokens = useChartTokens();
  const option = useMemo<EChartsOption>(() => {
    const toneColor: Record<NonNullable<DonutSlice["tone"]>, string> = {
      primary: tokens.primary,
      success: tokens.success,
      warning: tokens.warning,
      danger: tokens.danger,
      info: tokens.info,
      neutral: tokens.textSubtle
    };
    return {
      ...baseChartOption(tokens),
      tooltip: { ...baseChartOption(tokens).tooltip, trigger: "item" },
      legend: {
        orient: "vertical",
        right: 0,
        top: "middle",
        icon: "circle",
        itemWidth: 7,
        itemHeight: 7,
        itemGap: 10,
        textStyle: { color: tokens.textSecondary, fontSize: 11.5, fontFamily: tokens.fontSans }
      },
      series: [{
        type: "pie",
        radius: ["62%", "82%"],
        center: ["32%", "50%"],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
        data: data.map((slice) => ({ name: slice.label, value: slice.value, itemStyle: { color: toneColor[slice.tone ?? "neutral"] } }))
      }]
    };
  }, [data, tokens]);

  if (!data.length || data.every((slice) => slice.value === 0)) return <ChartEmptyState />;
  return (
    <div className="donut-chart" style={{ height }}>
      <Chart option={option} height={height} ariaLabel={ariaLabel} className="donut-chart__canvas" />
      {(centerLabel || centerValue) ? (
        <div className="donut-chart__center" aria-hidden="true">
          {centerValue ? <strong>{centerValue}</strong> : null}
          {centerLabel ? <span>{centerLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export type BarDatum = { label: string; value: number; tone?: "primary" | "success" | "warning" | "danger" | "info" };

/** Barras horizontais para comparativos (equipe, closers, origem). */
export function BarComparisonChart({
  data,
  height,
  ariaLabel,
  valueFormatter
}: {
  data: BarDatum[];
  height?: number;
  ariaLabel: string;
  valueFormatter?: (value: number) => string;
}) {
  const tokens = useChartTokens();
  const resolvedHeight = height ?? Math.max(120, data.length * 34 + 24);
  const option = useMemo<EChartsOption>(() => {
    const toneColor: Record<NonNullable<BarDatum["tone"]>, string> = {
      primary: tokens.primary,
      success: tokens.success,
      warning: tokens.warning,
      danger: tokens.danger,
      info: tokens.info
    };
    const ordered = [...data].reverse();
    return {
      ...baseChartOption(tokens),
      tooltip: {
        trigger: "item",
        backgroundColor: tokens.surfaceElevated,
        borderColor: tokens.border,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: tokens.text, fontFamily: tokens.fontSans, fontSize: 12 },
        extraCssText: "border-radius: 7px; box-shadow: 0 8px 24px -8px rgb(16 24 40 / 0.14);",
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : params;
          const name = (p as { name?: string })?.name ?? "";
          const value = (p as { value?: number })?.value ?? 0;
          return `${name}: <strong>${valueFormatter ? valueFormatter(value) : value}</strong>`;
        }
      },
      grid: { left: 4, right: 16, top: 4, bottom: 4, containLabel: true },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: tokens.borderSubtle, type: "dashed" } },
        axisLabel: { ...axisLabelStyle(tokens), formatter: valueFormatter },
        axisLine: { show: false },
        axisTick: { show: false }
      },
      yAxis: {
        type: "category",
        data: ordered.map((item) => item.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...axisLabelStyle(tokens), fontSize: 11.5, color: tokens.textSecondary }
      },
      series: [{
        type: "bar",
        barWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        data: ordered.map((item) => ({ value: item.value, itemStyle: { color: toneColor[item.tone ?? "primary"] } }))
      }]
    };
  }, [data, tokens, valueFormatter]);

  if (!data.length) return <ChartEmptyState />;
  return <Chart option={option} height={resolvedHeight} ariaLabel={ariaLabel} />;
}

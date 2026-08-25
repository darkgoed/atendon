export type CommercialDashboardSeries = Array<{
  day: string;
  scheduled: number;
  completed: number;
  no_show: number;
  cancelled: number;
}>;

// Tendência = 2ª metade vs 1ª metade do período; comparação anterior exigiria backend.
export function trendDelta(series: CommercialDashboardSeries, key: keyof CommercialDashboardSeries[number] & ("scheduled" | "completed" | "no_show" | "cancelled") = "scheduled") {
  if (series.length < 2) return null;
  const half = Math.floor(series.length / 2);
  const first = series.slice(0, half).reduce((sum, item) => sum + item[key], 0);
  const last = series.slice(half).reduce((sum, item) => sum + item[key], 0);
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

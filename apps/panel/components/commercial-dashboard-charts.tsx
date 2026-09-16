export function Sparkline({ values, tone = "var(--primary)", className = "mt-4 h-9 w-full" }: { values: number[]; tone?: string; className?: string }) {
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

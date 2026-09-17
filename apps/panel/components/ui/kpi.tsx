"use client";

import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type KpiTone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

export type KpiCardProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  icon?: ReactNode;
  delta?: { value: number; label?: string } | null;
  spark?: ReactNode;
};

/**
 * KPI compacto: um número por card, sem moldura interna extra. Reserva
 * espaço para trend/sparkline apenas quando fornecido, então um KPI sem
 * série não fica alto e vazio como um card genérico.
 *
 * Semântica: `dt`/`dd` são filhos diretos do card (um grid os posiciona
 * lado a lado com o ícone) — rótulo e valor de uma métrica formam um par
 * termo/descrição de verdade, não texto solto com estilo de rótulo.
 */
export const KpiCard = forwardRef<HTMLDivElement, KpiCardProps>(function KpiCard(
  { label, value, hint, tone = "neutral", icon, delta, spark, className, ...props },
  ref
) {
  return (
    <div {...props} ref={ref} className={cn("kpi-card", className)}>
      <dt className="kpi-card__label">{label}</dt>
      {icon ? <span className={cn("kpi-card__icon", tone !== "neutral" && `kpi-card__icon--${tone}`)} aria-hidden="true">{icon}</span> : null}
      <dd className="kpi-card__dd">
        {spark ? (
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="kpi-card__body">
                <span className={cn("kpi-card__value", tone !== "neutral" && `kpi-card__value--${tone}`)}>{value}</span>
                {delta ? (
                  <span
                    className={cn("kpi-card__delta", delta.value >= 0 ? "kpi-card__delta--up" : "kpi-card__delta--down")}
                    title={delta.label}
                  >
                    {delta.value >= 0 ? "\u2191" : "\u2193"} {Math.abs(delta.value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                  </span>
                ) : null}
              </div>
              {hint ? <p className="kpi-card__hint">{hint}</p> : null}
            </div>
            <div className="h-14 w-2/5 max-w-40 shrink-0 self-end">{spark}</div>
          </div>
        ) : (
          <>
            <div className="kpi-card__body">
              <span className={cn("kpi-card__value", tone !== "neutral" && `kpi-card__value--${tone}`)}>{value}</span>
              {delta ? (
                <span
                  className={cn("kpi-card__delta", delta.value >= 0 ? "kpi-card__delta--up" : "kpi-card__delta--down")}
                  title={delta.label}
                >
                  {delta.value >= 0 ? "\u2191" : "\u2193"} {Math.abs(delta.value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                </span>
              ) : null}
            </div>
            {hint ? <p className="kpi-card__hint">{hint}</p> : null}
          </>
        )}
      </dd>
    </div>
  );
});

export type KpiGridProps = HTMLAttributes<HTMLDListElement>;

/** Grade responsiva para um conjunto de KpiCard — 2 a 6 por linha conforme viewport. */
export const KpiGrid = forwardRef<HTMLDListElement, KpiGridProps>(function KpiGrid({ className, ...props }, ref) {
  return <dl {...props} ref={ref} className={cn("kpi-grid", className)} />;
});

"use client";

import { ArrowRight, CalendarBlank, Clock, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import type { DragEvent } from "react";
import { LeadTagChips } from "@/components/lead-tag-picker";
import {
  formatPipelineAge,
  isOverdueFollowUp,
  type PipelineLead,
  type PipelinePreferences
} from "@/lib/pipeline";

const outcomeLabels: Record<string, string> = {
  fechado: "Venda fechada",
  proposta_enviada: "Proposta enviada",
  em_negociacao: "Em negociação",
  follow_up: "Follow-up",
  nao_avancou: "Não avançou"
};

function formatDateTime(value: string, timezone?: string): string {
  try {
    return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", ...(timezone ? { timeZone: timezone } : {}) });
  } catch {
    return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }
}

function shortIdentity(value?: string | null): string {
  return value?.split("@")[0] ?? "Não atribuído";
}

function ownerInitials(value?: string | null): string {
  const identity = shortIdentity(value).replace(/[._-]+/g, " ");
  const words = identity.split(/\s+/).filter(Boolean);
  return `${words[0]?.[0] ?? "?"}${words.length > 1 ? words.at(-1)?.[0] ?? "" : words[0]?.[1] ?? ""}`.toLocaleUpperCase("pt-BR");
}

function qualificationScore(stars?: number): "A" | "B" | "C" {
  if ((stars ?? 0) >= 4) return "A";
  if ((stars ?? 0) >= 3) return "B";
  return "C";
}

function actionTiming(value?: string | null): "overdue" | "urgent" | "future" {
  if (!value) return "future";
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining < 0) return "overdue";
  return remaining <= 86_400_000 ? "urgent" : "future";
}

export function PipelineCard({
  lead,
  selected,
  canSelect,
  canMove,
  pending,
  preferences,
  timezone,
  onToggleSelected,
  onMove,
  onDragStart,
  onDragEnd
}: {
  lead: PipelineLead;
  selected: boolean;
  canSelect: boolean;
  canMove: boolean;
  pending: boolean;
  preferences: PipelinePreferences;
  timezone?: string;
  onToggleSelected: () => void;
  onMove: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const visible = (field: PipelinePreferences["visibleFields"][number]) => preferences.visibleFields.includes(field);
  const badgeVisible = (badge: PipelinePreferences["auxiliaryBadges"][number]) => preferences.auxiliaryBadges.includes(badge);
  const resultPending = lead.latest_appointment?.result_pending
    ?? Boolean(lead.latest_appointment?.result_pending_at);
  const overdue = isOverdueFollowUp(lead);
  const currentResponsible = lead.recovery_required
    ? lead.recovery_email ?? lead.sdr_email ?? lead.responsavel_email
    : lead.closer_email ?? lead.sdr_email ?? lead.responsavel_email;
  const compact = preferences.density === "compact";
  const score = qualificationScore(lead.qualificacao?.estrelas);
  const actionStatus = actionTiming(lead.proxima_acao_em);
  const company = lead.unidade_nome ?? lead.origem ?? lead.campanha ?? "Empresa não informada";

  return (
    <article
      draggable={canMove && !pending}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={pending}
      className={`pipeline-card group border ${selected ? "border-[var(--primary)]" : "border-[var(--border)]"} ${canMove && !pending ? "cursor-grab active:cursor-grabbing" : ""} ${pending ? "opacity-60" : ""} ${compact ? "p-2" : "p-2.5"}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        {canSelect ? <input type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Selecionar ${lead.nome ?? lead.telefone}`} disabled={pending} /> : null}
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[12.5px] font-semibold leading-[1.35]">{lead.nome ?? "Sem nome"}</strong>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--text-6)]" title={company}>{company}</span>
        </div>
        {visible("ownership") ? <span className="pipeline-card__owner" title={`Responsável: ${shortIdentity(currentResponsible)}`} aria-label={`Responsável: ${shortIdentity(currentResponsible)}`}>{ownerInitials(currentResponsible)}</span> : null}
        {lead.qualificacao?.requer_decisao_humana ? <WarningCircle size={16} className="shrink-0 text-[var(--warn)]" aria-label="Requer decisão humana" /> : null}
      </div>

      {(badgeVisible("resultPending") && resultPending) || (badgeVisible("recovery") && lead.recovery_required) || (badgeVisible("overdueFollowUp") && overdue) ? (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="Alertas operacionais">
          {badgeVisible("resultPending") && resultPending ? <span className="rounded border border-[var(--warn-border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--warn)]">Resultado pendente</span> : null}
          {badgeVisible("recovery") && lead.recovery_required ? <span className="rounded border border-[var(--warn-border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--warn)]">Recuperar no-show</span> : null}
          {badgeVisible("overdueFollowUp") && overdue ? <span className="rounded border border-[var(--warn-border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--warn)]">Follow-up atrasado</span> : null}
        </div>
      ) : null}

      {visible("origin") && (lead.origem || lead.campanha) ? (
        <p className="mt-2 truncate text-[10px] text-[var(--muted)]" title={[lead.origem, lead.campanha].filter(Boolean).join(" · ")}>
          {[lead.origem, lead.campanha].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      <div className="mt-2 flex min-w-0 items-center gap-2">
        <span className="mono min-w-0 truncate text-[12px] font-medium text-[var(--text)]">{lead.sale_value != null ? lead.sale_value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "Valor não informado"}</span>
        {visible("qualification") && lead.qualificacao ? <span className="pipeline-card__score" data-score={score} aria-label={`${lead.qualificacao.estrelas} de 5 na qualificação`}>{score}</span> : null}
      </div>

      {visible("nextMeeting") && lead.latest_appointment ? (
        <div className="mt-2 flex items-start gap-1.5 text-[10px] text-[var(--body)]">
          <CalendarBlank className="mt-px shrink-0 text-[var(--faint)]" size={13} aria-hidden="true" />
          <span className="min-w-0"><span className="block truncate">{formatDateTime(lead.latest_appointment.start, timezone)}</span><span className="block text-[9px] text-[var(--faint)]">{lead.latest_appointment.status.replaceAll("_", " ")}</span></span>
        </div>
      ) : null}

      {visible("nextAction") && lead.proxima_acao ? (
        <div className="pipeline-card__next" data-status={actionStatus}>
          <span className="pipeline-card__action-dot" aria-hidden="true" />
          <strong className="min-w-0 flex-1 truncate text-[10.5px] font-medium">{lead.proxima_acao}</strong>
          {lead.proxima_acao_em ? <time className="mono shrink-0 text-[10px] font-medium">{formatDateTime(lead.proxima_acao_em, timezone)}</time> : null}
        </div>
      ) : null}

      {lead.commercial_outcome ? <p className="mt-2 truncate text-[10px] font-medium text-[var(--accent-soft)]">{outcomeLabels[lead.commercial_outcome] ?? lead.commercial_outcome.replaceAll("_", " ")}{lead.sale_value ? ` · ${lead.sale_value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}</p> : null}

      {lead.tags?.length ? <div className="pipeline-card__tags mt-2"><LeadTagChips tags={lead.tags} compact /></div> : null}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2">
        <span className="flex shrink-0 items-center gap-1">
          {canMove ? <button type="button" className="min-h-8 rounded px-2 text-[10px] font-medium text-[var(--accent-soft)] hover:bg-[var(--active)] active:scale-[.96]" onClick={onMove} disabled={pending}>Mover</button> : null}
          <Link className="flex min-h-8 items-center gap-1 rounded px-2 text-[10px] text-[var(--accent-soft)] hover:bg-[var(--active)] active:scale-[.96]" href={`/leads/${lead.id}`}>Detalhes <ArrowRight size={11} aria-hidden="true" /></Link>
        </span>
        {visible("stalled") ? <time className="mono ml-auto inline-flex items-center gap-1 text-[9px] text-[var(--text-8)]" dateTime={lead.atualizado_em}><Clock size={10} aria-hidden="true" />{formatPipelineAge(lead.atualizado_em)}</time> : <span />}
      </div>
    </article>
  );
}

"use client";

import { ArrowRight, CalendarBlank, Clock, WhatsappLogo } from "@phosphor-icons/react";
import Link from "next/link";
import type { DragEvent } from "react";

import {
  formatPipelineAge,
  isOverdueFollowUp,
  pipelineStatusLabel,
  type PipelineLead,
  type PipelinePreferences
} from "@/lib/pipeline";


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
          <strong className="pipeline-card__name">{lead.nome ?? "Sem nome"}</strong>
          <span className="pipeline-card__interest" title={lead.interesse ?? undefined}>Interesse: {lead.interesse ?? "Não informado"}</span>
        </div>
        <span className="pipeline-card__owner" title={`Responsável: ${shortIdentity(currentResponsible)}`} aria-label={`Responsável: ${shortIdentity(currentResponsible)}`}>{ownerInitials(currentResponsible)}</span>

      </div>

      {(badgeVisible("resultPending") && resultPending) || (badgeVisible("recovery") && lead.recovery_required) || (badgeVisible("overdueFollowUp") && overdue) ? (
        <div className="pipeline-card__alerts" aria-label="Alertas operacionais">
          {badgeVisible("resultPending") && resultPending ? <span className="pipeline-alert">Resultado pendente</span> : null}
          {badgeVisible("recovery") && lead.recovery_required ? <span className="pipeline-alert">Recuperar no-show</span> : null}
          {badgeVisible("overdueFollowUp") && overdue ? <span className="pipeline-alert">Follow-up atrasado</span> : null}
        </div>
      ) : null}

      {visible("origin") && (lead.origem || lead.campanha) ? (
        <p className="pipeline-card__origin" title={[lead.origem, lead.campanha].filter(Boolean).join(" · ")}>
          {[lead.origem, lead.campanha].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      {lead.situacao ? <span className="pipeline-card__situation">Situação: {pipelineStatusLabel(lead.situacao)}</span> : null}

      {visible("qualification") && lead.qualificacao ? <div className="mt-2"><span className="pipeline-card__score" data-score={score} aria-label={`${lead.qualificacao.estrelas} de 5 na qualificação`}>{score}</span></div> : null}

      {visible("nextMeeting") && lead.latest_appointment ? (
        <div className="pipeline-card__meeting">
          <CalendarBlank className="mt-px shrink-0 text-[var(--text-muted)]" size={13} aria-hidden="true" />
          <span className="min-w-0"><span className="block truncate">{formatDateTime(lead.latest_appointment.start, timezone)}</span><span className="pipeline-card__meeting-status">{lead.latest_appointment.status.replaceAll("_", " ")}</span></span>
        </div>
      ) : null}

      {visible("nextAction") && lead.proxima_acao ? (
        <div className="pipeline-card__next" data-status={actionStatus}>
          <span className="pipeline-card__action-dot" aria-hidden="true" />
          <strong className="pipeline-card__action truncate">{lead.proxima_acao}</strong>
          {lead.proxima_acao_em ? <time className="mono shrink-0">{formatDateTime(lead.proxima_acao_em, timezone)}</time> : null}
        </div>
      ) : null}


      <div className="pipeline-card__footer">
        <span className="pipeline-card__footer-actions">
          {canMove ? <button type="button" className="crm-inline-action" onClick={onMove} disabled={pending}>Mover</button> : null}
          <Link className="pipeline-card__link" href={`/contatos/${lead.id}`}>Detalhes <ArrowRight size={11} aria-hidden="true" /></Link>
          {lead.conversation_id ? (
            <Link
              className="crm-inline-action flex items-center gap-1"
              href={`/conversas?id=${encodeURIComponent(lead.conversation_id)}`}
              aria-label={`Conversar com ${lead.nome ?? lead.telefone} pelo WhatsApp`}
              title={`Conversar com ${lead.nome ?? lead.telefone}`}
            >
              <WhatsappLogo size={13} weight="bold" aria-hidden="true" /> Conversar
            </Link>
          ) : null}
        </span>
        {visible("stalled") ? <time className="pipeline-card__age" dateTime={lead.atualizado_em}><Clock size={10} aria-hidden="true" />{formatPipelineAge(lead.atualizado_em)}</time> : <span />}
      </div>
    </article>
  );
}

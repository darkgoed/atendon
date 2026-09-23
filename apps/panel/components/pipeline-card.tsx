"use client";

import { ArrowRight, ArrowSquareOut, CalendarBlank, ChatsCircle, Clock } from "@/components/icons";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import {
  formatPipelineAge,
  isOverdueFollowUp,
  pipelineStatusLabel,
  type PipelineLead,
  type PipelinePreferences
} from "@/lib/pipeline";

/*
  Mesma mola dos vizinhos no quadro (referência): cards deslizam para o lugar
  com FLOW_SPRING; reduce-motion troca mola por duração zero.
*/
const FLOW_SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;

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
  grabbed = false,
  floating = false,
  onToggleSelected,
  onMove,
  onGrabPointerDown,
  onGrabKeyDown
}: {
  lead: PipelineLead;
  selected: boolean;
  canSelect: boolean;
  canMove: boolean;
  pending: boolean;
  preferences: PipelinePreferences;
  timezone?: string;
  /** Captura por teclado em curso (anel de destaque). */
  grabbed?: boolean;
  /** Cópia no overlay que segue o cursor (sem foco, sem handlers). */
  floating?: boolean;
  onToggleSelected: () => void;
  onMove: () => void;
  onGrabPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onGrabKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
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
  const localReduceMotion = useReducedMotion() ?? false;
  const interactive = canMove && !pending && !floating;

  return (
    <motion.article
      layout={!floating}
      data-pipeline-card={lead.id}
      tabIndex={interactive ? 0 : undefined}
      aria-roledescription={interactive ? "Card arrastável" : undefined}
      aria-grabbed={interactive ? grabbed : undefined}
      aria-label={interactive ? `${lead.nome ?? "Lead"}. Pressione espaço para pegar, use as setas para escolher a etapa e espaço para soltar.` : undefined}
      aria-busy={pending || undefined}
      aria-hidden={floating || undefined}
      onPointerDown={interactive ? onGrabPointerDown : undefined}
      onKeyDown={onGrabKeyDown}
      transition={localReduceMotion ? { duration: 0 } : FLOW_SPRING}
      whileHover={interactive && !localReduceMotion ? { y: -2 } : undefined}
      className={`pipeline-card group border ${selected ? "border-[var(--primary)]" : "border-[var(--border)]"} ${interactive ? "cursor-grab active:cursor-grabbing touch-none" : ""} ${pending ? "opacity-60" : ""} ${grabbed ? "pipeline-card--grabbed" : ""} ${floating ? "pipeline-card--floating" : ""} ${compact ? "p-2" : "p-2.5"}`}
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
          {canMove ? (
            <button type="button" className="pipeline-card__icon-action" onClick={onMove} disabled={pending} aria-label="Mover" title="Avançar etapa">
              <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
          {lead.conversation_id ? (
            <Link
              className="pipeline-card__icon-action"
              href={`/conversas?id=${encodeURIComponent(lead.conversation_id)}`}
              aria-label={`Conversar com ${lead.nome ?? lead.telefone} pelo WhatsApp`}
              title="Conversar"
            >
              <ChatsCircle size={13} strokeWidth={2} aria-hidden="true" />
            </Link>
          ) : null}
          <Link className="pipeline-card__icon-action" href={`/contatos/${lead.id}`} aria-label="Detalhes" title="Detalhes">
            <ArrowSquareOut size={13} strokeWidth={2} aria-hidden="true" />
          </Link>
        </span>
        {visible("stalled") ? <time className="pipeline-card__age" dateTime={lead.atualizado_em}><Clock size={10} aria-hidden="true" />{formatPipelineAge(lead.atualizado_em)}</time> : <span />}
      </div>
    </motion.article>
  );
}

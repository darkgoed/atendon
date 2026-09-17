"use client";

import { ArrowClockwise, DotsThree } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { PipelineCard } from "@/components/pipeline-card";
import {
  pipelineBoardStageId,
  type PipelineLead,
  type PipelinePreferences,
  type PipelineStage
} from "@/lib/pipeline";

function pipelineColumnWidth(width: PipelinePreferences["columnWidth"]): number {
  return width === 280 ? 272 : width;
}

export function pipelineStageAutomationLabel(stage: Pick<PipelineStage, "operational_kind">): string {
  if (stage.operational_kind === "ai_follow_up") return "IA";
  if (stage.operational_kind === "call") return "Ligação";
  return "Manual";
}

function stageTone(stage: PipelineStage): string {
  if (stage.operational_kind === "ai_follow_up") return "var(--info)";
  if (stage.operational_kind === "call") return "var(--danger)";
  return {
    novo: "var(--text-muted)",
    em_atendimento: "var(--info)",
    aguardando_resposta: "var(--warning)",
    qualificado: "var(--primary)",
    agendado: "var(--cat-3-text)",
    em_negociacao: "var(--danger)",
    proposta_enviada: "var(--warning)",
    follow_up: "var(--info)",
    fechado: "var(--success)",
    perdido: "var(--danger)"
  }[stage.technical_status] ?? "var(--text-muted)";
}

function formatStageValue(leads: PipelineLead[]): string {
  return leads.reduce((total, lead) => total + (lead.sale_value ?? 0), 0)
    .toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function formatAverageStageAge(leads: PipelineLead[]): string {
  if (leads.length === 0) return "média —";
  const now = Date.now();
  const averageHours = leads.reduce((total, lead) => total + Math.max(0, now - new Date(lead.atualizado_em).getTime()), 0) / leads.length / 3_600_000;
  if (averageHours < 24) return `média ${Math.max(1, Math.round(averageHours))}h`;
  return `média ${Math.max(1, Math.round(averageHours / 24))}d`;
}

export function horizontalWheelDelta(event: Pick<WheelEvent, "deltaX" | "deltaY">): number {
  if (Number.isFinite(event.deltaX) && event.deltaX !== 0) return event.deltaX;
  return Number.isFinite(event.deltaY) ? event.deltaY : 0;
}

export function PipelineBoard({
  stages,
  leads,
  allowedTransitions,
  legacy,
  showAllStages = false,
  loading,
  loadError,
  hasActiveFilters,
  canMove,
  canSelect,
  selectedIds,
  pendingLeadIds,
  preferences,
  timezone,
  columnLoadMore,
  onColumnLoadMore,
  onToggleSelected,
  onMoveRequest,
  onRetry
}: {
  stages: PipelineStage[];
  leads: PipelineLead[];
  allowedTransitions: Set<string>;
  legacy: boolean;
  showAllStages?: boolean;
  loading: boolean;
  loadError?: string;
  hasActiveFilters: boolean;
  canMove: boolean;
  canSelect: boolean;
  selectedIds: Set<string>;
  pendingLeadIds: Set<string>;
  preferences: PipelinePreferences;
  timezone?: string;
  columnLoadMore?: Map<string, { remaining: number | null; loading: boolean; visible: boolean }>;
  onColumnLoadMore?: (stage: PipelineStage) => void;
  onToggleSelected: (leadId: string) => void;
  onMoveRequest: (lead: PipelineLead, target?: PipelineStage) => void;
  onRetry: () => void;
}) {
  const [dragging, setDragging] = useState<PipelineLead | null>(null);
  const [dropStageId, setDropStageId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const boardRef = useRef<HTMLElement | null>(null);
  const leadsByStage = useMemo(() => new Map(stages.map((stage) => [
    stage.id,
    leads.filter((lead) => pipelineBoardStageId(lead, stages, showAllStages) === stage.id)
  ])), [leads, showAllStages, stages]);
  const draggingStageId = dragging
    ? legacy ? `fallback:${dragging.status}` : dragging.pipeline_stage_id ?? null
    : null;

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const handleBoardWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return;
      const delta = horizontalWheelDelta(event);
      if (delta === 0) return;
      event.preventDefault();
      board.scrollLeft += delta;
    };
    board.addEventListener("wheel", handleBoardWheel, { passive: false });
    return () => board.removeEventListener("wheel", handleBoardWheel);
  }, []);

  function startDrag(event: DragEvent<HTMLElement>, lead: PipelineLead) {
    event.dataTransfer.setData("text/plain", lead.id);
    event.dataTransfer.effectAllowed = "move";
    setDragging(lead);
    setLiveStatus(`${lead.nome ?? "Lead"} selecionado para movimentação. Escolha uma etapa permitida.`);
  }

  function finishDrag() {
    setDragging(null);
    setDropStageId(null);
  }

  if (loadError && leads.length === 0 && !loading) {
    return (
      <section className="grid min-h-64 flex-1 place-items-center border border-dashed border-[var(--warning-border)] p-6 text-center" aria-label="Erro no quadro de pipeline">
        <div className="max-w-md">
          <strong className="text-sm">Não foi possível carregar o pipeline</strong>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{loadError}</p>
          <button type="button" className="btn primary mt-4 active:scale-[.98]" onClick={onRetry}><ArrowClockwise size={15} aria-hidden="true" />Tentar novamente</button>
        </div>
      </section>
    );
  }

  if (!loading && stages.length === 0) {
    return <section className="grid min-h-64 flex-1 place-items-center border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-secondary)]">Nenhuma etapa ativa no pipeline. Abra “Configurar” para revisar as etapas.</section>;
  }

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">{liveStatus}</p>
      <section ref={boardRef} className="pipeline-board overflow-x-auto overflow-y-hidden overscroll-contain" aria-label="Quadro de pipeline" tabIndex={0}>
        {loading && stages.length === 0
          ? [1, 2, 3, 4].map((item) => <PipelineColumnSkeleton key={item} width={pipelineColumnWidth(preferences.columnWidth)} />)
          : stages.map((stage) => {
            const items = leadsByStage.get(stage.id) ?? [];
            const transitionTargetId = stage.operational_source_stage_id ?? stage.id;
            const droppable = Boolean(stage.operational_kind !== "ai_follow_up" && dragging && canMove && draggingStageId && allowedTransitions.has(`${draggingStageId}:${transitionTargetId}`));
            return (
              <PipelineColumn
                key={stage.id}
                stage={stage}
                leads={items}
                loading={loading}
                canMove={canMove}
                canSelect={canSelect}
                selectedIds={selectedIds}
                pendingLeadIds={pendingLeadIds}
                preferences={preferences}
                timezone={timezone}
                dragging={dragging}
                droppable={droppable}
                dropActive={dropStageId === stage.id}
                loadMore={columnLoadMore?.get(stage.id)}
                onLoadMore={onColumnLoadMore ? () => onColumnLoadMore(stage) : undefined}
                onDragStart={startDrag}
                onDragEnd={finishDrag}
                onDragEnter={() => {
                  if (!droppable) return;
                  setDropStageId(stage.id);
                  setLiveStatus(`Etapa ${stage.name} disponível. Solte para mover ${dragging?.nome ?? "o lead"}.`);
                }}
                onDragLeave={() => setDropStageId((current) => current === stage.id ? null : current)}
                onDrop={() => {
                  if (dragging && droppable) {
                    setLiveStatus(`${dragging.nome ?? "Lead"}: movimento para ${stage.name} solicitado.`);
                    onMoveRequest(dragging, stage);
                  }
                  finishDrag();
                }}
                onToggleSelected={onToggleSelected}
                onMoveRequest={onMoveRequest}
              />
            );
          })}
      </section>
      {!loading && leads.length === 0 && stages.length > 0 ? (
        <p className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-2 text-xs text-[var(--text-secondary)]" role="status">
          {hasActiveFilters ? "Nenhum lead corresponde aos filtros atuais." : "O pipeline ainda não possui leads."}
        </p>
      ) : null}
    </>
  );
}

export function PipelineColumn({
  stage,
  leads,
  loading,
  canMove,
  canSelect,
  selectedIds,
  pendingLeadIds,
  preferences,
  timezone,
  dragging,
  droppable,
  dropActive,
  loadMore,
  onLoadMore,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDragLeave,
  onDrop,
  onToggleSelected,
  onMoveRequest
}: {
  stage: PipelineStage;
  leads: PipelineLead[];
  loading: boolean;
  canMove: boolean;
  canSelect: boolean;
  selectedIds: Set<string>;
  pendingLeadIds: Set<string>;
  preferences: PipelinePreferences;
  timezone?: string;
  dragging: PipelineLead | null;
  droppable: boolean;
  dropActive: boolean;
  loadMore?: { remaining: number | null; loading: boolean; visible: boolean };
  onLoadMore?: () => void;
  onDragStart: (event: DragEvent<HTMLElement>, lead: PipelineLead) => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onToggleSelected: (leadId: string) => void;
  onMoveRequest: (lead: PipelineLead, target?: PipelineStage) => void;
}) {
  const capacity = stage.capacity_target ? Math.min(100, Math.round((leads.length / stage.capacity_target) * 100)) : null;
  const dimmed = Boolean(dragging && !droppable);
  const tone = stageTone(stage);
  return (
    <section
      className={`pipeline-column ${dropActive ? "pipeline-column--active" : ""} ${dimmed ? "pipeline-column--dimmed" : ""}`}
      style={{ width: pipelineColumnWidth(preferences.columnWidth) }}
      aria-label={`${stage.name}, ${leads.length} lead(s)`}
      data-drop-state={dropActive ? "active" : droppable ? "available" : dragging ? "unavailable" : "idle"}
      onDragOver={(event) => { if (droppable) event.preventDefault(); }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
    >
      <header className="pipeline-column__header">
        <div className="flex min-w-0 items-center gap-2">
          <span className="pipeline-column__dot" style={{ backgroundColor: tone }} aria-hidden="true" />
          <span className="pipeline-column__stage-name">{stage.name}</span>
          <span className="rounded bg-[var(--surface-active)] px-1.5 py-0.5 type-caption leading-none text-[var(--text-secondary)]" data-stage-kind={stage.operational_kind ?? "manual"}>{pipelineStageAutomationLabel(stage)}</span>
          <span className="pipeline-column__count">{leads.length}{stage.capacity_target ? `/${stage.capacity_target}` : ""}</span>
          <span className="pipeline-column__menu" aria-hidden="true"><DotsThree size={15} weight="bold" /></span>
        </div>
        <div className="pipeline-column__summary">
          <span className="mono font-medium text-[var(--text-secondary)]">{formatStageValue(leads)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatAverageStageAge(leads)}</span>
        </div>
        {capacity != null ? <div className="pipeline-column__capacity" role="progressbar" aria-label={`Capacidade de ${stage.name}`} aria-valuenow={leads.length} aria-valuemax={stage.capacity_target ?? undefined}><span style={{ width: `${capacity}%`, backgroundColor: tone }} /></div> : null}
      </header>
      <div className={`pipeline-column__body flex-1 flex-col overflow-y-auto ${preferences.density === "compact" ? "gap-1.5 p-2" : "gap-2 p-2"}`}>
        {dropActive ? <p className="pipeline-column__drop-hint">Solte para mover para {stage.name}</p> : null}
        {loading ? [1, 2, 3].map((item) => <div key={item} className={`skeleton ${preferences.density === "compact" ? "h-24" : "h-36"}`} aria-hidden="true" />) : leads.map((lead) => (
          <PipelineCard
            key={lead.id}
            lead={lead}
            selected={selectedIds.has(lead.id)}
            canSelect={canSelect}
            canMove={canMove}
            pending={pendingLeadIds.has(lead.id)}
            preferences={preferences}
            timezone={timezone}
            onToggleSelected={() => onToggleSelected(lead.id)}
            onMove={() => onMoveRequest(lead)}
            onDragStart={(event) => onDragStart(event, lead)}
            onDragEnd={onDragEnd}
          />
        ))}
        {!loading && leads.length === 0 && !dropActive ? <p className="pipeline-column__empty">Nenhum lead nesta etapa</p> : null}
        {!loading && loadMore?.visible && onLoadMore ? (
          <button
            type="button"
            className="btn pipeline-column__load-more px-2 py-1.5 text-xs"
            onClick={onLoadMore}
            disabled={loadMore.loading}
          >
            {loadMore.loading
              ? "Carregando…"
              : `Carregar mais${loadMore.remaining != null && loadMore.remaining > 0 ? ` (${loadMore.remaining})` : ""}`}
          </button>
        ) : null}
        {!loading ? <span className="pipeline-column__add" aria-hidden="true">+ Adicionar lead</span> : null}
      </div>
    </section>
  );
}

function PipelineColumnSkeleton({ width }: { width: number }) {
  return <div className="pipeline-column-skeleton" style={{ width }} role="status" aria-label="Carregando coluna"><div className="skeleton m-3 h-5" /><div className="grid gap-2 p-2"><div className="skeleton h-24" /><div className="skeleton h-28" /><div className="skeleton h-24" /></div></div>;
}

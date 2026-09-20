"use client";

import { ArrowClockwise, DotsThree } from "@phosphor-icons/react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useMotionValue,
  useReducedMotion
} from "framer-motion";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { PipelineCard } from "@/components/pipeline-card";
import {
  pipelineBoardStageId,
  type PipelineLead,
  type PipelinePreferences,
  type PipelineStage
} from "@/lib/pipeline";

/*
  Mecânica de drag portada do kanban de referência (comments.md L11-1093):
  pointer events + framer-motion — o card sai da lista para um overlay que
  segue o cursor, o buraco fecha, um placeholder com mola abre na posição de
  inserção calculada sobre um snapshot de midpoints (sem flicker), os
  vizinhos deslizam (FLOW_SPRING), a borda do quadro faz autoscroll, o track
  tem máscara de fade e um ScrollRail próprio. Teclado: espaço pega, setas
  movem, espaço solta, Esc devolve — cada passo anunciado. A identidade
  AtendON (tokens, conteúdo do card, contratos de transição) permanece
  intacta.

  Adaptações de domínio frente à referência:
  - Reordenação dentro da MESMA coluna é NO-OP (backend não tem ordem de
    leads; o poll de 15s desfaria). Soltar na coluna de origem devolve o card
    ao lugar e anuncia.
  - O slot (placeholder) só abre em coluna permitida: allowedTransitions com
    a etapa de persistência e operational_kind !== "ai_follow_up". Colunas
    não permitidas ficam dimmed; soltar ali devolve o card à origem.
  - Nada se move de verdade entre colunas durante o gesto: o movimento real
    é sempre onMoveRequest(lead, stage) — a página decide PATCH ou dialog.
*/

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

const FLOW_SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;
const LIFT_SPRING = { type: "spring", stiffness: 520, damping: 34, mass: 0.7 } as const;
const AUTOSCROLL_EDGE = 72;
const AUTOSCROLL_STEP = 14;
const EDGE_FADE = "24px";

type DragState = {
  lead: PipelineLead;
  fromStageId: string;
  originIndex: number;
  width: number;
  height: number;
  /** Onde dentro do card o ponteiro agarrou. */
  offsetX: number;
  offsetY: number;
  /** false = captura por teclado (sem overlay; card permanece na lista). */
  pointer: boolean;
};

type Slot = { stageId: string; index: number };

/** Espaço vertical entre cards — o corpo usa gap-1.5 (compacto) / gap-2. */
function columnGap(density: PipelinePreferences["density"]): number {
  return density === "compact" ? 6 : 8;
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
  const [drag, setDrag] = useState<DragState | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const reduceMotion = useReducedMotion() ?? false;
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const trackRef = useRef<HTMLElement | null>(null);
  const listRefs = useRef(new Map<string, HTMLElement>());
  const colRefs = useRef(new Map<string, HTMLElement>());
  const columnRegisterFns = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const listRegisterFns = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const dragRef = useRef<DragState | null>(null);
  const slotRef = useRef<Slot | null>(null);
  // Um clique simples não é um drag: sem movimento real (limiar 3px) o ciclo
  // pegar/soltar é silencioso — sem anúncio "selecionado/mesma etapa" no click.
  const movedRef = useRef(false);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const snapRef = useRef(new Map<string, number[]>());
  const autoScrollRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const onMoveRequestRef = useRef(onMoveRequest);
  onMoveRequestRef.current = onMoveRequest;

  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);
  const stageByIdRef = useRef(stageById);
  stageByIdRef.current = stageById;

  const leadsByStage = useMemo(() => new Map(stages.map((stage) => [
    stage.id,
    leads.filter((lead) => pipelineBoardStageId(lead, stages, showAllStages) === stage.id)
  ])), [leads, showAllStages, stages]);

  /**
   * Governança de transições — a mesma de hoje: o destino precisa existir em
   * allowedTransitions ("origem:destino" sobre a etapa de persistência) e não
   * pode ser uma coluna de IA. Lê o drag por ref para o callback ficar
   * estável durante o gesto.
   */
  const canDropIn = useCallback((stage: PipelineStage): boolean => {
    const current = dragRef.current;
    if (!current || !canMove) return false;
    const sourceId = legacy ? `fallback:${current.lead.status}` : current.lead.pipeline_stage_id ?? null;
    if (!sourceId) return false;
    if (stage.operational_kind !== "ai_follow_up") {
      return allowedTransitions.has(`${sourceId}:${stage.operational_source_stage_id ?? stage.id}`);
    }
    return false;
  }, [allowedTransitions, canMove, legacy]);

  /*
    O track desaparece em fade para o fundo do lado que ainda tem colunas
    escondidas; o lado alcançado desliga o próprio fade.
  */
  const syncEdges = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft < 8);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    syncEdges();
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncEdges, stages.length]);

  const maskStops = [
    `transparent 0%, #000 ${atStart ? "0%" : EDGE_FADE}`,
    `#000 ${atEnd ? "100%" : `calc(100% - ${EDGE_FADE})`}, transparent 100%`
  ].join(", ");
  const mask = atStart && atEnd ? undefined : `linear-gradient(to right, ${maskStops})`;

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const handleBoardWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return;
      const delta = horizontalWheelDelta(event);
      if (delta === 0) return;
      event.preventDefault();
      track.scrollLeft += delta;
    };
    track.addEventListener("wheel", handleBoardWheel, { passive: false });
    return () => track.removeEventListener("wheel", handleBoardWheel);
  }, []);

  /*
    Card midpoints por coluna, medidos uma vez no início do drag e guardados
    como offsets do topo de cada lista. Medir ao vivo durante o drag parece
    mais simples e erra duas vezes: os cards estão no meio da mola, e o
    placeholder empurra os cards para além do ponteiro, o que inverte a
    decisão, move o placeholder e inverte de volta — flicker. Um snapshot do
    layout SEM o card em voo não tem nenhum dos dois problemas.
  */
  const snapshot = useCallback((leadId: string, fromStageId: string) => {
    const gap = columnGap(preferences.density);
    const map = new Map<string, number[]>();
    listRefs.current.forEach((list, stageId) => {
      const listTop = list.getBoundingClientRect().top;
      const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-pipeline-card]"));
      let removed = -1;
      let removedH = 0;
      const rows = cards.map((el, i) => {
        const r = el.getBoundingClientRect();
        const isDragged = stageId === fromStageId && el.dataset.pipelineCard === leadId;
        if (isDragged) {
          removed = i;
          removedH = r.height;
        }
        return { top: r.top - listTop, h: r.height, isDragged };
      });
      const mids = rows
        .filter((row) => !row.isDragged)
        .map((row, i) => {
          // fecha o buraco que o card arrastado deixa
          const shift = removed > -1 && i >= removed ? removedH + gap : 0;
          return row.top - shift + row.h / 2;
        });
      map.set(stageId, mids);
    });
    snapRef.current = map;
  }, [preferences.density]);

  /** Qual slot está sob o ponteiro — somente em coluna permitida. */
  const slotAt = useCallback((clientX: number, clientY: number): Slot | null => {
    const d = dragRef.current;
    if (!d) return null;

    let inside = "";
    let nearestId = "";
    let nearest = Infinity;
    colRefs.current.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) inside = id;
      const dx = Math.abs(clientX - (r.left + r.width / 2));
      if (dx < nearest) {
        nearest = dx;
        nearestId = id;
      }
    });
    const colId = inside || nearestId;
    if (!colId) return null;

    // A coluna de origem sempre aceita o próprio slot de devolução.
    if (colId === d.fromStageId) return { stageId: colId, index: d.originIndex };
    const stage = stageByIdRef.current.get(colId);
    if (!stage || !canDropIn(stage)) return null;

    const list = listRefs.current.get(colId);
    if (!list) return { stageId: colId, index: 0 };

    const listTop = list.getBoundingClientRect().top;
    const mids = snapRef.current.get(colId) ?? [];

    let index = mids.length;
    for (let i = 0; i < mids.length; i++) {
      if (clientY < listTop + mids[i]) {
        index = i;
        break;
      }
    }
    return { stageId: colId, index };
  }, [canDropIn]);

  const endDrag = useCallback((commit: boolean) => {
    const d = dragRef.current;
    const s = slotRef.current;
    if (d) {
      const leadName = d.lead.nome ?? "Lead";
      const originStage = stageByIdRef.current.get(d.fromStageId);
      const targetStage = s ? stageByIdRef.current.get(s.stageId) : undefined;
      if (commit && targetStage && targetStage.id !== d.fromStageId && canDropIn(targetStage)) {
        setLiveStatus(`${leadName}: movimento para ${targetStage.name} solicitado.`);
        onMoveRequestRef.current(d.lead, targetStage);
      } else if (commit && targetStage && targetStage.id === d.fromStageId) {
        if (movedRef.current || !d.pointer) setLiveStatus(`${leadName}: movimento na mesma etapa não altera o lead.`);
      } else if (movedRef.current || !d.pointer || !commit) {
        setLiveStatus(`Movimento cancelado. ${leadName} permanece em ${originStage?.name ?? "sua etapa"}.`);
      }
    }
    dragRef.current = null;
    slotRef.current = null;
    autoScrollRef.current = 0;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setDrag(null);
    setSlot(null);
  }, [canDropIn]);

  useEffect(() => {
    if (!drag || !drag.pointer) return;

    const onMove = (event: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!movedRef.current && (Math.abs(event.clientX - pointerStartRef.current.x) > 3 || Math.abs(event.clientY - pointerStartRef.current.y) > 3)) {
        movedRef.current = true;
        if (d.pointer) setLiveStatus(`${d.lead.nome ?? "Lead"} selecionado para movimentação. Escolha uma etapa permitida.`);
      }
      x.set(event.clientX - d.offsetX);
      y.set(event.clientY - d.offsetY);

      const next = slotAt(event.clientX, event.clientY);
      const cur = slotRef.current;
      if (next && (!cur || cur.stageId !== next.stageId || cur.index !== next.index)) {
        slotRef.current = next;
        setSlot(next);
        if (next.stageId !== cur?.stageId) {
          const stage = stageByIdRef.current.get(next.stageId);
          if (stage) setLiveStatus(`Etapa ${stage.name} disponível. Solte para mover ${d.lead.nome ?? "o lead"}.`);
        }
      } else if (!next && cur) {
        slotRef.current = null;
        setSlot(null);
      }

      // nudge the track along when you drag near either edge
      const track = trackRef.current;
      if (track) {
        const r = track.getBoundingClientRect();
        autoScrollRef.current =
          event.clientX < r.left + AUTOSCROLL_EDGE ? -AUTOSCROLL_STEP : event.clientX > r.right - AUTOSCROLL_EDGE ? AUTOSCROLL_STEP : 0;
      }
    };

    const onUp = (event: PointerEvent) => {
      // posição final do ponteiro decide o commit (e devolve ao slot nulo)
      const d = dragRef.current;
      if (d) slotRef.current = slotAt(event.clientX, event.clientY);
      endDrag(true);
    };
    const onCancel = () => endDrag(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDrag(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);

    const tick = () => {
      if (autoScrollRef.current && trackRef.current) {
        trackRef.current.scrollLeft += autoScrollRef.current;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [drag, endDrag, slotAt, x, y]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, lead: PipelineLead, stageId: string, index: number) => {
    if (!canMove || pendingLeadIds.has(lead.id)) return;
    if (event.button !== 0) return;
    // os controles do próprio card (links, botões, checkbox) não pegam o card
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea,[role='button'],[role='checkbox']")) return;
    const el = event.currentTarget;
    const r = el.getBoundingClientRect();
    const state: DragState = {
      lead,
      fromStageId: stageId,
      originIndex: index,
      width: r.width,
      height: r.height,
      offsetX: event.clientX - r.left,
      offsetY: event.clientY - r.top,
      pointer: true
    };
    x.set(r.left);
    y.set(r.top);
    snapshot(lead.id, stageId);
    movedRef.current = false;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    dragRef.current = state;
    slotRef.current = { stageId, index };
    setDrag(state);
    setSlot({ stageId, index });
  };

  /* ------------------------------------------------------------- teclado */

  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>, lead: PipelineLead, stageId: string, index: number) => {
    if (!canMove || pendingLeadIds.has(lead.id)) return;
    // teclas dos controles internos do card continuam sendo deles
    if (event.target !== event.currentTarget) return;

    const d = dragRef.current;
    const grabbed = Boolean(d && !d.pointer && d.lead.id === lead.id);

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (d) {
        endDrag(true);
        return;
      }
      const el = event.currentTarget;
      const r = el.getBoundingClientRect();
      const state: DragState = {
        lead,
        fromStageId: stageId,
        originIndex: index,
        width: r.width,
        height: r.height,
        offsetX: 0,
        offsetY: 0,
        pointer: false
      };
      snapshot(lead.id, stageId);
      dragRef.current = state;
      slotRef.current = { stageId, index };
      setDrag(state);
      setSlot({ stageId, index });
      setLiveStatus(`${lead.nome ?? "Lead"} selecionado para movimentação. Escolha uma etapa permitida.`);
      return;
    }

    if (event.key === "Escape") {
      if (grabbed) {
        event.preventDefault();
        endDrag(false);
      }
      return;
    }

    if (!grabbed || !d) return;
    const s = slotRef.current;
    if (!s) return;
    const colIndex = stages.findIndex((stage) => stage.id === s.stageId);

    // Reordenação dentro da mesma etapa é NO-OP no backend (sem ordem de
    // leads; o poll de 15s desfaria) — anuncia, não move.
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setLiveStatus(`${lead.nome ?? "Lead"}: a ordem dentro da etapa não é alterada.`);
      return;
    }

    let neighborId: string | null = null;
    if (event.key === "ArrowLeft" && colIndex > 0) neighborId = stages[colIndex - 1].id;
    if (event.key === "ArrowRight" && colIndex < stages.length - 1) neighborId = stages[colIndex + 1].id;
    if (!neighborId) return;

    event.preventDefault();
    const target = stageByIdRef.current.get(neighborId);
    if (!target) return;
    if (canDropIn(target)) {
      const next: Slot = { stageId: target.id, index: Math.min(d.originIndex, (leadsByStage.get(target.id) ?? []).length) };
      slotRef.current = next;
      setSlot(next);
      setLiveStatus(`Etapa ${target.name} disponível. Solte para mover ${lead.nome ?? "o lead"}.`);
    } else {
      setLiveStatus(`Movimento para ${target.name} não é permitido para este lead.`);
    }
  };

  /* -------------------------------------------------------------- render */

  const registerColumn = useCallback((stageId: string) => {
    // Ref-callback estável por etapa: recriar a closure a cada render faria
    // o React desmontar/remontar a ref (churn) em todo render do quadro.
    let fn = columnRegisterFns.current.get(stageId);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) colRefs.current.set(stageId, el);
        else colRefs.current.delete(stageId);
      };
      columnRegisterFns.current.set(stageId, fn);
    }
    return fn;
  }, []);
  const registerList = useCallback((stageId: string) => {
    let fn = listRegisterFns.current.get(stageId);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) listRefs.current.set(stageId, el);
        else listRefs.current.delete(stageId);
      };
      listRegisterFns.current.set(stageId, fn);
    }
    return fn;
  }, []);

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
      <div className="pipeline-board-dock">
        <section
          ref={trackRef}
          className="pipeline-board overflow-x-auto overflow-y-hidden overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden select-none"
          aria-label="Quadro de pipeline"
          tabIndex={0}
          data-edge-fade={mask ? "on" : "off"}
          onScroll={syncEdges}
          style={mask ? ({ maskImage: mask, WebkitMaskImage: mask } as CSSProperties) : undefined}
        >
          {loading && stages.length === 0
            ? [1, 2, 3, 4].map((item) => <PipelineColumnSkeleton key={item} width={pipelineColumnWidth(preferences.columnWidth)} />)
            : (
              <LayoutGroup>
                {stages.map((stage) => {
                  const items = leadsByStage.get(stage.id) ?? [];
                  const droppable = Boolean(drag && canDropIn(stage));
                  const isTarget = Boolean(drag && slot && slot.stageId === stage.id && (stage.id === drag.fromStageId || canDropIn(stage)));
                  const visibleItems = drag?.pointer ? items.filter((lead) => lead.id !== drag.lead.id) : items;
                  // enquanto o card está no ar, a contagem mostra onde ele
                  // cairia, não de onde veio (referência: mesma aritmética)
                  const count = items.length
                    - (drag?.pointer && drag.fromStageId === stage.id ? 1 : 0)
                    + (drag?.pointer && slot?.stageId === stage.id ? 1 : 0);
                  return (
                    <PipelineColumn
                      key={stage.id}
                      stage={stage}
                      leads={items}
                      visibleItems={visibleItems}
                      count={count}
                      loading={loading}
                      canMove={canMove}
                      canSelect={canSelect}
                      selectedIds={selectedIds}
                      pendingLeadIds={pendingLeadIds}
                      preferences={preferences}
                      timezone={timezone}
                      dragging={drag?.lead ?? null}
                      grabbedLeadId={drag && !drag.pointer ? drag.lead.id : null}
                      droppable={droppable}
                      dropActive={isTarget}
                      slotIndex={isTarget ? slot!.index : null}
                      placeholderHeight={drag ? drag.height : 0}
                      reduceMotion={reduceMotion}
                      registerColumn={registerColumn(stage.id)}
                      registerList={registerList(stage.id)}
                      loadMore={columnLoadMore?.get(stage.id)}
                      onLoadMore={onColumnLoadMore ? () => onColumnLoadMore(stage) : undefined}
                      onGrabPointerDown={(event, lead, index) => startDrag(event, lead, stage.id, index)}
                      onGrabKeyDown={(event, lead, index) => onCardKeyDown(event, lead, stage.id, index)}
                      onToggleSelected={onToggleSelected}
                      onMoveRequest={onMoveRequest}
                    />
                  );
                })}
              </LayoutGroup>
            )}
        </section>
        <ScrollRail trackRef={trackRef} />
      </div>

      {/* o card voando com o cursor */}
      <AnimatePresence>
        {drag?.pointer && drag.lead ? (
          <motion.div
            key="pipeline-drag-overlay"
            style={{ x, y, width: drag.width }}
            initial={{ scale: 1, rotate: 0 }}
            animate={{ scale: reduceMotion ? 1 : 1.03, rotate: reduceMotion ? 0 : 1.6 }}
            exit={{ scale: 1, rotate: 0, opacity: 0 }}
            transition={LIFT_SPRING}
            className="pointer-events-none fixed left-0 top-0 z-50 origin-top-left"
          >
            <PipelineCard
              lead={drag.lead}
              selected={false}
              canSelect={false}
              canMove={false}
              pending={false}
              preferences={preferences}
              timezone={timezone}
              floating
              onToggleSelected={() => undefined}
              onMove={() => undefined}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

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
  visibleItems,
  count,
  loading,
  canMove,
  canSelect,
  selectedIds,
  pendingLeadIds,
  preferences,
  timezone,
  dragging,
  grabbedLeadId = null,
  droppable,
  dropActive,
  slotIndex = null,
  placeholderHeight = 0,
  reduceMotion = false,
  registerColumn,
  registerList,
  loadMore,
  onLoadMore,
  onGrabPointerDown,
  onGrabKeyDown,
  onToggleSelected,
  onMoveRequest
}: {
  stage: PipelineStage;
  /** Todos os leads da etapa (contrato/aria/capacidade). */
  leads: PipelineLead[];
  /** Leads visíveis: sem o card em voo (o overlay o substitui). */
  visibleItems?: PipelineLead[];
  /** Contagem exibida no header (pode antecipar o pouso durante o drag). */
  count?: number;
  loading: boolean;
  canMove: boolean;
  canSelect: boolean;
  selectedIds: Set<string>;
  pendingLeadIds: Set<string>;
  preferences: PipelinePreferences;
  timezone?: string;
  dragging: PipelineLead | null;
  grabbedLeadId?: string | null;
  droppable: boolean;
  dropActive: boolean;
  slotIndex?: number | null;
  placeholderHeight?: number;
  reduceMotion?: boolean;
  registerColumn?: (el: HTMLElement | null) => void;
  registerList?: (el: HTMLElement | null) => void;
  loadMore?: { remaining: number | null; loading: boolean; visible: boolean };
  onLoadMore?: () => void;
  onGrabPointerDown: (event: ReactPointerEvent<HTMLElement>, lead: PipelineLead, index: number) => void;
  onGrabKeyDown: (event: ReactKeyboardEvent<HTMLElement>, lead: PipelineLead, index: number) => void;
  onToggleSelected: (leadId: string) => void;
  onMoveRequest: (lead: PipelineLead, target?: PipelineStage) => void;
}) {
  const capacity = stage.capacity_target ? Math.min(100, Math.round((leads.length / stage.capacity_target) * 100)) : null;
  const dimmed = Boolean(dragging && !droppable && !dropActive);
  const tone = stageTone(stage);
  const items = visibleItems ?? leads;
  const shownCount = count ?? leads.length;
  const density = preferences.density;
  return (
    <section
      ref={registerColumn}
      data-pipeline-column={stage.id}
      className={`pipeline-column ${dropActive ? "pipeline-column--active" : ""} ${dimmed ? "pipeline-column--dimmed" : ""}`}
      style={{ width: pipelineColumnWidth(preferences.columnWidth) }}
      aria-label={`${stage.name}, ${leads.length} lead(s)`}
      data-drop-state={dropActive ? "active" : droppable ? "available" : dragging ? "unavailable" : "idle"}
    >
      <header className="pipeline-column__header">
        <div className="flex min-w-0 items-center gap-2">
          <span className="pipeline-column__dot" style={{ backgroundColor: tone }} aria-hidden="true" />
          <span className="pipeline-column__stage-name">{stage.name}</span>
          <span className="rounded bg-[var(--surface-active)] px-1.5 py-0.5 type-caption leading-none text-[var(--text-secondary)]" data-stage-kind={stage.operational_kind ?? "manual"}>{pipelineStageAutomationLabel(stage)}</span>
          <span className="pipeline-column__count">
            <motion.span
              key={shownCount}
              initial={{ y: -6, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={reduceMotion ? { duration: 0 } : FLOW_SPRING}
              className="inline-block"
            >
              {shownCount}
            </motion.span>
            {stage.capacity_target ? `/${stage.capacity_target}` : ""}
          </span>
          <span className="pipeline-column__menu" aria-hidden="true"><DotsThree size={15} weight="bold" /></span>
        </div>
        <div className="pipeline-column__summary">
          <span className="mono font-medium text-[var(--text-secondary)]">{formatStageValue(leads)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatAverageStageAge(leads)}</span>
        </div>
        {capacity != null ? <div className="pipeline-column__capacity" role="progressbar" aria-label={`Capacidade de ${stage.name}`} aria-valuenow={leads.length} aria-valuemax={stage.capacity_target ?? undefined}><span style={{ width: `${capacity}%`, backgroundColor: tone }} /></div> : null}
      </header>
      <div
        ref={registerList}
        data-pipeline-list={stage.id}
        className={`pipeline-column__body flex-1 flex-col overflow-y-auto ${density === "compact" ? "gap-1.5 p-2" : "gap-2 p-2"}`}
      >
        {loading ? [1, 2, 3].map((item) => <div key={item} className={`skeleton ${density === "compact" ? "h-24" : "h-36"}`} aria-hidden="true" />) : (
          <>
            {items.map((lead, i) => (
              <Fragment key={lead.id}>
                {dropActive && slotIndex === i ? <Placeholder height={placeholderHeight} reduceMotion={reduceMotion} /> : null}
                <PipelineCard
                  lead={lead}
                  selected={selectedIds.has(lead.id)}
                  canSelect={canSelect}
                  canMove={canMove}
                  pending={pendingLeadIds.has(lead.id)}
                  preferences={preferences}
                  timezone={timezone}
                  grabbed={grabbedLeadId === lead.id}
                  onToggleSelected={() => onToggleSelected(lead.id)}
                  onMove={() => onMoveRequest(lead)}
                  onGrabPointerDown={(event) => onGrabPointerDown(event, lead, i)}
                  onGrabKeyDown={(event) => onGrabKeyDown(event, lead, i)}
                />
              </Fragment>
            ))}
            {dropActive && slotIndex != null && slotIndex >= items.length ? <Placeholder height={placeholderHeight} reduceMotion={reduceMotion} /> : null}
            {leads.length === 0 && !dropActive ? <p className="pipeline-column__empty">Nenhum lead nesta etapa</p> : null}
          </>
        )}
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

function Placeholder({ height, reduceMotion }: { height: number; reduceMotion: boolean }) {
  return (
    <motion.div
      layout
      data-pipeline-placeholder=""
      initial={{ opacity: 0, scaleY: 0.7 }}
      animate={{ opacity: 1, scaleY: 1 }}
      exit={{ opacity: 0, scaleY: 0.7 }}
      transition={reduceMotion ? { duration: 0 } : FLOW_SPRING}
      style={{ height }}
      aria-hidden="true"
      className="pipeline-column__placeholder origin-top"
    />
  );
}

/**
 * Barra de rolagem própria (ScrollRail da referência).
 * A nativa não ajuda: no macOS e nos browsers headless ela é overlay e só
 * aparece quando já se está rolando. Esta fica visível enquanto houver para
 * onde ir, e arrasta.
 */
function ScrollRail({ trackRef }: { trackRef: RefObject<HTMLElement | null> }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [geom, setGeom] = useState({ ratio: 1, offset: 0 });
  const [held, setHeld] = useState(false);

  const sync = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const ratio = el.scrollWidth > 0 ? el.clientWidth / el.scrollWidth : 1;
    const max = el.scrollWidth - el.clientWidth;
    setGeom({ ratio, offset: max > 0 ? el.scrollLeft / max : 0 });
  }, [trackRef]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(sync);
      ro.observe(el);
      Array.from(el.children).forEach((child) => ro?.observe(child));
    }
    return () => {
      el.removeEventListener("scroll", sync);
      ro?.disconnect();
    };
  }, [sync, trackRef]);

  const scrollTo = useCallback((clientX: number) => {
    const rail = railRef.current;
    const el = trackRef.current;
    if (!rail || !el) return;
    const r = rail.getBoundingClientRect();
    const thumbW = r.width * geom.ratio;
    const p = (clientX - r.left - thumbW / 2) / (r.width - thumbW);
    el.scrollLeft = Math.max(0, Math.min(1, p)) * (el.scrollWidth - el.clientWidth);
  }, [geom.ratio, trackRef]);

  useEffect(() => {
    if (!held) return;
    const onMove = (event: PointerEvent) => scrollTo(event.clientX);
    const onUp = () => setHeld(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [held, scrollTo]);

  if (geom.ratio >= 0.999) return null;

  return (
    <div
      ref={railRef}
      className={`pipeline-rail ${held ? "pipeline-rail--held" : ""}`}
      onPointerDown={(event) => {
        setHeld(true);
        scrollTo(event.clientX);
      }}
    >
      <div
        style={{
          width: `${geom.ratio * 100}%`,
          marginLeft: `${geom.offset * (100 - geom.ratio * 100)}%`
        }}
        className="pipeline-rail__thumb"
      />
    </div>
  );
}

function PipelineColumnSkeleton({ width }: { width: number }) {
  return <div className="pipeline-column-skeleton" style={{ width }} role="status" aria-label="Carregando coluna"><div className="skeleton m-3 h-5" /><div className="grid gap-2 p-2"><div className="skeleton h-24" /><div className="skeleton h-28" /><div className="skeleton h-24" /></div></div>;
}

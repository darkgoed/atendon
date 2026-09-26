"use client";

import {
  ArrowsLeftRight,
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  DotsThreeVertical,
  GripVertical,
  Kanban,
  LinkSimple,
  PencilSimple,
  Plus,
  Star,
  Trash
} from "@/components/icons";
import { ModalDialog } from "@/components/modal-dialog";
import { PopoverMenu } from "@/components/popover-menu";
import { Button, Field, Input, SaveButton, SaveToast, Select, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import { PIPELINE_COLOR_SWATCHES, type PipelineChannelLink, type PipelineGroup, type PipelineSummary } from "@/lib/pipeline";
import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";

type NameDialogKind = "create" | "rename" | "duplicate";
type DialogKind = NameDialogKind | "channels" | "rules" | "delete" | "group-create" | "group-rename" | "group-archive" | "pipeline-move";
type DialogState = { kind: DialogKind; groupId?: string; pipelineId?: string } | null;

const UNGROUPED_DROP_ID = "__ungrouped__";

/**
 * Menu ⋯ INLINE (sem portal): um PopoverMenu aninhado aqui fecharia o painel do
 * seletor no pointerdown externo (o painel aninhado vive fora do panelRef).
 */
function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="pipeline-switcher__rowmenu" ref={rootRef}>
      <button
        type="button"
        className="pipeline-switcher__rowmenu-trigger"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        title="Mais ações"
        onClick={() => setOpen((current) => !current)}
      >
        <DotsThreeVertical size={14} aria-hidden="true" />
      </button>
      {open ? <div className="pipeline-switcher__rowmenu-panel">{children(() => setOpen(false))}</div> : null}
    </div>
  );
}

/**
 * Seletor de pipeline (com grupos) + menu ⋯ do cabeçalho de /pipeline. A página
 * carrega GET /organization/pipelines (pipelines + groups) e resolve o pipeline
 * ativo (URL > localStorage > is_default); aqui acontece a edição — CRUD de
 * grupos, mover/reordenar por menu ou drag, e as ações do pipeline ativo.
 * Revalidação via onChanged, seleção via onSelect; o servidor é a fonte dos
 * dados (falha de escrita mantém a ordem recebida e avisa localmente).
 */
export function PipelineManager({
  pipelines,
  activePipeline,
  channels = [],
  groups = [],
  canManage,
  onSelect,
  onChanged
}: {
  pipelines: PipelineSummary[];
  activePipeline: PipelineSummary | null;
  channels?: PipelineChannelLink[];
  groups?: PipelineGroup[];
  canManage: boolean;
  onSelect: (pipelineId: string | null) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<{ kind: "group" | "pipeline"; id: string } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");
  const saved = useSaveFeedback();
  const [savedMessage, setSavedMessage] = useState("");

  if (!activePipeline) return null;
  const active: PipelineSummary = activePipeline;

  function notifySaved(message: string) {
    setSavedMessage(message);
    setWarning("");
    saved.markDone();
  }

  /** Escrita de painel (ordens, mover): o servidor manda; falha = aviso local + nada de "salvo". */
  async function run(write: () => Promise<unknown>, successMessage: string) {
    if (busy) return;
    setBusy(true);
    setWarning("");
    try {
      await write();
      notifySaved(successMessage);
      await onChanged();
    } catch (cause) {
      setWarning(cause instanceof Error ? cause.message : "Não foi possível concluir a operação");
    } finally {
      setBusy(false);
    }
  }

  function openDialog(state: Exclude<DialogState, null>) {
    setSearch("");
    setDialog(state);
  }

  // "Configurar etapas" reaproveita o editor do quadro: fecha o menu e leva o
  // usuário à coluna "+ Nova etapa" (pipeline-column--new, criada pelo quadro).
  function focusNewStageColumn() {
    const column = document.querySelector<HTMLElement>(".pipeline-column--new");
    if (!column) return;
    column.scrollIntoView({ block: "nearest", inline: "nearest" });
    (column.querySelector<HTMLElement>("button, input") ?? column).focus();
  }

  async function makeDefault() {
    try {
      await api(`/organization/pipelines/${active.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_default: true })
      });
      notifySaved("Definido como pipeline padrão");
      await onChanged();
    } catch {
      // api() já reporta o erro no toast global.
    }
  }

  // ── Grupos/pipelines: derivações para o painel do seletor ──
  const orderedGroups = [...groups].sort((left, right) => left.position - right.position);
  const hasGroups = orderedGroups.length > 0;
  const knownGroupIds = new Set(orderedGroups.map((group) => group.id));
  const pipelinesOfGroup = (groupId: string) => pipelines.filter((pipeline) => pipeline.group_id === groupId);
  const ungrouped = pipelines.filter((pipeline) => !pipeline.group_id || !knownGroupIds.has(pipeline.group_id));
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const matches = (text: string) => text.toLowerCase().includes(query);
  const visibleGroups = searching
    ? orderedGroups.filter((group) => matches(group.name) || pipelinesOfGroup(group.id).some((pipeline) => matches(pipeline.name)))
    : orderedGroups;
  const visibleUngrouped = searching ? ungrouped.filter((pipeline) => matches(pipeline.name)) : ungrouped;
  const noResults = searching && visibleGroups.length === 0 && visibleUngrouped.length === 0;

  function toggleGroup(groupId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function startDrag(kind: "group" | "pipeline", id: string) {
    return (event: ReactDragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      setDrag({ kind, id });
    };
  }

  function endDrag() {
    setDrag(null);
    setOverId(null);
  }

  /** Reordena grupos: o arrastado toma o lugar do alvo (troca índices no PUT completo). */
  function reorderGroups(draggedId: string, targetGroupId: string) {
    const ids = orderedGroups.map((group) => group.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetGroupId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(from < to ? ids.indexOf(targetGroupId) + 1 : ids.indexOf(targetGroupId), 0, draggedId);
    void run(() => api("/organization/pipeline-groups/order", { method: "PUT", body: JSON.stringify({ group_ids: ids }) }), "Ordem dos grupos salva");
  }

  /** Reordena pipelines: o arrastado entra imediatamente antes/depois do alvo; PUT exige a lista completa. */
  function reorderPipelines(draggedId: string, targetId: string) {
    const ids = pipelines.map((pipeline) => pipeline.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(from < to ? ids.indexOf(targetId) + 1 : ids.indexOf(targetId), 0, draggedId);
    void run(() => api("/organization/pipelines/order", { method: "PUT", body: JSON.stringify({ pipeline_ids: ids }) }), "Ordem salva");
  }

  function movePipelineToGroup(pipelineId: string, groupId: string | null) {
    const pipeline = pipelines.find((item) => item.id === pipelineId);
    if (!pipeline || (pipeline.group_id ?? null) === groupId) return;
    void run(() => api(`/organization/pipelines/${pipeline.id}`, { method: "PATCH", body: JSON.stringify({ group_id: groupId }) }), "Pipeline movido");
  }

  /** Equivalente acessível do drag: troca com o vizinho DENTRO da própria seção. */
  function shiftPipeline(pipeline: PipelineSummary, delta: -1 | 1) {
    const section = pipeline.group_id && knownGroupIds.has(pipeline.group_id) ? pipelinesOfGroup(pipeline.group_id) : ungrouped;
    const index = section.findIndex((item) => item.id === pipeline.id);
    const neighbor = section[index + delta];
    if (index < 0 || !neighbor) return;
    const ids = pipelines.map((item) => (item.id === pipeline.id ? neighbor.id : item.id === neighbor.id ? pipeline.id : item.id));
    void run(() => api("/organization/pipelines/order", { method: "PUT", body: JSON.stringify({ pipeline_ids: ids }) }), "Ordem salva");
  }

  function shiftGroup(group: PipelineGroup, delta: -1 | 1) {
    const index = orderedGroups.findIndex((item) => item.id === group.id);
    const neighbor = orderedGroups[index + delta];
    if (index < 0 || !neighbor) return;
    const ids = orderedGroups.map((item) => (item.id === group.id ? neighbor.id : item.id === neighbor.id ? group.id : item.id));
    void run(() => api("/organization/pipeline-groups/order", { method: "PUT", body: JSON.stringify({ group_ids: ids }) }), "Ordem dos grupos salva");
  }

  function pipelineRow(close: () => void, pipeline: PipelineSummary, groupId?: string | null) {
    const grouped = groupId !== undefined;
    const item = (
      <button
        type="button"
        role="menuitem"
        className="pipeline-switcher__item"
        aria-current={pipeline.id === active.id ? "true" : undefined}
        onClick={() => selectPipeline(close, pipeline.id)}
      >
        <span className="pipeline-switcher__dot" style={{ background: pipeline.color }} aria-hidden="true" />
        <span className="pipeline-switcher__name">{pipeline.name}</span>
        <span className="pipeline-switcher__count">{pipeline.lead_count} lead(s)</span>
        {pipeline.id === active.id ? <Check size={14} className="pipeline-switcher__check" aria-hidden="true" /> : null}
      </button>
    );
    if (!grouped || !canManage) return <Fragment key={pipeline.id}>{item}</Fragment>;
    const rowDrop = Boolean(drag && drag.kind === "pipeline" && drag.id !== pipeline.id);
    const section = pipeline.group_id && knownGroupIds.has(pipeline.group_id) ? pipelinesOfGroup(pipeline.group_id) : ungrouped;
    const sectionIndex = section.findIndex((item2) => item2.id === pipeline.id);
    return (
      <div
        key={pipeline.id}
        className={`pipeline-switcher__row${drag?.kind === "pipeline" && drag.id === pipeline.id ? " pipeline-switcher__row--dragging" : ""}${rowDrop && overId === pipeline.id ? " pipeline-switcher__row--drop" : ""}`}
        onDragOver={rowDrop
          ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setOverId(pipeline.id);
          }
          : undefined}
        onDrop={rowDrop
          ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            const current = drag;
            endDrag();
            if (!current) return;
            const dragged = pipelines.find((candidate) => candidate.id === current.id);
            if (!dragged) return;
            if ((dragged.group_id ?? null) === (pipeline.group_id ?? null)) reorderPipelines(current.id, pipeline.id);
            else movePipelineToGroup(current.id, pipeline.group_id ?? null);
          }
          : undefined}
      >
        {!searching ? (
          <span
            className="pipeline-switcher__grip"
            draggable
            role="button"
            tabIndex={-1}
            aria-label={`Mover pipeline ${pipeline.name}`}
            title="Arraste para reordenar ou mover de grupo"
            onDragStart={startDrag("pipeline", pipeline.id)}
            onDragEnd={endDrag}
          >
            <GripVertical size={13} aria-hidden="true" />
          </span>
        ) : null}
        {item}
        <RowMenu label={`Ações do pipeline ${pipeline.name}`}>
          {(closeRowMenu) => <>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); openDialog({ kind: "pipeline-move", pipelineId: pipeline.id }); }}>
              <ArrowsLeftRight size={15} aria-hidden="true" /> Mover para grupo…
            </button>
            {sectionIndex > 0 ? (
              <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); shiftPipeline(pipeline, -1); }}>
                <ArrowUp size={15} aria-hidden="true" /> Mover para cima
              </button>
            ) : null}
            {sectionIndex < section.length - 1 ? (
              <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); shiftPipeline(pipeline, 1); }}>
                <ArrowDown size={15} aria-hidden="true" /> Mover para baixo
              </button>
            ) : null}
            <button type="button" role="menuitem" className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={() => { closeRowMenu(); openDialog({ kind: "delete", pipelineId: pipeline.id }); }}>
              <Trash size={15} aria-hidden="true" /> Arquivar pipeline
            </button>
          </>}
        </RowMenu>
      </div>
    );
  }

  function selectPipeline(close: () => void, pipelineId: string) {
    setSearch("");
    close();
    onSelect(pipelineId);
  }

  function panel(close: () => void) {
    return <>
      {(hasGroups || pipelines.length > 1) ? (
        <div className="pipeline-switcher__search">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar pipeline ou grupo"
            aria-label="Buscar pipeline ou grupo"
            maxLength={80}
          />
        </div>
      ) : null}
      {visibleGroups.map((group) => {
        const expanded = searching || !collapsed.has(group.id);
        // Grupo correspondente pela busca mostra TODOS os pipelines; senão, só os pipelines que casam.
        const items = searching
          ? (matches(group.name) ? pipelinesOfGroup(group.id) : pipelinesOfGroup(group.id).filter((pipeline) => matches(pipeline.name)))
          : pipelinesOfGroup(group.id);
        const groupIndex = orderedGroups.findIndex((item) => item.id === group.id);
        return (
          <div
            key={group.id}
            className={`pipeline-switcher__group${drag && overId === group.id ? " pipeline-switcher__group--drop" : ""}${drag?.kind === "group" && drag.id === group.id ? " pipeline-switcher__group--dragging" : ""}`}
            onDragOver={drag
              ? (event) => {
                if (!drag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOverId(drag.kind === "group" && drag.id === group.id ? null : group.id);
              }
              : undefined}
            onDrop={drag
              ? (event) => {
                event.preventDefault();
                const current = drag;
                endDrag();
                if (!current) return;
                if (current.kind === "group" && current.id !== group.id) reorderGroups(current.id, group.id);
                else if (current.kind === "pipeline") movePipelineToGroup(current.id, group.id);
              }
              : undefined}
          >
            <div className="pipeline-switcher__grouprow">
              {canManage && !searching ? (
                <span
                  className="pipeline-switcher__grip"
                  draggable
                  role="button"
                  tabIndex={-1}
                  aria-label={`Reordenar grupo ${group.name}`}
                  title="Arraste para reordenar"
                  onDragStart={startDrag("group", group.id)}
                  onDragEnd={endDrag}
                >
                  <GripVertical size={13} aria-hidden="true" />
                </span>
              ) : null}
              <button
                type="button"
                className="pipeline-switcher__grouptoggle"
                aria-expanded={expanded}
                title={expanded ? "Recolher grupo" : "Expandir grupo"}
                onClick={() => toggleGroup(group.id)}
              >
                {expanded ? <CaretDown size={13} className="pipeline-switcher__caret" aria-hidden="true" /> : <CaretRight size={13} className="pipeline-switcher__caret" aria-hidden="true" />}
                <span className="pipeline-switcher__name">{group.name}</span>
                <span className="pipeline-switcher__count">{pipelinesOfGroup(group.id).length}</span>
              </button>
              {canManage ? (
                <RowMenu label={`Ações do grupo ${group.name}`}>
                  {(closeRowMenu) => <>
                    <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); openDialog({ kind: "create", groupId: group.id }); }}>
                      <Plus size={15} aria-hidden="true" /> Novo pipeline neste grupo
                    </button>
                    <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); openDialog({ kind: "group-rename", groupId: group.id }); }}>
                      <PencilSimple size={15} aria-hidden="true" /> Renomear grupo
                    </button>
                    {groupIndex > 0 ? (
                      <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); shiftGroup(group, -1); }}>
                        <ArrowUp size={15} aria-hidden="true" /> Mover para cima
                      </button>
                    ) : null}
                    {groupIndex < orderedGroups.length - 1 ? (
                      <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { closeRowMenu(); shiftGroup(group, 1); }}>
                        <ArrowDown size={15} aria-hidden="true" /> Mover para baixo
                      </button>
                    ) : null}
                    <button type="button" role="menuitem" className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={() => { closeRowMenu(); openDialog({ kind: "group-archive", groupId: group.id }); }}>
                      <Trash size={15} aria-hidden="true" /> Arquivar grupo
                    </button>
                  </>}
                </RowMenu>
              ) : null}
            </div>
            {expanded ? <div className="pipeline-switcher__sublist">{items.map((pipeline) => pipelineRow(close, pipeline, group.id))}</div> : null}
          </div>
        );
      })}
      {hasGroups && visibleUngrouped.length > 0 ? (
        <div
          className={`pipeline-switcher__group pipeline-switcher__group--ungrouped${drag && drag.kind === "pipeline" && overId === UNGROUPED_DROP_ID ? " pipeline-switcher__group--drop" : ""}`}
          onDragOver={drag && drag.kind === "pipeline"
            ? (event) => {
              if (!drag) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverId(UNGROUPED_DROP_ID);
            }
            : undefined}
          onDrop={drag && drag.kind === "pipeline"
            ? (event) => {
              event.preventDefault();
              const current = drag;
              endDrag();
              if (!current) return;
              movePipelineToGroup(current.id, null);
            }
            : undefined}
        >
          <div className="pipeline-switcher__grouprow pipeline-switcher__grouprow--muted">
            <span className="pipeline-switcher__grouptoggle pipeline-switcher__grouptoggle--label">
              <span className="pipeline-switcher__name">Sem grupo</span>
              <span className="pipeline-switcher__count">{ungrouped.length}</span>
            </span>
          </div>
          <div className="pipeline-switcher__sublist">{visibleUngrouped.map((pipeline) => pipelineRow(close, pipeline, null))}</div>
        </div>
      ) : null}
      {!hasGroups ? visibleUngrouped.map((pipeline) => pipelineRow(close, pipeline)) : null}
      {noResults ? <p className="pipeline-switcher__empty">Nenhum resultado para “{search.trim()}”</p> : null}
      {canManage ? (
        <div className="pipeline-switcher__new">
          <button type="button" role="menuitem" className="pipeline-switcher__item" onClick={() => { close(); openDialog({ kind: "create" }); }}>
            <Plus size={15} aria-hidden="true" /> Novo pipeline
          </button>
          <button type="button" role="menuitem" className="pipeline-switcher__item" onClick={() => { close(); openDialog({ kind: "group-create" }); }}>
            <Plus size={15} aria-hidden="true" /> Novo grupo
          </button>
        </div>
      ) : null}
    </>;
  }

  // Diálogos: variáveis estreitadas (o opcional-encadeamento não estreita através de "||").
  const nameDialogKind: NameDialogKind | null = dialog && (dialog.kind === "create" || dialog.kind === "rename" || dialog.kind === "duplicate") ? dialog.kind : null;
  const dialogPipelineId = dialog?.pipelineId;
  const dialogPipeline = dialogPipelineId ? pipelines.find((candidate) => candidate.id === dialogPipelineId) : undefined;
  const dialogGroupId = dialog?.groupId;
  const dialogGroup = dialogGroupId ? orderedGroups.find((candidate) => candidate.id === dialogGroupId) : undefined;

  return <>
    <div className="pipeline-manager">
      <PopoverMenu
        buttonClassName="pipeline-switcher"
        panelClassName="conversation-action-menu__panel pipeline-switcher__panel"
        title="Trocar de pipeline"
        ariaLabel={`Pipeline ativo: ${active.name}. Trocar de pipeline`}
        align="start"
        icon={<>
          <span className="pipeline-switcher__dot" style={{ background: active.color }} aria-hidden="true" />
          <span className="pipeline-switcher__name">{active.name}</span>
          <CaretDown size={14} className="pipeline-switcher__caret" aria-hidden="true" />
        </>}
      >
        {(close) => panel(close)}
      </PopoverMenu>
      {canManage ? (
        <PopoverMenu
          buttonClassName="pipeline-manager__trigger"
          panelClassName="conversation-action-menu__panel"
          icon={<DotsThreeVertical size={16} aria-hidden="true" />}
          ariaLabel="Ações do pipeline"
          title="Mais ações"
        >
          {(close) => <>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); openDialog({ kind: "rename" }); }}>
              <PencilSimple size={15} aria-hidden="true" /> Renomear / editar
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); openDialog({ kind: "duplicate" }); }}>
              <Copy size={15} aria-hidden="true" /> Duplicar
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); focusNewStageColumn(); }}>
              <Kanban size={15} aria-hidden="true" /> Configurar etapas
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog({ kind: "rules" }); }}>
              <ArrowsLeftRight size={15} aria-hidden="true" /> Regras de movimentação
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog({ kind: "channels" }); }}>
              <LinkSimple size={15} aria-hidden="true" /> Canais vinculados
            </button>
            {!active.is_default ? (
              <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); void makeDefault(); }}>
                <Star size={15} aria-hidden="true" /> Definir como padrão
              </button>
            ) : null}
            {hasGroups ? (
              <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); openDialog({ kind: "pipeline-move", pipelineId: active.id }); }}>
                <ArrowsLeftRight size={15} aria-hidden="true" /> Mover para grupo…
              </button>
            ) : null}
            <button type="button" role="menuitem" className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={() => { close(); openDialog({ kind: "delete", pipelineId: active.id }); }}>
              <Trash size={15} aria-hidden="true" /> Excluir pipeline
            </button>
          </>}
        </PopoverMenu>
      ) : null}
    </div>
    {warning ? <p className="pipeline-manager__warning" role="alert">{warning}</p> : null}
    {nameDialogKind ? (
      <PipelineNameDialog
        key={nameDialogKind}
        kind={nameDialogKind}
        groupId={nameDialogKind === "create" ? dialog?.groupId ?? null : null}
        pipeline={active}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onSelect={onSelect}
      />
    ) : null}
    {dialog?.kind === "channels" ? (
      <PipelineChannelsDialog
        key={`channels:${active.id}`}
        pipeline={active}
        pipelines={pipelines}
        channels={channels}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
      />
    ) : null}
    {dialog?.kind === "rules" ? (
      <PipelineRulesDialog
        key={`rules:${active.id}`}
        pipeline={active}
        onClose={() => setDialog(null)}
      />
    ) : null}
    {dialog?.kind === "delete" && dialogPipeline ? (
      <PipelineDeleteDialog
        key={`delete:${dialogPipeline.id}`}
        pipeline={dialogPipeline}
        pipelines={pipelines}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onSelect={dialogPipeline.id === active.id ? onSelect : () => {}}
        onChanged={onChanged}
      />
    ) : null}
    {dialog && (dialog.kind === "group-create" || dialog.kind === "group-rename") ? (
      <GroupNameDialog
        key={dialog.kind}
        kind={dialog.kind}
        group={orderedGroups.find((candidate) => candidate.id === dialog.groupId)}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onChanged={onChanged}
      />
    ) : null}
    {dialog?.kind === "group-archive" && dialogGroup ? (
      <GroupArchiveDialog
        key={dialogGroup.id}
        group={dialogGroup}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onChanged={onChanged}
      />
    ) : null}
    {dialog?.kind === "pipeline-move" && dialogPipeline ? (
      <MovePipelineDialog
        key={dialogPipeline.id}
        pipeline={dialogPipeline}
        groups={orderedGroups}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onChanged={onChanged}
      />
    ) : null}
    <SaveToast show={saved.done}>{savedMessage}</SaveToast>
  </>;
}

/** Dialog pequeno (nome + cor) compartilhado por Novo / Renomear / Duplicar. */
function PipelineNameDialog({
  kind,
  pipeline,
  groupId = null,
  onClose,
  onSaved,
  onSelect
}: {
  kind: NameDialogKind;
  pipeline: PipelineSummary;
  groupId?: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onSelect: (pipelineId: string) => void;
}) {
  const isDuplicate = kind === "duplicate";
  const [name, setName] = useState(kind === "rename" ? pipeline.name : isDuplicate ? `${pipeline.name} (cópia)` : "");
  const [color, setColor] = useState<string>(kind === "rename" ? pipeline.color : PIPELINE_COLOR_SWATCHES[0]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const title = kind === "create" ? "Novo pipeline" : isDuplicate ? "Duplicar pipeline" : "Renomear pipeline";

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError("");
    try {
      if (kind === "create") {
        const created = await api<{ pipeline: PipelineSummary }>("/organization/pipelines", {
          method: "POST",
          body: JSON.stringify({ name: trimmed, color, ...(groupId ? { group_id: groupId } : {}) })
        });
        onSelect(created.pipeline.id);
      } else if (isDuplicate) {
        const created = await api<{ pipeline: PipelineSummary }>(`/organization/pipelines/${pipeline.id}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ name: trimmed })
        });
        onSelect(created.pipeline.id);
      } else {
        await api(`/organization/pipelines/${pipeline.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: trimmed, color })
        });
      }
      onSaved(kind === "create" ? "Pipeline criado" : isDuplicate ? "Pipeline duplicado" : "Pipeline renomeado");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar pipeline");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog className="pipeline-manager-dialog" labelledBy="pipeline-manager-name-title" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-name-title" className="text-base font-semibold">{title}</h2>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Nome"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} data-autofocus /></Field>
        {isDuplicate ? (
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">Etapas e transições são copiadas. Contatos e canais vinculados permanecem no original.</p>
        ) : (
          <fieldset>
            <legend className="label mb-2">Cor</legend>
            <div className="pipeline-manager__swatches">
              {PIPELINE_COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className="pipeline-manager__swatch"
                  style={{ background: swatch }}
                  aria-pressed={color === swatch}
                  aria-label={`Cor ${swatch}`}
                  onClick={() => setColor(swatch)}
                />
              ))}
            </div>
          </fieldset>
        )}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
          <SaveButton type="submit" state={pending ? "busy" : "idle"} busyLabel="Salvando…" disabled={!name.trim() || pending}>
            {kind === "create" ? "Criar pipeline" : "Salvar"}
          </SaveButton>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Dialog pequeno de grupo (criar/renomear) — só nome, sem cor. */
function GroupNameDialog({
  kind,
  group,
  onClose,
  onSaved,
  onChanged
}: {
  kind: "group-create" | "group-rename";
  group?: PipelineGroup;
  onClose: () => void;
  onSaved: (message: string) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [name, setName] = useState(kind === "group-rename" ? group?.name ?? "" : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const isCreate = kind === "group-create";

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError("");
    try {
      if (isCreate) {
        await api("/organization/pipeline-groups", { method: "POST", body: JSON.stringify({ name: trimmed }) });
      } else {
        await api(`/organization/pipeline-groups/${group?.id}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) });
      }
      onSaved(isCreate ? "Grupo criado" : "Grupo renomeado");
      void onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar grupo");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog className="pipeline-manager-dialog" labelledBy="pipeline-manager-group-title" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-group-title" className="text-base font-semibold">{isCreate ? "Novo grupo" : "Renomear grupo"}</h2>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Nome"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} data-autofocus /></Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
          <SaveButton type="submit" state={pending ? "busy" : "idle"} busyLabel="Salvando…" disabled={!name.trim() || pending}>
            {isCreate ? "Criar grupo" : "Salvar"}
          </SaveButton>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Arquivar grupo: pipelines NÃO são excluídos — ficam sem grupo (o servidor desagrupa). */
function GroupArchiveDialog({
  group,
  onClose,
  onSaved,
  onChanged
}: {
  group: PipelineGroup;
  onClose: () => void;
  onSaved: (message: string) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline-groups/${group.id}/archive`, { method: "POST", body: JSON.stringify({}) });
      onSaved("Grupo arquivado");
      void onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao arquivar grupo");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog className="pipeline-manager-dialog" labelledBy="pipeline-manager-group-archive-title" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-group-archive-title" className="text-base font-semibold">Arquivar grupo</h2>
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
        Arquivar o grupo “{group.name}”? Os pipelines dele não são excluídos — ficam sem grupo, soltos no seletor.
      </p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
        <Button type="button" tone="danger" disabled={pending} onClick={() => void confirm()}>
          <Trash size={15} aria-hidden="true" /> Arquivar
        </Button>
      </div>
    </ModalDialog>
  );
}

/** Mover pipeline de grupo (PATCH {group_id}); "Sem grupo" envia null. */
function MovePipelineDialog({
  pipeline,
  groups,
  onClose,
  onSaved,
  onChanged
}: {
  pipeline: PipelineSummary;
  groups: PipelineGroup[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [groupId, setGroupId] = useState(pipeline.group_id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipelines/${pipeline.id}`, {
        method: "PATCH",
        body: JSON.stringify({ group_id: groupId || null })
      });
      onSaved("Pipeline movido");
      void onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao mover pipeline");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog className="pipeline-manager-dialog" labelledBy="pipeline-manager-move-title" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-move-title" className="text-base font-semibold">Mover pipeline</h2>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Grupo de “{pipeline.name}”">
          <Select value={groupId} disabled={pending} onChange={(event) => setGroupId(event.target.value)} data-autofocus>
            <option value="">Sem grupo</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </Select>
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
          <SaveButton type="submit" state={pending ? "busy" : "idle"} busyLabel="Movendo…" disabled={pending}>Mover</SaveButton>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Checklist dos canais de entrada (PUT /organization/pipelines/:id/channels). */
function PipelineChannelsDialog({
  pipeline,
  pipelines,
  channels,
  onClose,
  onSaved
}: {
  pipeline: PipelineSummary;
  pipelines: PipelineSummary[];
  channels: PipelineChannelLink[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(channels.filter((channel) => channel.pipeline_id === pipeline.id).map((channel) => channel.id))
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function toggle(sessionId: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  async function save() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipelines/${pipeline.id}/channels`, {
        method: "PUT",
        body: JSON.stringify({ session_ids: [...checked] })
      });
      onSaved("Canais vinculados");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar canais");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog labelledBy="pipeline-manager-channels-title" describedBy="pipeline-manager-channels-description" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-channels-title" className="text-base font-semibold">Canais vinculados</h2>
      <p id="pipeline-manager-channels-description" className="text-xs leading-relaxed text-[var(--text-secondary)]">
        Novos contatos que chegarem por estes canais entram na primeira etapa deste pipeline. Canais sem vínculo usam o pipeline padrão.
      </p>
      <div className="pipeline-manager__channels">
        {channels.map((channel) => {
          const linkedName = channel.pipeline_id && channel.pipeline_id !== pipeline.id
            ? pipelines.find((candidate) => candidate.id === channel.pipeline_id)?.name ?? "outro pipeline"
            : null;
          return (
            <label key={channel.id} className="pipeline-manager__channel">
              <input type="checkbox" checked={checked.has(channel.id)} disabled={pending} onChange={() => toggle(channel.id)} />
              <span className="min-w-0 flex-1">
                <strong className="block text-sm">{channel.label}</strong>
                <span className="block text-xs text-[var(--text-secondary)]">{channel.phone_number || channel.instagram_username || channel.channel}</span>
              </span>
              {linkedName ? <span className="pipeline-manager__channel-note">hoje em {linkedName}</span> : null}
            </label>
          );
        })}
        {channels.length === 0 ? (
          <p className="rounded border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--text-secondary)]">Nenhum canal ativo.</p>
        ) : null}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
        <SaveButton state={pending ? "busy" : "idle"} busyLabel="Salvando…" onClick={() => void save()} disabled={pending}>Salvar canais</SaveButton>
      </div>
    </ModalDialog>
  );
}

/** Toggle "Movimentação livre" (PATCH /organization/pipeline/settings, por pipeline). */
function PipelineRulesDialog({ pipeline, onClose }: { pipeline: PipelineSummary; onClose: () => void }) {
  const [freeMovement, setFreeMovement] = useState(pipeline.enforce_transitions !== true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveFeedback();

  async function toggle(value: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api("/organization/pipeline/settings", {
        method: "PATCH",
        body: JSON.stringify({ enforce_transitions: !value, pipeline_id: pipeline.id })
      });
      setFreeMovement(value);
      save.markDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar regras");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog labelledBy="pipeline-manager-rules-title" onClose={onClose}>
      <h2 id="pipeline-manager-rules-title" className="text-base font-semibold">Regras de movimentação</h2>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={freeMovement} disabled={pending} onChange={(event) => void toggle(event.target.checked)} />
        <span>
          <strong className="block">Movimentação livre entre etapas</strong>
          <span className="text-[var(--text-secondary)]">
            Permite mover leads para qualquer etapa do quadro. Desligado, valem só os movimentos permitidos configurados na matriz de cada etapa (dialog Automações da etapa).
          </span>
        </span>
      </label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <SaveToast show={save.done}>Regras atualizadas</SaveToast>
    </ModalDialog>
  );
}

/** Exclusão (POST :/archive); com leads, o pipeline substituto é obrigatório. */
function PipelineDeleteDialog({
  pipeline,
  pipelines,
  onClose,
  onSaved,
  onSelect,
  onChanged
}: {
  pipeline: PipelineSummary;
  pipelines: PipelineSummary[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onSelect: (pipelineId: string | null) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const others = pipelines.filter((candidate) => candidate.id !== pipeline.id);
  const needsReplacement = pipeline.lead_count > 0;
  const [replacement, setReplacement] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function confirmDelete() {
    if (pending || (needsReplacement && !replacement)) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipelines/${pipeline.id}/archive`, {
        method: "POST",
        body: JSON.stringify(needsReplacement ? { replacement_pipeline_id: replacement } : {})
      });
      onSaved("Pipeline excluído");
      onSelect(replacement || null);
      void onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao excluir pipeline");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog labelledBy="pipeline-manager-delete-title" onClose={() => { if (!pending) onClose(); }}>
      <h2 id="pipeline-manager-delete-title" className="text-base font-semibold">Excluir pipeline</h2>
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">Excluir o pipeline “{pipeline.name}”?</p>
      {needsReplacement ? (
        <>
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            Este pipeline tem {pipeline.lead_count} contato(s). Selecione o pipeline que receberá os contatos.
          </p>
          <Field label="Pipeline que receberá os contatos">
            <Select value={replacement} disabled={pending} onChange={(event) => setReplacement(event.target.value)} data-autofocus>
              <option value="">Selecione</option>
              {others.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </Select>
          </Field>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">Este pipeline não tem contatos. Nenhum lead será afetado.</p>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" tone="quiet" disabled={pending} onClick={onClose}>Cancelar</Button>
        <Button type="button" tone="danger" disabled={pending || (needsReplacement && !replacement)} onClick={() => void confirmDelete()}>
          <Trash size={15} aria-hidden="true" /> Excluir
        </Button>
      </div>
    </ModalDialog>
  );
}

"use client";

import { ArrowLeft, ArrowRight, Copy, DotsThree, Lightning, PencilSimple, Trash, X } from "@/components/icons";
import { ModalDialog } from "@/components/modal-dialog";
import { PopoverMenu } from "@/components/popover-menu";
import type { LeadTag } from "@/components/lead-tag-picker";
import { Field, HelpHint, Input, SaveButton, Select, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import { PIPELINE_COLOR_SWATCHES, STAGE_BEHAVIOR_OPTIONS, type PipelineStage, type PipelineTransition } from "@/lib/pipeline";
import { useEffect, useState } from "react";

/*
  Gerenciamento de etapas no quadro (pipeline.manage): menu ⋯ da coluna
  (editar, cor, automações, duplicar, mover esq/dir, excluir) e a coluna
  fantasma "+ Nova etapa". Reordenar por drag mora no pipeline-board
  (handlers da alça); mover via menu chega aqui por onMoveStage.
*/

type StageMember = { id: string; name: string | null; email: string; status: string };

export function PipelineStageMenu({
  stage,
  stages,
  enforceTransitions = false,
  transitions = [],
  onChanged,
  onMoveStage
}: {
  stage: PipelineStage;
  /** Todas as colunas do quadro (as operacionais de IA são ignoradas aqui). */
  stages: PipelineStage[];
  enforceTransitions?: boolean;
  transitions?: PipelineTransition[];
  onChanged: () => unknown | Promise<unknown>;
  onMoveStage: (stageId: string, direction: -1 | 1) => void;
}) {
  const [dialog, setDialog] = useState<null | "edit" | "automations" | "delete">(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const persistable = stages.filter((candidate) => !candidate.operational_kind);
  const index = persistable.findIndex((candidate) => candidate.id === stage.id);

  async function changeColor(close: () => void, color: string) {
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}`, { method: "PATCH", body: JSON.stringify({ color }) });
      await onChanged();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao alterar a cor");
    } finally {
      setPending(false);
    }
  }

  async function duplicate(close: () => void) {
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}/duplicate`, { method: "POST" });
      await onChanged();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao duplicar etapa");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PopoverMenu
        buttonClassName="pipeline-column__menu"
        icon={<DotsThree size={15} weight="bold" aria-hidden="true" />}
        ariaLabel={`Ações da etapa ${stage.name}`}
        title="Ações da etapa"
        panelClassName="conversation-action-menu__panel"
      >
        {(close) => (
          <>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("edit"); }}>
              <PencilSimple size={15} aria-hidden="true" /> Editar etapa
            </button>
            <div className="pipeline-stage-swatches" role="group" aria-label={`Alterar cor da etapa ${stage.name}`}>
              {PIPELINE_COLOR_SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="menuitem"
                  aria-label={`Alterar cor para ${color}`}
                  aria-current={stage.color.toUpperCase() === color ? "true" : undefined}
                  style={{ backgroundColor: color }}
                  disabled={pending}
                  onClick={() => void changeColor(close, color)}
                />
              ))}
            </div>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("automations"); }}>
              <Lightning size={15} aria-hidden="true" /> Automações e regras
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" disabled={pending} onClick={() => void duplicate(close)}>
              <Copy size={15} aria-hidden="true" /> Duplicar
            </button>
            <button
              type="button"
              role="menuitem"
              className="conversation-action-menu__item"
              disabled={index <= 0}
              onClick={() => { close(); onMoveStage(stage.id, -1); }}
            >
              <ArrowLeft size={15} aria-hidden="true" /> Mover para a esquerda
            </button>
            <button
              type="button"
              role="menuitem"
              className="conversation-action-menu__item"
              disabled={index < 0 || index >= persistable.length - 1}
              onClick={() => { close(); onMoveStage(stage.id, 1); }}
            >
              <ArrowRight size={15} aria-hidden="true" /> Mover para a direita
            </button>
            <button
              type="button"
              role="menuitem"
              className="conversation-action-menu__item conversation-action-menu__item--warn"
              onClick={() => { close(); setDialog("delete"); }}
            >
              <Trash size={15} aria-hidden="true" /> Excluir etapa
            </button>
            {error ? <p className="pipeline-note pipeline-note--error" role="alert">{error}</p> : null}
          </>
        )}
      </PopoverMenu>
      {dialog === "edit" ? <StageEditDialog stage={stage} onClose={() => setDialog(null)} onChanged={onChanged} /> : null}
      {dialog === "automations" ? (
        <StageAutomationsDialog stage={stage} stages={stages} enforceTransitions={enforceTransitions} transitions={transitions} onClose={() => setDialog(null)} onChanged={onChanged} />
      ) : null}
      {dialog === "delete" ? <StageDeleteDialog stage={stage} stages={stages} onClose={() => setDialog(null)} onChanged={onChanged} /> : null}
    </>
  );
}

function DialogShell({ title, description, labelledBy, onClose, children }: {
  title: string;
  description?: string;
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <ModalDialog overlayClassName="pipeline-dialog-overlay" dialogClassName="pipeline-dialog" labelledBy={labelledBy} onClose={onClose}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={labelledBy} className="text-lg font-semibold">{title}</h2>
          {description ? <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-[var(--text-secondary)]">{description}</p> : null}
        </div>
        <button type="button" className="grid size-9 shrink-0 place-items-center rounded border border-[var(--border)] active:scale-[.94]" onClick={onClose} aria-label="Fechar">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {children}
    </ModalDialog>
  );
}

function StageEditDialog({ stage, onClose, onChanged }: { stage: PipelineStage; onClose: () => void; onChanged: () => unknown | Promise<unknown>; }) {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [behavior, setBehavior] = useState(stage.technical_status);
  const [capacity, setCapacity] = useState(stage.capacity_target ? String(stage.capacity_target) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveFeedback();

  async function submit() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          color,
          technical_status: behavior,
          capacity_target: capacity ? Number(capacity) : null
        })
      });
      await onChanged();
      save.markDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar etapa");
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell
      labelledBy="pipeline-stage-edit-title"
      title={`Editar etapa ${stage.name}`}
      description="Nome, cor, comportamento e meta de capacidade da etapa."
      onClose={pending ? () => undefined : onClose}
    >
      <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Nome">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} data-autofocus />
        </Field>
        <div>
          <span className="label">Cor</span>
          <div className="pipeline-stage-swatches mt-1">
            {PIPELINE_COLOR_SWATCHES.map((swatch) => (
              <button key={swatch} type="button" aria-label={`Cor ${swatch}`} aria-pressed={color.toUpperCase() === swatch} style={{ backgroundColor: swatch }} onClick={() => setColor(swatch)} />
            ))}
          </div>
          <input className="input mt-2 h-10 p-1" type="color" value={color.toLowerCase()} onChange={(event) => setColor(event.target.value.toUpperCase())} aria-label="Cor personalizada" />
        </div>
        <Field label="Comportamento" help="Define o que o sistema pede ao mover um lead para cá: dados da venda no Ganho, motivo da perda no Perdido e próxima ação com data em Negociação, Proposta e Follow-up.">
          <Select value={behavior} onChange={(event) => setBehavior(event.target.value)}>
            {STAGE_BEHAVIOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="Meta de capacidade" help="Meta visual: o rodapé da coluna mostra o preenchimento em relação a esse número. Não bloqueia a entrada de novos leads.">
          <Input type="number" min="1" value={capacity} onChange={(event) => setCapacity(event.target.value)} placeholder="Sem meta" />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancelar</button>
          <SaveButton state={pending ? "busy" : save.state} onClick={() => void submit()} disabled={pending || !name.trim()} busyLabel="Salvando…" />
        </div>
      </form>
    </DialogShell>
  );
}

function StageAutomationsDialog({
  stage,
  stages,
  enforceTransitions,
  transitions,
  onClose,
  onChanged
}: {
  stage: PipelineStage;
  stages: PipelineStage[];
  enforceTransitions: boolean;
  transitions: PipelineTransition[];
  onClose: () => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [tags, setTags] = useState<LeadTag[] | null>(null);
  const [members, setMembers] = useState<StageMember[] | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set(stage.automation?.add_tag_ids ?? []));
  const [assignee, setAssignee] = useState(stage.automation?.assign_member_id ?? "");
  const [targets, setTargets] = useState<Set<string>>(() => new Set(transitions.filter((transition) => transition.from_stage_id === stage.id).map((transition) => transition.to_stage_id)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveFeedback();

  useEffect(() => {
    let alive = true;
    api<{ tags: LeadTag[] }>("/organization/tags")
      .then((data) => { if (alive) setTags((data.tags ?? []).filter((tag) => !tag.archived_at)); })
      .catch(() => { if (alive) setTags([]); });
    api<{ members: StageMember[] }>("/workspaces/current/members")
      .then((data) => { if (alive) setMembers((data.members ?? []).filter((member) => member.status === "active")); })
      .catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, []);

  const otherStages = stages.filter((candidate) => candidate.id !== stage.id && !candidate.operational_kind);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}`, {
        method: "PATCH",
        body: JSON.stringify({ automation: { add_tag_ids: [...selectedTags], assign_member_id: assignee || null } })
      });
      if (enforceTransitions) {
        await api(`/organization/pipeline/stages/${stage.id}/transitions`, { method: "PUT", body: JSON.stringify({ to_stage_ids: [...targets] }) });
      }
      await onChanged();
      save.markDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar automações");
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell
      labelledBy="pipeline-stage-automations-title"
      title={`Automações e regras · ${stage.name}`}
      description="O que acontece quando um lead entra nesta etapa."
      onClose={pending ? () => undefined : onClose}
    >
      <form className="mt-4 grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset>
          <legend className="label mb-2 flex items-center gap-1">Etiquetas ao entrar<HelpHint label="Ajuda: Etiquetas ao entrar">Etiquetas aplicadas automaticamente a todo lead que entrar nesta etapa.</HelpHint></legend>
          {tags === null ? <p className="pipeline-note">Carregando etiquetas…</p> : tags.length === 0 ? <p className="pipeline-note">Nenhuma etiqueta ativa.</p> : (
            <div className="grid max-h-40 gap-1.5 overflow-y-auto">
              {tags.map((tag) => (
                <label key={tag.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selectedTags.has(tag.id)}
                    onChange={(event) => setSelectedTags((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(tag.id);
                      else next.delete(tag.id);
                      return next;
                    })}
                  />
                  <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                  {tag.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <Field label="Responsável ao entrar" help="Escolhe quem fica com os leads que entrarem nesta etapa. Sem escolha, o responsável atual é mantido.">
          <Select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">Manter o responsável atual</option>
            {(members ?? []).map((member) => <option key={member.id} value={member.id}>{member.name ?? member.email}</option>)}
          </Select>
        </Field>
        {enforceTransitions ? (
          <fieldset>
            <legend className="label mb-2">Pode seguir para</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {otherStages.map((candidate) => (
                <label key={candidate.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={targets.has(candidate.id)}
                    onChange={(event) => setTargets((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(candidate.id);
                      else next.delete(candidate.id);
                      return next;
                    })}
                  />
                  <span className="size-2 rounded-full" style={{ backgroundColor: candidate.color }} aria-hidden="true" />
                  {candidate.name}
                </label>
              ))}
            </div>
            <p className="pipeline-note mt-1">Pipeline em modo governado: só destes movimentos são permitidos a partir desta etapa.</p>
          </fieldset>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancelar</button>
          <SaveButton state={pending ? "busy" : save.state} onClick={() => void submit()} disabled={pending} busyLabel="Salvando…">Salvar regras</SaveButton>
        </div>
      </form>
    </DialogShell>
  );
}

function StageDeleteDialog({ stage, stages, onClose, onChanged }: { stage: PipelineStage; stages: PipelineStage[]; onClose: () => void; onChanged: () => unknown | Promise<unknown>; }) {
  const leadCount = stage.lead_count ?? 0;
  const needsReplacement = leadCount > 0;
  const others = stages.filter((candidate) => candidate.id !== stage.id && !candidate.operational_kind);
  const [replacement, setReplacement] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (pending || (needsReplacement && !replacement)) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}/archive`, {
        method: "POST",
        body: JSON.stringify(replacement ? { replacement_stage_id: replacement } : {})
      });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao excluir etapa");
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell
      labelledBy="pipeline-stage-delete-title"
      title={`Excluir etapa ${stage.name}`}
      description={needsReplacement ? `Esta etapa tem ${leadCount} lead(s): escolha a etapa que receberá os contatos.` : "A etapa será arquivada e some do quadro."}
      onClose={pending ? () => undefined : onClose}
    >
      <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {needsReplacement ? (
          <Field label="Etapa que receberá os contatos">
            <Select value={replacement} onChange={(event) => setReplacement(event.target.value)} required data-autofocus>
              <option value="">Selecione</option>
              {others.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancelar</button>
          <button type="submit" className="btn danger" disabled={pending || (needsReplacement && !replacement)}>Excluir</button>
        </div>
      </form>
    </DialogShell>
  );
}

/**
 * Coluna fantasma "+ Nova etapa" (pipeline.manage). Enter cria no fim do
 * pipeline (backend coloca position/technical_status padrão); Esc cancela.
 */
export function NewStageColumn({ pipelineId, color, onChanged }: {
  pipelineId: string;
  color: string;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      await api("/organization/pipeline/stages", {
        method: "POST",
        body: JSON.stringify({ pipeline_id: pipelineId, name: name.trim(), color })
      });
      setName("");
      setCreating(false);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao criar etapa");
    } finally {
      setPending(false);
    }
  }

  if (!creating) {
    return (
      <section className="pipeline-column pipeline-column--new" aria-label="Nova etapa">
        <button type="button" className="pipeline-column__add" onClick={() => setCreating(true)}>+ Nova etapa</button>
      </section>
    );
  }

  return (
    <section className="pipeline-column pipeline-column--new" aria-label="Nova etapa">
      <input
        className="input pipeline-column__new-input"
        value={name}
        autoFocus
        disabled={pending}
        maxLength={80}
        placeholder="Nome da etapa"
        aria-label="Nome da nova etapa"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setName("");
            setCreating(false);
            setError("");
          }
          if (event.key === "Enter" && name.trim() && !pending) {
            event.preventDefault();
            void create();
          }
        }}
      />
      {error ? <p className="pipeline-note pipeline-note--error" role="alert">{error}</p> : null}
    </section>
  );
}

"use client";

import {
  ArrowsLeftRight,
  CaretDown,
  Check,
  Copy,
  DotsThreeVertical,
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
import { PIPELINE_COLOR_SWATCHES, type PipelineChannelLink, type PipelineSummary } from "@/lib/pipeline";
import { useState } from "react";

type NameDialogKind = "create" | "rename" | "duplicate";
type DialogKind = NameDialogKind | "channels" | "rules" | "delete";

/**
 * Seletor de pipeline + menu ⋯ (novo/renomear/duplicar/padrão/canais/regras/
 * excluir) do cabeçalho de /pipeline. A página carrega GET /organization/pipelines
 * e resolve o pipeline ativo (URL > localStorage > is_default); aqui só acontece
 * a edição — revalidação via onChanged, seleção via onSelect.
 */
export function PipelineManager({
  pipelines,
  activePipeline,
  channels = [],
  canManage,
  onSelect,
  onChanged
}: {
  pipelines: PipelineSummary[];
  activePipeline: PipelineSummary | null;
  channels?: PipelineChannelLink[];
  canManage: boolean;
  onSelect: (pipelineId: string | null) => void;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const saved = useSaveFeedback();
  const [savedMessage, setSavedMessage] = useState("");

  if (!activePipeline) return null;
  const active: PipelineSummary = activePipeline;

  function notifySaved(message: string) {
    setSavedMessage(message);
    saved.markDone();
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
        {(close) => <>
          {pipelines.map((pipeline) => (
            <button
              key={pipeline.id}
              type="button"
              role="menuitem"
              className="pipeline-switcher__item"
              aria-current={pipeline.id === active.id ? "true" : undefined}
              onClick={() => { close(); onSelect(pipeline.id); }}
            >
              <span className="pipeline-switcher__dot" style={{ background: pipeline.color }} aria-hidden="true" />
              <span className="pipeline-switcher__name">{pipeline.name}</span>
              <span className="pipeline-switcher__count">{pipeline.lead_count} lead(s)</span>
              {pipeline.id === active.id ? <Check size={14} className="pipeline-switcher__check" aria-hidden="true" /> : null}
            </button>
          ))}
          {canManage ? (
            <div className="pipeline-switcher__new">
              <button type="button" role="menuitem" className="pipeline-switcher__item" onClick={() => { close(); setDialog("create"); }}>
                <Plus size={15} aria-hidden="true" /> Novo pipeline
              </button>
            </div>
          ) : null}
        </>}
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
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("rename"); }}>
              <PencilSimple size={15} aria-hidden="true" /> Renomear / editar
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("duplicate"); }}>
              <Copy size={15} aria-hidden="true" /> Duplicar
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); focusNewStageColumn(); }}>
              <Kanban size={15} aria-hidden="true" /> Configurar etapas
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("rules"); }}>
              <ArrowsLeftRight size={15} aria-hidden="true" /> Regras de movimentação
            </button>
            <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); setDialog("channels"); }}>
              <LinkSimple size={15} aria-hidden="true" /> Canais vinculados
            </button>
            {!active.is_default ? (
              <button type="button" role="menuitem" className="conversation-action-menu__item" onClick={() => { close(); void makeDefault(); }}>
                <Star size={15} aria-hidden="true" /> Definir como padrão
              </button>
            ) : null}
            <button type="button" role="menuitem" className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={() => { close(); setDialog("delete"); }}>
              <Trash size={15} aria-hidden="true" /> Excluir pipeline
            </button>
          </>}
        </PopoverMenu>
      ) : null}
    </div>
    {dialog === "create" || dialog === "rename" || dialog === "duplicate" ? (
      <PipelineNameDialog
        key={dialog}
        kind={dialog}
        pipeline={active}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onSelect={onSelect}
      />
    ) : null}
    {dialog === "channels" ? (
      <PipelineChannelsDialog
        key={`channels:${active.id}`}
        pipeline={active}
        pipelines={pipelines}
        channels={channels}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
      />
    ) : null}
    {dialog === "rules" ? (
      <PipelineRulesDialog
        key={`rules:${active.id}`}
        pipeline={active}
        onClose={() => setDialog(null)}
      />
    ) : null}
    {dialog === "delete" ? (
      <PipelineDeleteDialog
        key={`delete:${active.id}`}
        pipeline={active}
        pipelines={pipelines}
        onClose={() => setDialog(null)}
        onSaved={notifySaved}
        onSelect={onSelect}
      />
    ) : null}
    <SaveToast show={saved.done}>{savedMessage}</SaveToast>
  </>;
}

/** Dialog pequeno (nome + cor) compartilhado por Novo / Renomear / Duplicar. */
function PipelineNameDialog({
  kind,
  pipeline,
  onClose,
  onSaved,
  onSelect
}: {
  kind: NameDialogKind;
  pipeline: PipelineSummary;
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
          body: JSON.stringify({ name: trimmed, color })
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
  onSelect
}: {
  pipeline: PipelineSummary;
  pipelines: PipelineSummary[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onSelect: (pipelineId: string | null) => void;
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

"use client";

import { Archive, PhoneCall, Plus, SlidersHorizontal, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import { CANONICAL_PIPELINE_STATUSES, pipelineStatusLabel, type PipelineFollowUpConfig } from "@/lib/pipeline";
import { usePermission } from "@/lib/use-permission";
import { Button, Field, Input, Select } from "@/components/ui";
import { SETTINGS_COLOR_DEFAULTS } from "@/components/settings-colors";
import styles from "@/components/settings-panels.module.css";

export type ConfigurablePipelineStage = {
  id: string;
  name: string;
  color: string;
  position: number;
  capacity_target?: number | null;
  technical_status: string;
  is_default: boolean;
  lead_count?: number;
  archived_at?: string | null;
};
export type ConfigurablePipelineTransition = { from_stage_id: string; to_stage_id: string };

const technicalStatuses = CANONICAL_PIPELINE_STATUSES;
const technicalTransitions: Record<string, readonly string[]> = {
  novo: ["novo", "em_atendimento", "perdido"],
  em_atendimento: ["em_atendimento", "aguardando_resposta", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  aguardando_resposta: ["aguardando_resposta", "em_atendimento", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  qualificado: ["qualificado", "em_atendimento", "agendado", "em_negociacao", "proposta_enviada", "follow_up", "perdido"],
  agendado: ["agendado", "qualificado", "em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"],
  em_negociacao: ["em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"],
  proposta_enviada: ["proposta_enviada", "em_negociacao", "qualificado", "follow_up", "fechado", "perdido"],
  follow_up: ["follow_up", "em_atendimento", "aguardando_resposta", "qualificado", "agendado", "em_negociacao", "proposta_enviada", "fechado", "perdido"],
  fechado: ["fechado"],
  perdido: ["perdido", "em_atendimento", "follow_up"]
};

export function PipelineSettings({
  stages,
  transitions,
  followUpConfig,
  onChanged
}: {
  stages: ConfigurablePipelineStage[];
  transitions: ConfigurablePipelineTransition[];
  followUpConfig?: PipelineFollowUpConfig;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const canManage = usePermission("pipeline.manage");
  const organizationEnabled = useCaseOrganizationEnabled();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [technicalStatus, setTechnicalStatus] = useState("novo");
  const [color, setColor] = useState<string>(SETTINGS_COLOR_DEFAULTS.pipelineStage);
  const [capacity, setCapacity] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!canManage || organizationEnabled !== true) return null;

  async function createStage() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      await api("/organization/pipeline/stages", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          technical_status: technicalStatus,
          color,
          position: Math.max(10, ...stages.map((stage) => stage.position + 10)),
          capacity_target: capacity ? Number(capacity) : null,
          is_default: false
        })
      });
      setName("");
      setCapacity("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao criar etapa");
    } finally {
      setPending(false);
    }
  }

  return <>
    <Button onClick={() => setOpen(true)}><SlidersHorizontal size={15} aria-hidden="true" />Configurar</Button>
    {open ? (
      <ModalDialog className="pipeline-settings-dialog" labelledBy="pipeline-settings-title" describedBy="pipeline-settings-description" onClose={() => { if (!pending) setOpen(false); }}>
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <span className="label">Organização do quadro</span>
            <h2 id="pipeline-settings-title" className="mt-1 text-lg font-semibold">Configurar pipeline</h2>
            <p id="pipeline-settings-description" className="mt-1 max-w-[65ch] text-xs leading-relaxed text-[var(--text-secondary)]">Edite ordem, capacidade e movimentos. As regras comerciais continuam protegidas pelo status técnico.</p>
          </div>
          <button type="button" className="grid size-9 shrink-0 place-items-center rounded border border-[var(--border)] active:scale-[.94]" onClick={() => setOpen(false)} aria-label="Fechar configuração"><X size={16} aria-hidden="true" /></button>
        </header>

        <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
          {followUpConfig?.enabled ? (
            <aside className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-active)]/55 p-3" aria-label="Etapas automáticas da IA">
              <PhoneCall className="mt-0.5 shrink-0 text-[var(--primary-text)]" size={18} aria-hidden="true" />
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]"><strong className="block text-sm">Fluxo automático visível no quadro</strong>As {followUpConfig.max_count} tentativa(s) configuradas na IA aparecem como Follow-up 1 a {followUpConfig.max_count}; ao final, o lead segue para Ligação. Essas colunas são sincronizadas automaticamente e não precisam ser criadas aqui.</p>
            </aside>
          ) : null}

          <section className={styles.dialogSection} aria-labelledby="pipeline-active-stages-title">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 id="pipeline-active-stages-title" className="text-sm font-semibold">Etapas ativas</h3>
              <span className="mono type-caption text-[var(--text-secondary)]">{stages.filter((stage) => !stage.archived_at).length} etapa(s)</span>
            </div>
            <div className="grid gap-2">
              {stages.filter((stage) => !stage.archived_at).sort((left, right) => left.position - right.position).map((stage) => (
                <StageEditor key={stage.id} stage={stage} stages={stages} transitions={transitions} onChanged={onChanged} />
              ))}
              {!stages.some((stage) => !stage.archived_at) ? <p className="rounded border border-dashed border-[var(--border)] p-5 text-center text-xs text-[var(--text-secondary)]">Nenhuma etapa ativa.</p> : null}
            </div>
          </section>

          <section className={styles.dialogSection}>
            <h3 className="text-sm font-semibold">Adicionar etapa</h3>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">Use uma etapa manual apenas quando ela representar uma fase comercial real.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field className="lg:col-span-2" label="Nome"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Field>
              <Field className="lg:col-span-2" label="Status técnico"><Select value={technicalStatus} onChange={(event) => setTechnicalStatus(event.target.value)}>{technicalStatuses.map((status) => <option key={status} value={status}>{pipelineStatusLabel(status)}</option>)}</Select></Field>
              <Field label="Cor"><Input className="h-10 p-1" type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} /></Field>
              <Field className="lg:col-span-2" label="Meta de capacidade"><Input type="number" min="1" value={capacity} onChange={(event) => setCapacity(event.target.value)} placeholder="Sem meta" /></Field>
              <Button tone="primary" className="self-end" onClick={() => void createStage()} disabled={!name.trim() || pending}><Plus size={15} aria-hidden="true" />{pending ? "Criando…" : "Adicionar"}</Button>
            </div>
            {error ? <p className="error mt-2" role="alert">{error}</p> : null}
          </section>
        </div>
      </ModalDialog>
    ) : null}
  </>;
}

function StageEditor({ stage, stages, transitions, onChanged }: { stage: ConfigurablePipelineStage; stages: ConfigurablePipelineStage[]; transitions: ConfigurablePipelineTransition[]; onChanged: () => unknown | Promise<unknown> }) {
  const [draft, setDraft] = useState({ name: stage.name, color: stage.color, position: String(stage.position), capacity: stage.capacity_target ? String(stage.capacity_target) : "", isDefault: stage.is_default });
  const [targets, setTargets] = useState(() => new Set(transitions.filter((transition) => transition.from_stage_id === stage.id).map((transition) => transition.to_stage_id)));
  const [replacement, setReplacement] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const possibleTargets = stages.filter((candidate) => !candidate.archived_at && candidate.id !== stage.id);
  const transitionTargets = possibleTargets.filter((candidate) => technicalTransitions[stage.technical_status]?.includes(candidate.technical_status));
  const replacementTargets = possibleTargets.filter((candidate) => candidate.technical_status === stage.technical_status);
  const needsReplacement = stage.is_default || (stage.lead_count ?? 0) > 0;

  useEffect(() => {
    setDraft({
      name: stage.name,
      color: stage.color,
      position: String(stage.position),
      capacity: stage.capacity_target ? String(stage.capacity_target) : "",
      isDefault: stage.is_default
    });
  }, [stage.capacity_target, stage.color, stage.is_default, stage.name, stage.position]);

  useEffect(() => {
    setTargets(new Set(transitions.filter((transition) => transition.from_stage_id === stage.id).map((transition) => transition.to_stage_id)));
  }, [stage.id, transitions]);

  async function save() {
    setPending(true); setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}`, { method: "PATCH", body: JSON.stringify({ name: draft.name.trim(), color: draft.color, position: Number(draft.position), capacity_target: draft.capacity ? Number(draft.capacity) : null, is_default: draft.isDefault }) });
      await api(`/organization/pipeline/stages/${stage.id}/transitions`, { method: "PUT", body: JSON.stringify({ to_stage_ids: [...targets] }) });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao salvar etapa"); }
    finally { setPending(false); }
  }

  async function archive() {
    if ((needsReplacement && !replacement) || pending) return;
    const confirmation = replacement
      ? `Arquivar a etapa “${stage.name}” e mover os leads para a substituta?`
      : `Arquivar a etapa “${stage.name}”?`;
    if (!window.confirm(confirmation)) return;
    setPending(true); setError("");
    try {
      await api(`/organization/pipeline/stages/${stage.id}/archive`, {
        method: "POST",
        body: JSON.stringify(replacement ? { replacement_stage_id: replacement } : {})
      });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao arquivar etapa"); }
    finally { setPending(false); }
  }

  return <details className="group overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 active:scale-[.99]"><span className="size-2.5 rounded-full" style={{ backgroundColor: stage.color }} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{stage.name}</span><span className="rounded bg-[var(--surface-active)] px-2 py-1 type-caption text-[var(--text-secondary)]">{pipelineStatusLabel(stage.technical_status)}</span><span className="mono type-caption text-[var(--text-muted)]">#{stage.position}</span></summary>
    <div className="grid gap-4 border-t border-[var(--border)] p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Nome"><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="Cor"><Input className="h-10 p-1" type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value.toUpperCase() }))} /></Field>
        <label className="field"><span className="label">Ordem</span><input className="input" type="number" min="0" value={draft.position} onChange={(event) => setDraft((current) => ({ ...current, position: event.target.value }))} /></label>
        <label className="field"><span className="label">Meta</span><input className="input" type="number" min="1" value={draft.capacity} onChange={(event) => setDraft((current) => ({ ...current, capacity: event.target.value }))} placeholder="Sem meta" /></label>
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.isDefault} disabled={stage.is_default} onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))} />Etapa padrão para {pipelineStatusLabel(stage.technical_status)}</label>
      <fieldset><legend className="label mb-2">Movimentos permitidos a partir desta etapa</legend><div className="grid gap-2 sm:grid-cols-2">{transitionTargets.map((target) => <label key={target.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={targets.has(target.id)} onChange={(event) => setTargets((current) => { const next = new Set(current); if (event.target.checked) next.add(target.id); else next.delete(target.id); return next; })} /><span className="size-2 rounded-full" style={{ backgroundColor: target.color }} />{target.name}</label>)}</div></fieldset>
      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={pending || !draft.name.trim()}>{pending ? "Salvando…" : "Salvar etapa"}</button>
        <label className="field min-w-52 flex-1"><span className="label">Substituta ao arquivar{needsReplacement ? " (obrigatória)" : " (opcional)"}</span><select className="input" value={replacement} onChange={(event) => setReplacement(event.target.value)}><option value="">{needsReplacement ? "Selecione" : "Sem substituta"}</option>{replacementTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
        <button type="button" className="btn warn" onClick={() => void archive()} disabled={(needsReplacement && !replacement) || pending}><Archive size={15} aria-hidden="true" />Arquivar</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  </details>;
}

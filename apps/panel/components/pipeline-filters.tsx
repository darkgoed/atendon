"use client";

import { Funnel, MagnifyingGlass, X } from "@phosphor-icons/react";
import {
  EMPTY_PIPELINE_FILTERS,
  type PipelineFilterKey,
  type PipelineFilters,
  type PipelineMember,
  type PipelineStage
} from "@/lib/pipeline";

const appointmentStatuses = [
  ["", "Todas"],
  ["confirmado", "Confirmada"],
  ["reagendado", "Reagendada"],
  ["concluido", "Concluída"],
  ["no_show", "No-show"],
  ["cancelado", "Cancelada"]
] as const;

const commercialOutcomes = [
  ["", "Todos"],
  ["em_negociacao", "Em negociação"],
  ["proposta_enviada", "Proposta enviada"],
  ["fechado", "Venda fechada"],
  ["nao_avancou", "Não avançou"],
  ["follow_up", "Follow-up"]
] as const;

const actionBuckets = [
  ["", "Todas"],
  ["today", "Ações de hoje"],
  ["result_pending", "Resultado pendente"],
  ["recovery", "Recuperação"],
  ["overdue_follow_up", "Follow-up atrasado"]
] as const;

export function PipelineFilters({
  filters,
  stages,
  members,
  hasWorkspaceScope,
  onChange
}: {
  filters: PipelineFilters;
  stages: PipelineStage[];
  members: PipelineMember[];
  hasWorkspaceScope: boolean;
  onChange: (filters: PipelineFilters) => void;
}) {
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const update = (key: PipelineFilterKey, value: string) => onChange({ ...filters, [key]: value });

  return (
    <section className="pipeline-filters" aria-label="Filtros do pipeline">
      <div className="pipeline-filters__row">
        <label className="search-field pipeline-filters__search">
          <span className="sr-only">Buscar lead</span>
          <MagnifyingGlass aria-hidden="true" />
          <input className="input" type="search" value={filters.busca} onChange={(event) => update("busca", event.target.value)} placeholder="Buscar leads" />
        </label>

        <details className="pipeline-filters__details group">
          <summary className="pipeline-filters__trigger">
            <Funnel size={14} aria-hidden="true" />
            Filtros{hasWorkspaceScope ? " de gestão" : ""}
            {activeFilters ? <span className="mono rounded bg-[var(--active)] px-1.5 py-0.5 text-[10px] text-[var(--accent-soft)]">{activeFilters}</span> : null}
          </summary>
          <div className="pipeline-filters__panel grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            <SelectFilter label="Etapa" value={filters.pipeline_stage_id} onChange={(value) => update("pipeline_stage_id", value)} options={[["", "Todas"], ...stages.map((stage) => [stage.id, stage.name] as const)]} />
            <SelectFilter label="Ação necessária" value={filters.action_bucket} onChange={(value) => update("action_bucket", value)} options={actionBuckets} />
            <SelectFilter label="Reunião" value={filters.appointment_status} onChange={(value) => update("appointment_status", value)} options={appointmentStatuses} />
            <SelectFilter label="Resultado comercial" value={filters.commercial_outcome} onChange={(value) => update("commercial_outcome", value)} options={commercialOutcomes} />
            <label className="field"><span className="label">Origem</span><input className="input" value={filters.origem} onChange={(event) => update("origem", event.target.value)} placeholder="Ex.: Instagram" /></label>
            <label className="field"><span className="label">Campanha</span><input className="input" value={filters.campanha} onChange={(event) => update("campanha", event.target.value)} placeholder="Nome da campanha" /></label>
            {hasWorkspaceScope ? <>
              <label className="field"><span className="label">Período inicial</span><input className="input" type="date" value={filters.period_start} max={filters.period_end || undefined} onChange={(event) => update("period_start", event.target.value)} /></label>
              <label className="field"><span className="label">Período final</span><input className="input" type="date" value={filters.period_end} min={filters.period_start || undefined} onChange={(event) => update("period_end", event.target.value)} /></label>
              <MemberFilter label="SDR" value={filters.sdr_member_id} members={members} onChange={(value) => update("sdr_member_id", value)} />
              <MemberFilter label="Closer" value={filters.closer_member_id} members={members} onChange={(value) => update("closer_member_id", value)} />
            </> : null}
          </div>
        </details>

        {activeFilters ? (
          <button type="button" className="pipeline-filters__clear" onClick={() => onChange({ ...EMPTY_PIPELINE_FILTERS })}>
            <X size={12} aria-hidden="true" /> Limpar
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SelectFilter({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <label className="field"><span className="label">{label}</span><select className="input" value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

function MemberFilter({ label, value, members, onChange }: { label: string; value: string; members: PipelineMember[]; onChange: (value: string) => void }) {
  return <SelectFilter label={label} value={value} onChange={onChange} options={[["", `Todos os ${label}s`], ...members.map((member) => [member.id, member.name ? `${member.name} · ${member.email}` : member.email] as const)]} />;
}

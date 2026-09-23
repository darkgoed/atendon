"use client";

import { CalendarBlank, HandPointing, Handshake, Kanban, MagnifyingGlass, Sparkle, Star } from "@/components/icons";
import { Input } from "@/components/ui";
import { ListFiltersBar, type ListFilterDef } from "@/components/ui/filters";
import {
  EMPTY_PIPELINE_FILTERS,
  type PipelineFilterKey,
  type PipelineFilters,
  type PipelineMember,
  type PipelineStage
} from "@/lib/pipeline";

const actionBuckets = [
  { id: "today", nome: "Ações de hoje" },
  { id: "result_pending", nome: "Resultado pendente" },
  { id: "recovery", nome: "Recuperação" },
  { id: "overdue_follow_up", nome: "Follow-up atrasado" }
] as const;

const appointmentStatuses = [
  { id: "confirmado", nome: "Confirmada" },
  { id: "reagendado", nome: "Reagendada" },
  { id: "concluido", nome: "Concluída" },
  { id: "no_show", nome: "No-show" },
  { id: "cancelado", nome: "Cancelada" }
] as const;

const commercialOutcomes = [
  { id: "em_negociacao", nome: "Em negociação" },
  { id: "proposta_enviada", nome: "Proposta enviada" },
  { id: "fechado", nome: "Venda fechada" },
  { id: "nao_avancou", nome: "Não avançou" },
  { id: "follow_up", nome: "Follow-up" }
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
  const setFilter = (key: PipelineFilterKey, value: string) => onChange({ ...filters, [key]: value });
  const memberOptions = () => members.map((member) => ({ id: member.id, nome: member.name ? `${member.name} · ${member.email}` : member.email }));
  const defs: Array<ListFilterDef<PipelineFilters>> = [
    { key: "pipeline_stage_id", label: "Etapa", kind: "option", icon: <Kanban size={13} aria-hidden="true" />, options: stages.map((stage) => ({ id: stage.id, nome: stage.name })) },
    { key: "action_bucket", label: "Ação necessária", kind: "option", icon: <HandPointing size={13} aria-hidden="true" />, options: [...actionBuckets] },
    { key: "appointment_status", label: "Reunião", kind: "option", icon: <CalendarBlank size={13} aria-hidden="true" />, options: [...appointmentStatuses] },
    { key: "commercial_outcome", label: "Resultado comercial", kind: "option", icon: <Star size={13} aria-hidden="true" />, options: [...commercialOutcomes] },
    { key: "origem", label: "Origem", kind: "text", operator: "contém", placeholder: "Ex.: Instagram" },
    { key: "campanha", label: "Campanha", kind: "text", operator: "contém", placeholder: "Nome da campanha" },
    ...(hasWorkspaceScope ? [
      { key: "period_start", label: "Período inicial", kind: "date" as const, operator: "depois de", icon: <CalendarBlank size={13} aria-hidden="true" /> },
      { key: "period_end", label: "Período final", kind: "date" as const, operator: "antes de", icon: <CalendarBlank size={13} aria-hidden="true" /> },
      { key: "sdr_member_id", label: "SDR", kind: "option" as const, icon: <Sparkle size={13} aria-hidden="true" />, options: memberOptions() },
      { key: "closer_member_id", label: "Closer", kind: "option" as const, icon: <Handshake size={13} aria-hidden="true" />, options: memberOptions() }
    ] as Array<ListFilterDef<PipelineFilters>> : [])
  ];

  return (
    <section className="pipeline-filters" aria-label="Filtros do pipeline">
      <div className="pipeline-filters__row">
        <label className="search-field pipeline-filters__search">
          <span className="sr-only">Buscar lead</span>
          <MagnifyingGlass aria-hidden="true" />
          <Input className="input" type="search" value={filters.busca} onChange={(event) => setFilter("busca", event.target.value)} placeholder="Buscar leads" />
        </label>

        <ListFiltersBar
          filters={filters}
          defs={defs}
          onSet={setFilter}
          onClearAll={() => onChange({ ...EMPTY_PIPELINE_FILTERS })}
          label={hasWorkspaceScope ? "Filtros de gestão" : "Filtros"}
        />
      </div>
    </section>
  );
}

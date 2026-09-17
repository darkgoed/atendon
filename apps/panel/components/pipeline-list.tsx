"use client";

import { Empty } from "@/components/page-state";
import { Button, TableScroll } from "@/components/ui";
import { pipelineStageAutomationLabel } from "@/components/pipeline-board";
import { currentPipelineStageId, formatPipelineAge, pipelineStatusLabel, type PipelineLead, type PipelineMember, type PipelineStage } from "@/lib/pipeline";

export function PipelineList({ leads, stages, members, legacy, loading, canMove, canSelect, selectedIds, pendingLeadIds, onToggleSelected, onMoveRequest }: {
  leads: PipelineLead[];
  stages: PipelineStage[];
  members: PipelineMember[];
  legacy: boolean;
  loading: boolean;
  canMove: boolean;
  canSelect: boolean;
  selectedIds: Set<string>;
  pendingLeadIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onMoveRequest: (lead: PipelineLead) => void;
}) {
  if (loading) return <div className="pipeline-list__loading" aria-label="Carregando leads">Carregando leads…</div>;
  if (leads.length === 0) return <Empty>Nenhum lead corresponde aos filtros.</Empty>;
  const memberName = (lead: PipelineLead) => lead.responsavel_email ?? lead.sdr_email ?? lead.closer_email ?? lead.recovery_email ?? members.find((m) => m.id === lead.responsavel_member_id)?.email ?? "—";
  return <TableScroll className="admin-table-wrap responsive-table-wrap pipeline-list">
    <table className="admin-table responsive-table">
      <thead><tr>{canSelect ? <th scope="col"><span className="sr-only">Selecionar</span></th> : null}<th scope="col">Lead</th><th scope="col">Estágio atual</th><th scope="col">Responsável</th><th scope="col">Idade no estágio</th><th scope="col">Próximo follow-up</th>{canMove ? <th scope="col">Ações</th> : null}</tr></thead>
      <tbody>{leads.map((lead) => {
        const stage = stages.find((item) => item.id === currentPipelineStageId(lead, stages, legacy));
        return <tr key={lead.id}>
          {canSelect ? <td data-label="Selecionar"><input type="checkbox" aria-label={`Selecionar ${lead.nome ?? lead.telefone}`} checked={selectedIds.has(lead.id)} onChange={() => onToggleSelected(lead.id)} /></td> : null}
          <td data-label="Lead"><strong>{lead.nome ?? "Sem nome"}</strong><span className="block text-xs text-[var(--text-secondary)]">{lead.telefone}</span></td>
          <td data-label="Estágio atual">{stage?.name ?? pipelineStatusLabel(lead.status)}{stage ? <>{" "}<span className="rounded bg-[var(--surface-active)] px-1.5 py-0.5 type-caption leading-none text-[var(--text-secondary)]" data-stage-kind={stage.operational_kind ?? "manual"}>{pipelineStageAutomationLabel(stage)}</span></> : null}</td>
          <td data-label="Responsável">{memberName(lead)}</td>
          <td data-label="Idade no estágio">{formatPipelineAge(lead.atualizado_em)}</td>
          <td data-label="Próximo follow-up">{lead.proxima_acao_em ? new Date(lead.proxima_acao_em).toLocaleString("pt-BR") : lead.proxima_acao ?? "—"}</td>
          {canMove ? <td data-label="Ações"><Button disabled={pendingLeadIds.has(lead.id)} onClick={() => onMoveRequest(lead)}>Mover</Button></td> : null}
        </tr>;
      })}</tbody>
    </table>
  </TableScroll>;
}

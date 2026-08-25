import type { LeadTechnicalStatus } from "../organization/domain.js";

export const COMMERCIAL_OUTCOMES = [
  "fechado",
  "proposta_enviada",
  "em_negociacao",
  "follow_up",
  "nao_avancou"
] as const;

export const LOSS_REASONS = [
  "preco",
  "sem_interesse",
  "sem_momento",
  "nao_qualificado",
  "concorrente",
  "sem_retorno",
  "outro"
] as const;

export type CommercialOutcome = typeof COMMERCIAL_OUTCOMES[number];
export type LossReason = typeof LOSS_REASONS[number];

export const OUTCOME_PIPELINE_STAGE: Record<CommercialOutcome, LeadTechnicalStatus> = {
  fechado: "fechado",
  proposta_enviada: "proposta_enviada",
  em_negociacao: "em_negociacao",
  follow_up: "follow_up",
  nao_avancou: "perdido"
};

export const STAGES_REQUIRING_NEXT_ACTION = new Set<LeadTechnicalStatus>([
  "em_negociacao",
  "proposta_enviada",
  "follow_up"
]);

export function stageRequiresCommercialPayload(status: LeadTechnicalStatus): boolean {
  return status === "fechado" || status === "perdido" || STAGES_REQUIRING_NEXT_ACTION.has(status);
}

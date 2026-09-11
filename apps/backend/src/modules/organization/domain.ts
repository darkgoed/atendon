export const LEAD_TECHNICAL_STATUSES = [
  "novo",
  "em_atendimento",
  "aguardando_resposta",
  "qualificado",
  "agendado",
  "em_negociacao",
  "proposta_enviada",
  "follow_up",
  "fechado",
  "perdido"
] as const;

export type LeadTechnicalStatus = typeof LEAD_TECHNICAL_STATUSES[number];

/** Etapas oferecidas por padrão como colunas comerciais do Kanban. */
export const DEFAULT_BOARD_STATUSES = [
  "novo",
  "em_atendimento",
  "qualificado",
  "em_negociacao",
  "fechado",
  "perdido"
] as const;

/** Situação é um rótulo operacional do card e não altera sua etapa. */
export type LeadSituation = "aguardando_resposta" | "agendado" | "proposta_enviada" | "follow_up" | null;

export function leadSituation(input: {
  status: LeadTechnicalStatus;
  hasUpcomingAppointment: boolean;
  awaitingReply: boolean;
}): LeadSituation {
  if (input.status === "aguardando_resposta" || input.awaitingReply) return "aguardando_resposta";
  if (input.status === "agendado" || input.hasUpcomingAppointment) return "agendado";
  if (input.status === "proposta_enviada") return "proposta_enviada";
  if (input.status === "follow_up") return "follow_up";
  return null;
}

const DOMAIN_TRANSITIONS: Record<LeadTechnicalStatus, readonly LeadTechnicalStatus[]> = {
  novo: ["em_atendimento", "perdido"],
  em_atendimento: ["aguardando_resposta", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  aguardando_resposta: ["em_atendimento", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  qualificado: ["em_atendimento", "agendado", "em_negociacao", "proposta_enviada", "follow_up", "perdido"],
  agendado: ["qualificado", "em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"],
  em_negociacao: ["proposta_enviada", "follow_up", "fechado", "perdido"],
  proposta_enviada: ["em_negociacao", "qualificado", "follow_up", "fechado", "perdido"],
  follow_up: ["em_atendimento", "aguardando_resposta", "qualificado", "agendado", "em_negociacao", "proposta_enviada", "fechado", "perdido"],
  fechado: [],
  perdido: ["em_atendimento", "follow_up", "fechado"]
};

export function domainAllowsStageTransition(
  fromStatus: LeadTechnicalStatus,
  toStatus: LeadTechnicalStatus
): boolean {
  return fromStatus === toStatus || DOMAIN_TRANSITIONS[fromStatus].includes(toStatus);
}

export function configuredStageTransitionIsUndoable(
  fromStatus: LeadTechnicalStatus,
  toStatus: LeadTechnicalStatus
): boolean {
  return fromStatus === toStatus;
}

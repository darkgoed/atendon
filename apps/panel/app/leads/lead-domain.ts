import { leadStatusLabel } from "@/lib/format";

export type LeadStatus = "novo" | "em_atendimento" | "aguardando_resposta" | "qualificado" | "agendado" | "em_negociacao" | "proposta_enviada" | "follow_up" | "fechado" | "perdido";

export function statusLabel(status?: LeadStatus) {
  return status ? leadStatusLabel(status) : "—";
}

export function statusTransitionFeedback(status: LeadStatus) {
  return `Status atualizado para ${statusLabel(status)}.`;
}

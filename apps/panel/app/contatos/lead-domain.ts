import { leadStatusLabel } from "@/lib/format";

export type LeadStatus = "novo" | "em_atendimento" | "aguardando_resposta" | "qualificado" | "agendado" | "em_negociacao" | "proposta_enviada" | "follow_up" | "fechado" | "perdido";

export function statusLabel(status?: LeadStatus) {
  return status ? leadStatusLabel(status) : "—";
}

// Tom visual da etapa (pílula .lead-status): neutro para entrada, primário
// em andamento, aviso quando aguarda alguém, sucesso/perigo nos desfechos.
export type LeadStatusTone = "neutral" | "primary" | "warning" | "success" | "danger";

export function leadStatusTone(status?: string): LeadStatusTone {
  switch (status) {
    case "em_atendimento":
    case "qualificado":
    case "agendado":
    case "em_negociacao":
    case "proposta_enviada":
      return "primary";
    case "aguardando_resposta":
    case "follow_up":
      return "warning";
    case "fechado":
      return "success";
    case "perdido":
      return "danger";
    default:
      return "neutral";
  }
}

export function statusTransitionFeedback(status: LeadStatus) {
  return `Status atualizado para ${statusLabel(status)}.`;
}

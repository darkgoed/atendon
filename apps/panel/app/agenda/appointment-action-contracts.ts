import { instantFromLocalMinute } from "../../lib/timezone";

export const LOSS_REASONS = [
  "preco",
  "sem_interesse",
  "sem_momento",
  "nao_qualificado",
  "concorrente",
  "sem_retorno",
  "outro"
] as const;

export type LossReason = (typeof LOSS_REASONS)[number];
export type AppointmentOutcome = "fechado" | "proposta_enviada" | "em_negociacao" | "follow_up" | "nao_avancou";

export type AppointmentOutcomePayload =
  | { outcome: "fechado"; sale_value: number }
  | { outcome: "proposta_enviada" | "em_negociacao" | "follow_up"; next_action: string; next_action_at: string }
  | { outcome: "nao_avancou"; loss_reason: LossReason };

export type AppointmentCancellationPayload =
  | { disposition: "recover"; next_action: string; next_action_at: string }
  | { disposition: "lost"; loss_reason: LossReason };

export type OutcomeDraft = {
  outcome: AppointmentOutcome | "";
  saleValue: string;
  nextAction: string;
  nextActionAtLocal: string;
  lossReason: LossReason | "";
};

export type CancellationDraft = {
  disposition: "recover" | "lost" | "";
  nextAction: string;
  nextActionAtLocal: string;
  lossReason: LossReason | "";
};

type ValidationResult<T> = { ok: true; payload: T } | { ok: false; error: string };

function nextActionFields(
  nextAction: string,
  nextActionAtLocal: string,
  timezone: string,
  now: number
): ValidationResult<{ next_action: string; next_action_at: string }> {
  const action = nextAction.trim();
  if (!action) return { ok: false, error: "Descreva a próxima ação." };
  const actionAt = instantFromLocalMinute(nextActionAtLocal, timezone);
  if (!actionAt) return { ok: false, error: "Informe uma data válida para a próxima ação." };
  if (new Date(actionAt).getTime() <= now) return { ok: false, error: "A próxima ação precisa estar no futuro." };
  return { ok: true, payload: { next_action: action, next_action_at: actionAt } };
}

export function buildOutcomePayload(
  draft: OutcomeDraft,
  timezone: string,
  now = Date.now()
): ValidationResult<AppointmentOutcomePayload> {
  if (!draft.outcome) return { ok: false, error: "Selecione o resultado da reunião." };
  if (draft.outcome === "fechado") {
    const saleValue = Number(draft.saleValue.replace(",", "."));
    if (!Number.isFinite(saleValue) || saleValue <= 0) return { ok: false, error: "Informe um valor de venda maior que zero." };
    return { ok: true, payload: { outcome: "fechado", sale_value: saleValue } };
  }
  if (draft.outcome === "nao_avancou") {
    if (!draft.lossReason) return { ok: false, error: "Selecione o motivo da perda." };
    return { ok: true, payload: { outcome: "nao_avancou", loss_reason: draft.lossReason } };
  }
  const next = nextActionFields(draft.nextAction, draft.nextActionAtLocal, timezone, now);
  if (!next.ok) return next;
  return { ok: true, payload: { outcome: draft.outcome, ...next.payload } };
}

export function buildCancellationPayload(
  draft: CancellationDraft,
  timezone: string,
  now = Date.now()
): ValidationResult<AppointmentCancellationPayload> {
  if (!draft.disposition) return { ok: false, error: "Escolha como este cancelamento deve ser tratado." };
  if (draft.disposition === "lost") {
    if (!draft.lossReason) return { ok: false, error: "Selecione o motivo da perda." };
    return { ok: true, payload: { disposition: "lost", loss_reason: draft.lossReason } };
  }
  const next = nextActionFields(draft.nextAction, draft.nextActionAtLocal, timezone, now);
  if (!next.ok) return next;
  return { ok: true, payload: { disposition: "recover", ...next.payload } };
}

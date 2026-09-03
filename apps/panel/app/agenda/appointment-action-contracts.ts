import { instantFromLocalMinute } from "../../lib/timezone";

/**
 * A chave do motivo vem do catálogo do tenant (`/organization/loss-reasons`),
 * por isso é uma string livre e não mais um union fechado: cada cliente tem o
 * seu próprio vocabulário comercial.
 */
export type LossReason = string;
export type AppointmentOutcome = "fechado" | "proposta_enviada" | "em_negociacao" | "follow_up" | "nao_avancou";

export type AppointmentOutcomePayload =
  | { outcome: "fechado"; sale_value: number }
  | { outcome: "proposta_enviada" | "em_negociacao" | "follow_up"; next_action: string; next_action_at: string }
  | { outcome: "nao_avancou"; loss_reason: LossReason; loss_reason_note?: string };

export type AppointmentCancellationPayload =
  | { disposition: "recover"; next_action: string; next_action_at: string }
  | { disposition: "lost"; loss_reason: LossReason; loss_reason_note?: string };

export type OutcomeDraft = {
  outcome: AppointmentOutcome | "";
  saleValue: string;
  nextAction: string;
  nextActionAtLocal: string;
  lossReason: LossReason | "";
  lossReasonNote?: string;
};

export type CancellationDraft = {
  disposition: "recover" | "lost" | "";
  nextAction: string;
  nextActionAtLocal: string;
  lossReason: LossReason | "";
  lossReasonNote?: string;
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
  now = Date.now(),
  requiresNote = false
): ValidationResult<AppointmentOutcomePayload> {
  if (!draft.outcome) return { ok: false, error: "Selecione o resultado da reunião." };
  if (draft.outcome === "fechado") {
    const saleValue = Number(draft.saleValue.replace(",", "."));
    if (!Number.isFinite(saleValue) || saleValue <= 0) return { ok: false, error: "Informe um valor de venda maior que zero." };
    return { ok: true, payload: { outcome: "fechado", sale_value: saleValue } };
  }
  if (draft.outcome === "nao_avancou") {
    if (!draft.lossReason) return { ok: false, error: "Selecione o motivo da perda." };
    if (requiresNote && !draft.lossReasonNote?.trim()) return { ok: false, error: "Descreva o motivo no campo de observação." };
    return {
      ok: true,
      payload: {
        outcome: "nao_avancou",
        loss_reason: draft.lossReason,
        ...(draft.lossReasonNote?.trim() ? { loss_reason_note: draft.lossReasonNote.trim() } : {})
      }
    };
  }
  const next = nextActionFields(draft.nextAction, draft.nextActionAtLocal, timezone, now);
  if (!next.ok) return next;
  return { ok: true, payload: { outcome: draft.outcome, ...next.payload } };
}

export function buildCancellationPayload(
  draft: CancellationDraft,
  timezone: string,
  now = Date.now(),
  requiresNote = false
): ValidationResult<AppointmentCancellationPayload> {
  if (!draft.disposition) return { ok: false, error: "Escolha como este cancelamento deve ser tratado." };
  if (draft.disposition === "lost") {
    if (!draft.lossReason) return { ok: false, error: "Selecione o motivo da perda." };
    if (requiresNote && !draft.lossReasonNote?.trim()) return { ok: false, error: "Descreva o motivo no campo de observação." };
    return {
      ok: true,
      payload: {
        disposition: "lost",
        loss_reason: draft.lossReason,
        ...(draft.lossReasonNote?.trim() ? { loss_reason_note: draft.lossReasonNote.trim() } : {})
      }
    };
  }
  const next = nextActionFields(draft.nextAction, draft.nextActionAtLocal, timezone, now);
  if (!next.ok) return next;
  return { ok: true, payload: { disposition: "recover", ...next.payload } };
}

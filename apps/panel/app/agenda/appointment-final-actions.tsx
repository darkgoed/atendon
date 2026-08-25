"use client";

import { type FormEvent, useState } from "react";
import {
  buildCancellationPayload,
  buildOutcomePayload,
  type AppointmentCancellationPayload,
  type AppointmentOutcome,
  type AppointmentOutcomePayload,
  type CancellationDraft,
  type LossReason,
  type OutcomeDraft
} from "./appointment-action-contracts";

const OUTCOME_OPTIONS: Array<{ value: AppointmentOutcome; label: string; detail: string }> = [
  { value: "fechado", label: "Fechou", detail: "Registre o valor da venda." },
  { value: "proposta_enviada", label: "Proposta enviada", detail: "Defina o próximo contato." },
  { value: "em_negociacao", label: "Em negociação", detail: "Mantenha uma ação futura clara." },
  { value: "follow_up", label: "Follow-up", detail: "Agende a retomada." },
  { value: "nao_avancou", label: "Não avançou", detail: "Registre o motivo da perda." }
];

const LOSS_OPTIONS: Array<{ value: LossReason; label: string }> = [
  { value: "preco", label: "Preço" },
  { value: "sem_interesse", label: "Sem interesse" },
  { value: "sem_momento", label: "Sem momento" },
  { value: "nao_qualificado", label: "Não qualificado" },
  { value: "concorrente", label: "Concorrente" },
  { value: "sem_retorno", label: "Sem retorno" },
  { value: "outro", label: "Outro" }
];

const emptyOutcome: OutcomeDraft = { outcome: "", saleValue: "", nextAction: "", nextActionAtLocal: "", lossReason: "" };
const emptyCancellation: CancellationDraft = { disposition: "", nextAction: "", nextActionAtLocal: "", lossReason: "" };

function LossReasonField({ value, disabled, onChange }: { value: LossReason | ""; disabled: boolean; onChange: (value: LossReason) => void }) {
  return (
    <label className="field">
      <span className="label">Motivo da perda</span>
      <select className="input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as LossReason)} required>
        <option value="">Selecione um motivo</option>
        {LOSS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function NextActionFields({ action, actionAt, timezone, disabled, onAction, onActionAt }: {
  action: string;
  actionAt: string;
  timezone: string;
  disabled: boolean;
  onAction: (value: string) => void;
  onActionAt: (value: string) => void;
}) {
  return (
    <div className="agenda-final-action-fields grid gap-4 sm:grid-cols-2">
      <label className="field sm:col-span-2">
        <span className="label">Próxima ação</span>
        <input className="input" value={action} maxLength={500} disabled={disabled} onChange={(event) => onAction(event.target.value)} placeholder="Ex.: enviar proposta revisada" required />
      </label>
      <label className="field sm:col-span-2">
        <span className="label">Quando</span>
        <input className="input" type="datetime-local" value={actionAt} disabled={disabled} onChange={(event) => onActionAt(event.target.value)} required />
        <small className="sub">Horário do workspace: {timezone}</small>
      </label>
    </div>
  );
}

export function AppointmentOutcomeForm({ timezone, submitting, serverError, onBack, onClearError, onSubmit }: {
  timezone: string;
  submitting: boolean;
  serverError: string;
  onBack: () => void;
  onClearError: () => void;
  onSubmit: (payload: AppointmentOutcomePayload) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<OutcomeDraft>(emptyOutcome);
  const [error, setError] = useState("");
  const requiresNextAction = draft.outcome === "proposta_enviada" || draft.outcome === "em_negociacao" || draft.outcome === "follow_up";
  const clearError = () => { setError(""); onClearError(); };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildOutcomePayload(draft, timezone);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    void onSubmit(result.payload);
  }

  return (
    <form className="agenda-final-action-form grid gap-5 border-y border-[var(--border)] py-5" aria-labelledby="agenda-final-action-title" onSubmit={submit}>
      <div>
        <span className="label">Resultado obrigatório</span>
        <strong id="agenda-final-action-title" className="mt-1 block text-sm">Como esta reunião terminou?</strong>
        <p className="sub mt-1 text-xs">O resultado atualiza o acompanhamento comercial e libera as próximas reuniões.</p>
      </div>
      <fieldset className="grid gap-2" disabled={submitting}>
        <legend className="sr-only">Resultado da reunião</legend>
        {OUTCOME_OPTIONS.map((option) => (
          <label key={option.value} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${draft.outcome === option.value ? "border-[var(--accent)] bg-[var(--accent-bg)]" : "border-[var(--border)]"}`}>
            <input data-autofocus={option.value === "fechado" ? true : undefined} type="radio" name="appointment-outcome" value={option.value} checked={draft.outcome === option.value} onChange={() => { setDraft({ ...emptyOutcome, outcome: option.value }); clearError(); }} />
            <span><strong className="block text-sm">{option.label}</strong><small className="sub">{option.detail}</small></span>
          </label>
        ))}
      </fieldset>
      {draft.outcome === "fechado" ? (
        <label className="field">
          <span className="label">Valor da venda</span>
          <input className="input" type="number" inputMode="decimal" min="0.01" step="0.01" value={draft.saleValue} disabled={submitting} onChange={(event) => { setDraft((current) => ({ ...current, saleValue: event.target.value })); clearError(); }} placeholder="0,00" required />
        </label>
      ) : null}
      {requiresNextAction ? (
        <NextActionFields action={draft.nextAction} actionAt={draft.nextActionAtLocal} timezone={timezone} disabled={submitting} onAction={(value) => { setDraft((current) => ({ ...current, nextAction: value })); clearError(); }} onActionAt={(value) => { setDraft((current) => ({ ...current, nextActionAtLocal: value })); clearError(); }} />
      ) : null}
      {draft.outcome === "nao_avancou" ? <LossReasonField value={draft.lossReason} disabled={submitting} onChange={(value) => { setDraft((current) => ({ ...current, lossReason: value })); clearError(); }} /> : null}
      {error || serverError ? <p className="error" role="alert">{error || serverError}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" disabled={submitting} onClick={onBack}>Voltar</button>
        <button type="submit" className="btn primary active:scale-[.98]" disabled={submitting}>{submitting ? "Salvando…" : "Salvar resultado"}</button>
      </div>
    </form>
  );
}

export function AppointmentCancellationForm({ timezone, submitting, serverError, onBack, onClearError, onSubmit }: {
  timezone: string;
  submitting: boolean;
  serverError: string;
  onBack: () => void;
  onClearError: () => void;
  onSubmit: (payload: AppointmentCancellationPayload) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<CancellationDraft>(emptyCancellation);
  const [error, setError] = useState("");
  const clearError = () => { setError(""); onClearError(); };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildCancellationPayload(draft, timezone);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    void onSubmit(result.payload);
  }

  return (
    <form className="agenda-final-action-form grid gap-5 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5" aria-labelledby="agenda-final-action-title" onSubmit={submit}>
      <div>
        <span className="label">Cancelar agendamento</span>
        <strong id="agenda-final-action-title" className="mt-1 block text-sm">O contato deve ser recuperado?</strong>
        <p className="mt-1 text-sm text-[var(--warn-muted)]">Cancelar libera este horário. Escolha uma retomada futura ou registre a perda.</p>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2" disabled={submitting}>
        <legend className="sr-only">Destino do cancelamento</legend>
        <label className={`cursor-pointer rounded-lg border p-3 ${draft.disposition === "recover" ? "border-[var(--accent)] bg-[var(--accent-bg)]" : "border-[var(--warn-border)]"}`}>
          <input data-autofocus type="radio" name="cancellation-disposition" checked={draft.disposition === "recover"} onChange={() => { setDraft({ ...emptyCancellation, disposition: "recover" }); clearError(); }} />
          <strong className="ml-2 text-sm">Recuperar depois</strong>
          <small className="sub mt-1 block">Cria uma próxima ação para o responsável.</small>
        </label>
        <label className={`cursor-pointer rounded-lg border p-3 ${draft.disposition === "lost" ? "border-[var(--accent)] bg-[var(--accent-bg)]" : "border-[var(--warn-border)]"}`}>
          <input type="radio" name="cancellation-disposition" checked={draft.disposition === "lost"} onChange={() => { setDraft({ ...emptyCancellation, disposition: "lost" }); clearError(); }} />
          <strong className="ml-2 text-sm">Encerrar como perda</strong>
          <small className="sub mt-1 block">Registra por que a oportunidade terminou.</small>
        </label>
      </fieldset>
      {draft.disposition === "recover" ? <NextActionFields action={draft.nextAction} actionAt={draft.nextActionAtLocal} timezone={timezone} disabled={submitting} onAction={(value) => { setDraft((current) => ({ ...current, nextAction: value })); clearError(); }} onActionAt={(value) => { setDraft((current) => ({ ...current, nextActionAtLocal: value })); clearError(); }} /> : null}
      {draft.disposition === "lost" ? <LossReasonField value={draft.lossReason} disabled={submitting} onChange={(value) => { setDraft((current) => ({ ...current, lossReason: value })); clearError(); }} /> : null}
      {error || serverError ? <p className="error" role="alert">{error || serverError}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" disabled={submitting} onClick={onBack}>Voltar</button>
        <button type="submit" className="btn warn active:scale-[.98]" disabled={submitting}>{submitting ? "Cancelando…" : "Confirmar cancelamento"}</button>
      </div>
    </form>
  );
}

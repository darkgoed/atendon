"use client";

import { ArrowRight, X } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { instantFromLocalMinute } from "@/lib/timezone";
import {
  pipelineStatusLabel,
  pipelineTransitionRequirement,
  type PipelineCommercialInput,
  type PipelineLead,
  type PipelineStage
} from "@/lib/pipeline";

export function PipelineTransitionDialog({
  lead,
  targets,
  initialTarget,
  pending,
  error,
  timezone,
  onClose,
  onSubmit
}: {
  lead: PipelineLead;
  targets: PipelineStage[];
  initialTarget?: PipelineStage | null;
  pending: boolean;
  error?: string;
  timezone: string;
  onClose: () => void;
  onSubmit: (stage: PipelineStage, commercial?: PipelineCommercialInput) => void | Promise<void>;
}) {
  const [targetId, setTargetId] = useState(initialTarget?.id ?? targets[0]?.id ?? "");
  const [saleValue, setSaleValue] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [lossReason, setLossReason] = useState("");
  const [validationError, setValidationError] = useState("");
  const target = useMemo(() => targets.find((stage) => stage.id === targetId) ?? null, [targetId, targets]);
  const requirement = pipelineTransitionRequirement(target?.technical_status ?? "");
  const firstTargetId = targets[0]?.id;

  useEffect(() => {
    setTargetId(initialTarget?.id ?? firstTargetId ?? "");
    setSaleValue("");
    setNextAction("");
    setNextActionAt("");
    setLossReason("");
    setValidationError("");
  }, [firstTargetId, initialTarget?.id, lead.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || pending) return;
    setValidationError("");
    let commercial: PipelineCommercialInput | undefined;
    if (requirement === "sale") {
      const parsed = Number(saleValue.replace(",", "."));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setValidationError("Informe um valor de venda maior que zero.");
        return;
      }
      commercial = { sale_value: parsed };
    } else if (requirement === "next_action") {
      if (!nextAction.trim() || !nextActionAt) {
        setValidationError("Informe a próxima ação e sua data e hora.");
        return;
      }
      const instant = instantFromLocalMinute(nextActionAt, timezone);
      if (!instant || new Date(instant).getTime() <= Date.now()) {
        setValidationError("A data da próxima ação deve estar no futuro.");
        return;
      }
      commercial = { next_action: nextAction.trim(), next_action_at: instant };
    } else if (requirement === "loss") {
      if (!lossReason.trim()) {
        setValidationError("Informe o motivo da perda.");
        return;
      }
      commercial = { loss_reason: lossReason.trim() };
    }
    void onSubmit(target, commercial);
  }

  return (
    <ModalDialog
      overlayClassName="fixed inset-0 z-30 grid place-items-end bg-[color-mix(in_srgb,var(--app)_68%,transparent)] sm:place-items-center"
      dialogClassName="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-[var(--border)] bg-[var(--dialog)] p-4 shadow-[0_-18px_50px_color-mix(in_srgb,var(--app)_45%,transparent)] sm:w-[min(520px,calc(100vw-32px))] sm:rounded-xl sm:p-5"
      labelledBy="pipeline-transition-title"
      describedBy="pipeline-transition-description"
      onClose={pending ? () => undefined : onClose}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">MOVIMENTAÇÃO SEGURA</span>
          <h2 id="pipeline-transition-title" className="mt-2 text-lg font-semibold">Mover {lead.nome ?? "lead"}</h2>
          <p id="pipeline-transition-description" className="mt-1 text-xs leading-relaxed text-[var(--muted)]">Escolha a etapa e registre os dados exigidos para manter o histórico comercial consistente.</p>
        </div>
        <button type="button" className="grid size-9 shrink-0 place-items-center rounded border border-[var(--border)] active:scale-[.94]" onClick={onClose} disabled={pending} aria-label="Fechar movimentação">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <form className="mt-5 grid gap-4" aria-busy={pending} onSubmit={submit}>
        <label className="field">
          <span className="label">Etapa de destino</span>
          <select className="input" value={targetId} onChange={(event) => { setTargetId(event.target.value); setValidationError(""); }} data-autofocus disabled={pending}>
            {targets.map((stage) => <option key={stage.id} value={stage.id}>{stage.name} · {pipelineStatusLabel(stage.technical_status)}</option>)}
          </select>
        </label>

        {requirement === "sale" ? (
          <label className="field">
            <span className="label">Valor da venda</span>
            <input className="input" type="number" inputMode="decimal" min="0.01" step="0.01" value={saleValue} onChange={(event) => setSaleValue(event.target.value)} placeholder="0,00" disabled={pending} required />
            <span className="text-[10px] text-[var(--muted)]">Obrigatório para concluir como fechado.</span>
          </label>
        ) : null}

        {requirement === "next_action" ? <>
          <label className="field">
            <span className="label">Próxima ação</span>
            <input className="input" value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={240} placeholder="Ex.: Retomar proposta com a diretoria" disabled={pending} required />
          </label>
          <label className="field">
            <span className="label">Data e hora</span>
            <input className="input" type="datetime-local" value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} disabled={pending} required />
            <span className="text-[10px] text-[var(--muted)]">Horário do workspace: {timezone}</span>
          </label>
        </> : null}

        {requirement === "loss" ? (
          <label className="field">
            <span className="label">Motivo da perda</span>
            <select className="input" value={lossReason} onChange={(event) => setLossReason(event.target.value)} disabled={pending} required>
              <option value="">Selecione um motivo</option>
              <option value="preco">Preço</option>
              <option value="sem_interesse">Sem interesse</option>
              <option value="sem_momento">Sem momento</option>
              <option value="nao_qualificado">Não qualificado</option>
              <option value="concorrente">Escolheu um concorrente</option>
              <option value="sem_retorno">Sem retorno</option>
              <option value="outro">Outro</option>
            </select>
          </label>
        ) : null}

        {validationError ? <p className="error" role="alert">{validationError}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-end">
          <button type="button" className="btn justify-center active:scale-[.98]" onClick={onClose} disabled={pending}>Cancelar</button>
          <button type="submit" className="btn primary justify-center active:scale-[.98]" disabled={!target || pending}>
            {pending ? "Movendo…" : "Confirmar movimento"}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

"use client";

import { ArrowRight, X } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { pipelineStageAutomationLabel } from "@/components/pipeline-board";
import { instantFromLocalMinute } from "@/lib/timezone";
import { lossReasonRequiresNote, useLossReasons } from "@/lib/loss-reasons";
import {
  pipelineStatusLabel,
  pipelineTransitionRequirement,
  type PipelineCommercialInput,
  type PipelineLead,
  type PipelineMember,
  type PipelineStage
} from "@/lib/pipeline";

export function PipelineTransitionDialog({
  lead,
  targets,
  initialTarget,
  pending,
  error,
  timezone,
  members = [],
  onClose,
  onSubmit
}: {
  lead: PipelineLead;
  targets: PipelineStage[];
  initialTarget?: PipelineStage | null;
  pending: boolean;
  error?: string;
  timezone: string;
  members?: PipelineMember[];
  onClose: () => void;
  onSubmit: (stage: PipelineStage, commercial?: PipelineCommercialInput) => void | Promise<void>;
}) {
  const [targetId, setTargetId] = useState(initialTarget?.id ?? targets[0]?.id ?? "");
  const [saleValue, setSaleValue] = useState("");
  const [saleProduct, setSaleProduct] = useState("");
  const [saleSource, setSaleSource] = useState("");
  const [saleChannel, setSaleChannel] = useState("");
  const [responsibleMemberId, setResponsibleMemberId] = useState(lead.responsavel_member_id ?? "");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [lossReason, setLossReason] = useState("");
  const [lossReasonNote, setLossReasonNote] = useState("");
  const [validationError, setValidationError] = useState("");
  const { reasons, error: reasonsError } = useLossReasons();
  const target = useMemo(() => targets.find((stage) => stage.id === targetId) ?? null, [targetId, targets]);
  const requirement = pipelineTransitionRequirement(target?.technical_status ?? "");
  const firstTargetId = targets[0]?.id;
  const noteRequired = lossReasonRequiresNote(reasons, lossReason);

  useEffect(() => {
    setTargetId(initialTarget?.id ?? firstTargetId ?? "");
    setSaleValue("");
    setSaleProduct("");
    setSaleSource("");
    setSaleChannel("");
    setResponsibleMemberId(lead.responsavel_member_id ?? "");
    setNextAction("");
    setNextActionAt("");
    setLossReason("");
    setLossReasonNote("");
    setValidationError("");
  }, [firstTargetId, initialTarget?.id, lead.id, lead.responsavel_member_id]);

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
      if (!saleProduct.trim() || !saleSource.trim() || !saleChannel.trim() || !responsibleMemberId) {
        setValidationError("Informe produto, responsável, origem e modalidade da venda.");
        return;
      }
      commercial = { sale_value: parsed, sale_product: saleProduct.trim(), sale_source: saleSource.trim(), sale_channel: saleChannel.trim(), responsavel_member_id: responsibleMemberId };
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
      if (noteRequired && !lossReasonNote.trim()) {
        setValidationError("Descreva o motivo no campo de observação.");
        return;
      }
      commercial = {
        loss_reason: lossReason.trim(),
        ...(lossReasonNote.trim() ? { loss_reason_note: lossReasonNote.trim() } : {})
      };
    }
    void onSubmit(target, commercial);
  }

  return (
    <ModalDialog
      overlayClassName="pipeline-dialog-overlay"
      dialogClassName="pipeline-dialog"
      labelledBy="pipeline-transition-title"
      describedBy="pipeline-transition-description"
      onClose={pending ? () => undefined : onClose}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">MOVIMENTAÇÃO SEGURA</span>
          <h2 id="pipeline-transition-title" className="mt-2 text-lg font-semibold">Mover {lead.nome ?? "lead"}</h2>
          <p id="pipeline-transition-description" className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">Escolha a etapa e registre os dados exigidos para manter o histórico comercial consistente.</p>
        </div>
        <button type="button" className="grid size-9 shrink-0 place-items-center rounded border border-[var(--border)] active:scale-[.94]" onClick={onClose} disabled={pending} aria-label="Fechar movimentação">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <form className="mt-5 grid gap-4" aria-busy={pending} onSubmit={submit}>
        <label className="field">
          <span className="label">Etapa de destino</span>
          <select className="input" value={targetId} onChange={(event) => { setTargetId(event.target.value); setValidationError(""); }} data-autofocus disabled={pending}>
            {targets.map((stage) => <option key={stage.id} value={stage.id}>{stage.name} · {pipelineStatusLabel(stage.technical_status)} · {pipelineStageAutomationLabel(stage)}</option>)}
          </select>
        </label>

        {requirement === "sale" ? (
          <>
            <label className="field"><span className="label">Produto</span><input className="input" value={saleProduct} onChange={(event) => setSaleProduct(event.target.value)} disabled={pending} required /></label>
            <label className="field"><span className="label">Valor da venda</span><input className="input" type="number" inputMode="decimal" min="0.01" step="0.01" value={saleValue} onChange={(event) => setSaleValue(event.target.value)} placeholder="0,00" disabled={pending} required /></label>
            <label className="field"><span className="label">Responsável</span><select className="input" value={responsibleMemberId} onChange={(event) => setResponsibleMemberId(event.target.value)} disabled={pending} required><option value="">Selecione um responsável</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.email}</option>)}{lead.responsavel_member_id && !members.some((member) => member.id === lead.responsavel_member_id) ? <option value={lead.responsavel_member_id}>{lead.responsavel_email ?? "Responsável atual"}</option> : null}</select></label>
            <label className="field"><span className="label">Origem</span><input className="input" value={saleSource} onChange={(event) => setSaleSource(event.target.value)} disabled={pending} required /></label>
            <label className="field"><span className="label">Modalidade</span><input className="input" value={saleChannel} onChange={(event) => setSaleChannel(event.target.value)} disabled={pending} required /></label>
          </>
        ) : null}

        {requirement === "next_action" ? <>
          <label className="field">
            <span className="label">Próxima ação</span>
            <input className="input" value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={240} placeholder="Ex.: Retomar proposta com a diretoria" disabled={pending} required />
          </label>
          <label className="field">
            <span className="label">Data e hora</span>
            <input className="input" type="datetime-local" value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} disabled={pending} required />
            <span className="pipeline-dialog__hint">Horário do workspace: {timezone}</span>
          </label>
        </> : null}

        {requirement === "loss" ? <>
          <label className="field">
            <span className="label">Motivo da desqualificação</span>
            <select className="input" value={lossReason} onChange={(event) => { setLossReason(event.target.value); setValidationError(""); }} disabled={pending} required>
              <option value="">Selecione um motivo</option>
              {reasons.map((reason) => <option key={reason.id} value={reason.chave}>{reason.rotulo}</option>)}
            </select>
            {reasonsError ? <span className="pipeline-note--error">{reasonsError}</span> : null}
          </label>
          <label className="field">
            <span className="label">Observação{noteRequired ? "" : " (opcional)"}</span>
            <textarea
              className="input min-h-20 resize-y"
              value={lossReasonNote}
              onChange={(event) => { setLossReasonNote(event.target.value); setValidationError(""); }}
              maxLength={500}
              disabled={pending}
              required={noteRequired}
              placeholder="Detalhe o que o cliente disse"
            />
            <span className="pipeline-note">
              {noteRequired ? "Obrigatório para este motivo." : "Contexto extra para o closer."}
            </span>
          </label>
        </> : null}

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

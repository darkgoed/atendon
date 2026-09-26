"use client";

import { ArrowsLeftRight } from "@/components/icons";
import { HelpHint, useFlashToast } from "@/components/ui";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { PipelineTransitionDialog } from "@/components/pipeline-transition-dialog";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import {
  buildPipelineTransitionPayload,
  type PipelineCommercialInput,
  type PipelineLead,
  type PipelineMember,
  type PipelineStage,
  type PipelineTransition
} from "@/lib/pipeline";
import { usePermission } from "@/lib/use-permission";

type PipelineResponse = {
  stages: PipelineStage[];
  transitions: PipelineTransition[];
  members: PipelineMember[];
  enforce_transitions?: boolean;
};

export function ConversationStatusPicker({
  leadId,
  leadName,
  leadPhone,
  leadResponsibleMemberId,
  leadResponsibleEmail,
  leadStatus,
  leadUpdatedAt,
  pipelineStage,
  timezone,
  onChanged
}: {
  leadId: string;
  leadName?: string;
  leadPhone: string;
  leadResponsibleMemberId?: string | null;
  leadResponsibleEmail?: string | null;
  leadStatus: string;
  leadUpdatedAt: string;
  pipelineStage: PipelineStage;
  timezone: string;
  onChanged: () => void | Promise<void>;
}) {
  const canMove = usePermission("leads.update_status");
  const flash = useFlashToast();
  const showFlash = flash.show;
  const organizationEnabled = useCaseOrganizationEnabled();
  // Escopo no pipeline da etapa do contato (contrato 9): ausente = padrão.
  const pipelineScope = pipelineStage.pipeline_id ? `?pipeline_id=${pipelineStage.pipeline_id}` : "";
  const { data } = useSWR<PipelineResponse>(
    canMove && organizationEnabled === true ? `/organization/pipeline${pipelineScope}` : null,
    (url: string) => api<PipelineResponse>(url),
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const members = data?.members ?? [];
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const targets = useMemo(() => {
    const targetIds = data?.enforce_transitions === false
      ? new Set((data?.stages ?? []).filter((stage) => stage.id !== pipelineStage.id).map((stage) => stage.id))
      : new Set((data?.transitions ?? [])
        .filter((transition) => transition.from_stage_id === pipelineStage.id)
        .map((transition) => transition.to_stage_id));
    return (data?.stages ?? [])
      .filter((stage) => !stage.archived_at && targetIds.has(stage.id))
      .sort((left, right) => left.position - right.position);
  }, [data?.stages, data?.transitions, data?.enforce_transitions, pipelineStage.id]);
  const lead: PipelineLead = {
    id: leadId,
    telefone: leadPhone,
    nome: leadName,
    status: leadStatus,
    atualizado_em: leadUpdatedAt,
    pipeline_stage_id: pipelineStage.id,
    responsavel_member_id: leadResponsibleMemberId,
    responsavel_email: leadResponsibleEmail
  };

  async function submit(stage: PipelineStage, commercial?: PipelineCommercialInput) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/organization/leads/${leadId}/stage`, {
        method: "PATCH",
        body: JSON.stringify(buildPipelineTransitionPayload({
          stage,
          expectedUpdatedAt: leadUpdatedAt,
          commercial
        }))
      });
      setOpen(false);
      await onChanged();
      showFlash(`Lead movido para ${stage.name}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao atualizar o status do lead");
    } finally {
      setPending(false);
    }
  }

  if (!canMove) return null;
  const disabled = organizationEnabled !== true || !targets.length;
  return (
    <>
      <button
        type="button"
        className="conversation-status-picker btn shrink-0 active:scale-95"
        onClick={() => { setError(""); setOpen(true); }}
        disabled={disabled}
        title={disabled ? "Nenhuma mudança de etapa comercial disponível" : `Etapa comercial atual: ${pipelineStage.name}`}
        aria-label={`Etapa comercial atual: ${pipelineStage.name}`}
      >
        <ArrowsLeftRight size={14} aria-hidden="true" />
        Etapa comercial
      </button>
      <HelpHint label="Ajuda: Etapa comercial">Move este lead para outra etapa do pipeline comercial. Aparecem apenas as etapas liberadas a partir da atual, conforme a configuração do pipeline.</HelpHint>
      {open ? (
        <PipelineTransitionDialog
          lead={lead}
          targets={targets}
          pending={pending}
          error={error}
          timezone={timezone}
          members={members}
          onClose={() => setOpen(false)}
          onSubmit={submit}
        />
      ) : null}
      {flash.toast}
    </>
  );
}

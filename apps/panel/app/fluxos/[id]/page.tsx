"use client";

/* Editor de um fluxo de robô (R22) — carrega /qualification/flows/:id e
   monta o canvas. O salvamento é PUT upsert (definition inteira por id,
   ids de etapa preservados). A validação client mostra os problemas antes
   de salvar; erros do servidor são autoridade final. */

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import { FlowEditor, type SimTrace } from "@/components/flow-editor/flow-editor";
import {
  normalizeDefinition,
  parseTrace,
  validateDefinition,
  type FlowDefinition,
} from "@/components/flow-editor/flow-model";

type FlowResponse = {
  flow: {
    id: string;
    nome: string;
    ativo: boolean;
    definition: unknown;
    atualizado_em: string | null;
  };
};

const flowFetcher = (url: string) => api<FlowResponse>(url);

export default function FluxoEditorPage() {
  const params = useParams<{ id: string }>();
  const flowId = typeof params.id === "string" ? params.id : "";
  const canManage = usePermission("agent.manage");
  const canRead = usePermission("agent.read");
  const { data, error, isLoading } = useSWR(canRead ? `/qualification/flows/${flowId}` : null, flowFetcher);

  const [nome, setNome] = useState<string | null>(null);
  const [ativo] = useState<boolean | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [trace, setTrace] = useState<SimTrace | null>(null);

  const loaded = data?.flow;
  const currentNome = nome ?? loaded?.nome ?? "";
  const currentAtivo = ativo ?? loaded?.ativo ?? false;
  const currentDefinition = definition ?? (loaded ? normalizeDefinition(loaded.definition) : null);

  const save = useCallback(async () => {
    if (!currentDefinition || !canManage) return;
    setServerError(null);
    if (validateDefinition(currentDefinition).length > 0) return; // o editor lista os problemas
    setSaving(true);
    setSaved(false);
    try {
      await api(`/qualification/flows/${flowId}`, {
        method: "PUT",
        body: JSON.stringify({ nome: currentNome, ativo: currentAtivo, definition: currentDefinition }),
      });
      setSaved(true);
    } catch (cause) {
      setServerError(cause instanceof ApiError ? cause.message : "Falha ao salvar o fluxo");
    } finally {
      setSaving(false);
    }
  }, [canManage, currentAtivo, currentDefinition, currentNome, flowId]);

  const simulate = useCallback(async () => {
    if (!currentDefinition) return;
    setTrace({ running: true, steps: [] });
    setServerError(null);
    try {
      const payload = await api<unknown>(`/qualification/flows/${flowId}/simulate`, {
        method: "POST",
        body: JSON.stringify({ definition: currentDefinition, maxSteps: 40 }),
      });
      setTrace({ running: false, ...parseTrace(payload) });
    } catch (cause) {
      const message = cause instanceof ApiError
        ? cause.status === 404 || cause.status === 405
          ? "Simulação indisponível neste servidor. Salve o fluxo e tente novamente quando o endpoint for liberado."
          : cause.message
        : "Falha ao simular o fluxo";
      setTrace({ running: false, steps: [], error: message });
    }
  }, [currentDefinition, flowId]);

  const updateDefinition = useCallback((next: FlowDefinition) => {
    setDefinition(next);
    setSaved(false);
  }, []);

  return (
    <Shell flush>
      {isLoading ? (
        <div className="grid gap-3 p-4"><div className="skeleton h-10 w-72" aria-hidden="true" /><div className="skeleton h-80 w-full" aria-hidden="true" /></div>
      ) : error || !loaded ? (
        <div className="p-4"><p className="error" role="alert">Fluxo não encontrado.</p></div>
      ) : currentDefinition ? (
        <div style={{ height: "100%" }}>
          <h1 className="sr-only">{currentNome}</h1>
          <FlowEditor
            flowId={flowId}
            nome={currentNome}
            ativo={currentAtivo}
            definition={currentDefinition}
            canManage={canManage}
            saving={saving}
            saved={saved}
            serverError={serverError}
            trace={trace}
            onNome={(value) => { setNome(value); setSaved(false); }}
            onDefinition={updateDefinition}
            onSave={() => void save()}
            onSimulate={() => void simulate()}
            onCloseTrace={() => setTrace(null)}
          />
          {!canManage ? <p className="sub p-2" role="status">Acesso somente leitura. Salve e ative apenas com permissão de edição.</p> : null}
        </div>
      ) : null}
    </Shell>
  );
}

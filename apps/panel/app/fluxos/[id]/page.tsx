"use client";

/* Editor de um fluxo de robô (R22) — carrega /qualification/flows/:id e monta
   o canvas. O salvamento é PUT upsert (definition inteira por id, ids de etapa
   preservados) com CAS por revisão (SPEC flow-integrity R2/R5): a página
   guarda a revisao viva do GET e envia revisao_base em TODO save; 409
   FLOW_VERSION_CONFLICT abre o FlowConflictModal (Recarregar = SWR mutate;
   Ver histórico = drawer FlowHistory da própria página, não rota).
   Guarda dirty: beforeunload + bloqueio da navegação interna com descarte
   explícito; o id do fluxo é capturado no closure do save — resposta tardia
   após trocar de rota não toca em outro fluxo. A validação client mostra os
   problemas antes de salvar; erros do servidor são autoridade final. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import { useSaveFeedback } from "@/components/ui";
import { FlowEditor, type SimTrace } from "@/components/flow-editor/flow-editor";
import type { FlowConflict } from "@/components/flow-editor/FlowConflictModal";
import { FlowHistory } from "@/components/flow-editor/flow-history";
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
    revisao?: number;
    atualizado_em: string | null;
  };
};

/* Resposta do PUT: só o que a página consome (a revisão nova pós-trigger). */
type FlowMutationResponse = { flow?: { revisao?: number } };

const flowFetcher = (url: string) => api<FlowResponse>(url);

/** Shape exato do 409 (routes.ts:184): { error, code: "FLOW_VERSION_CONFLICT", revisao }. */
function flowConflictRevisao(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { code?: unknown; revisao?: unknown };
  if (record.code !== "FLOW_VERSION_CONFLICT" || typeof record.revisao !== "number") return null;
  return record.revisao;
}

export default function FluxoEditorPage() {
  const params = useParams<{ id: string }>();
  const flowId = typeof params.id === "string" ? params.id : "";
  const canManage = usePermission("agent.manage");
  const canRead = usePermission("agent.read");
  const { data, error, isLoading, mutate } = useSWR(canRead ? `/qualification/flows/${flowId}` : null, flowFetcher);

  const [nome, setNome] = useState<string | null>(null);
  const [ativo] = useState<boolean | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  const [revisao, setRevisao] = useState<number | null>(null);
  const [conflict, setConflict] = useState<FlowConflict | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /* Padrão de salvar DS v2 (§2): SaveButton idle→busy→done + SaveToast 2,6s.
     A página tem flag `saving` própria (o save captura o flowId no closure),
     então usa markDone() no sucesso com o MESMO guarda de resposta tardia —
     save.run() marcaria done mesmo com outro fluxo na tela (R5). */
  const saveFeedback = useSaveFeedback();
  const { markDone: markSaveDone, reset: resetSaveFeedback } = saveFeedback;
  const [trace, setTrace] = useState<SimTrace | null>(null);

  /* O id do fluxo vivo em um ref: o save captura o id no closure e, na
     resposta tardia, compara — trocar de rota no meio do save nunca aplica
     o resultado (nem o erro) no fluxo que ficou na tela (R5). */
  const flowIdRef = useRef(flowId);
  useEffect(() => {
    flowIdRef.current = flowId;
  }, [flowId]);

  /* Troca de fluxo (param id muda sem remontar a página): zera o estado local
     — nunca vazar nome/definition/revisão/saving de um fluxo no outro. */
  useEffect(() => {
    setNome(null);
    setDefinition(null);
    setRevisao(null);
    setConflict(null);
    setHistoryOpen(false);
    setDirty(false);
    setServerError(null);
    setSaving(false);
    setSaved(false);
    resetSaveFeedback();
    setTrace(null);
  }, [flowId, resetSaveFeedback]);

  /* Guarda a revisão do GET (primeira carga e recarga explícita) e do PUT
     (pós-trigger). Revalidação em background NÃO sobrescreve o token: com
     token stale o próximo save toma 409 (modal) em vez de sobrescrever
     silenciosamente o salvamento alheio (R2/R5). */
  const loaded = data?.flow;
  useEffect(() => {
    if (revisao === null && typeof loaded?.revisao === "number") setRevisao(loaded.revisao);
  }, [loaded, revisao]);

  /* Guarda dirty real (R5): só com edição não salva. beforeunload cobre a
     saída da aba; o clique em captura cobre a navegação interna (<a> do app),
     com descarte EXPLÍCITO via confirm — cancelar aborta a navegação. */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClickCapture = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || anchor.target === "_blank") return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      if (new URL(href, window.location.href).origin !== window.location.origin) return;
      if (!window.confirm("Há alterações não salvas neste fluxo. Navegar agora vai descartá-las — descartar as alterações?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);

  const currentNome = nome ?? loaded?.nome ?? "";
  const currentAtivo = ativo ?? loaded?.ativo ?? false;
  const currentDefinition = definition ?? (loaded ? normalizeDefinition(loaded.definition) : null);

  const save = useCallback(async () => {
    if (!currentDefinition || !canManage) return;
    setServerError(null);
    if (validateDefinition(currentDefinition).length > 0) return; // o editor lista os problemas
    const targetId = flowId; // capturado no closure (R5)
    const baseRevisao = revisao; // token CAS vivo no momento do clique
    setSaving(true);
    setSaved(false);
    try {
      const response = await api<FlowMutationResponse>(`/qualification/flows/${targetId}`, {
        method: "PUT",
        body: JSON.stringify({
          nome: currentNome,
          ativo: currentAtivo,
          definition: currentDefinition,
          revisao_base: baseRevisao ?? 0,
        }),
      });
      if (flowIdRef.current !== targetId) return; // resposta tardia: outro fluxo na tela
      if (typeof response.flow?.revisao === "number") setRevisao(response.flow.revisao);
      setSaved(true);
      markSaveDone(); // SaveButton "Salvo" + SaveToast "Fluxo salvo" por 2,6s
      setDirty(false);
    } catch (cause) {
      if (flowIdRef.current !== targetId) return;
      resetSaveFeedback(); // em erro o botão volta a "Salvar"
      const conflictRevisao = cause instanceof ApiError ? flowConflictRevisao(cause.body) : null;
      if (cause instanceof ApiError && cause.status === 409 && conflictRevisao !== null) {
        setConflict({ revisao: conflictRevisao }); // modal do editor; Recarregar = mutate
        return;
      }
      setServerError(cause instanceof ApiError ? cause.message : "Falha ao salvar o fluxo");
    } finally {
      if (flowIdRef.current === targetId) setSaving(false);
    }
  }, [canManage, currentAtivo, currentDefinition, currentNome, flowId, revisao, markSaveDone, resetSaveFeedback]);

  /* Recarregar (modal de conflito) e pós-restore: descarta o shadow state e
     revalida — a revisão volta a ser a viva do GET, senão o token stale
     causaria 409 em todo save seguinte (R2/R3). */
  const reloadFromServer = useCallback(() => {
    setNome(null);
    setDefinition(null);
    setRevisao(null);
    setConflict(null);
    setSaved(false);
    setDirty(false);
    void mutate();
  }, [mutate]);

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
    setDirty(true);
  }, []);

  return (
    <Shell flush>
      {isLoading ? (
        <div className="grid gap-3 p-4"><div className="skeleton h-10 w-72" aria-hidden="true" /><div className="skeleton h-80 w-full" aria-hidden="true" /></div>
      ) : error || !loaded ? (
        <div className="p-4"><p className="error" role="alert">Fluxo não encontrado.</p></div>
      ) : currentDefinition ? (
        <div style={{ height: "100%", position: "relative" }}>
          <h1 className="sr-only">{currentNome}</h1>
          <FlowEditor
            flowId={flowId}
            nome={currentNome}
            ativo={currentAtivo}
            definition={currentDefinition}
            canManage={canManage}
            saving={saving}
            saved={saved}
            saveState={saveFeedback.state}
            serverError={serverError}
            trace={trace}
            conflict={conflict}
            onReload={reloadFromServer}
            onOpenHistory={() => setHistoryOpen(true)}
            onNome={(value) => { setNome(value); setSaved(false); setDirty(true); }}
            onDefinition={updateDefinition}
            onSave={() => void save()}
            onSimulate={() => void simulate()}
            onCloseTrace={() => setTrace(null)}
          />
          {historyOpen ? (
            <FlowHistory
              flowId={flowId}
              revisao={revisao}
              canManage={canManage}
              onRestored={() => {
                setHistoryOpen(false);
                reloadFromServer();
              }}
              onConflict={(next) => {
                setHistoryOpen(false);
                setConflict(next);
              }}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
          {!canManage ? <p className="sub p-2" role="status">Acesso somente leitura. Salve e ative apenas com permissão de edição.</p> : null}
        </div>
      ) : null}
    </Shell>
  );
}

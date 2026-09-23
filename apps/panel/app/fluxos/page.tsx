"use client";

/* Fluxos de robô (R22) — lista. Atendimento automático determinístico,
   separado da IA (agent/tripz). Permissões espelham o módulo qualification:
   leitura agent.read, escrita agent.manage. */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { ArrowsClockwise, CopySimple, PencilSimple, Plus, Plugs } from "@/components/icons";
import { Shell } from "@/components/shell";
import { Button, IconButton } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import { usePermission } from "@/lib/use-permission";
import { newFlowId, starterDefinition, triggerSummary, type FlowSummary } from "@/components/flow-editor/flow-model";

type FlowsResponse = { flows: Array<FlowSummary & { atualizado_em: string | null }> };

const listFetcher = (url: string) => api<FlowsResponse>(url);

export default function FluxosPage() {
  const router = useRouter();
  const canRead = usePermission("agent.read");
  const canManage = usePermission("agent.manage");
  const { data, error, isLoading, mutate } = useSWR(canRead ? "/qualification/flows" : null, listFetcher);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const flows = data?.flows ?? [];

  async function run(flowId: string, action: () => Promise<unknown>) {
    setBusyId(flowId);
    setActionError(null);
    try {
      await action();
      await mutate();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha na operação");
    } finally {
      setBusyId(null);
    }
  }

  function novoFluxo() {
    const id = newFlowId();
    void run(id, async () => {
      await api(`/qualification/flows/${id}`, {
        method: "PUT",
        body: JSON.stringify({ nome: "Novo fluxo", ativo: false, definition: starterDefinition() }),
      });
      router.push(`/fluxos/${id}`);
    });
  }

  function duplicar(flow: FlowSummary) {
    void run(flow.id, async () => {
      try {
        // Endpoint oficial (POST /qualification/flows/:id/duplicate, body {name}).
        await api(`/qualification/flows/${flow.id}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ name: `${flow.nome} (cópia)` }),
        });
      } catch (cause) {
        const status = cause instanceof ApiError ? cause.status : 0;
        if (status !== 404 && status !== 405) throw cause;
        // Fallback: clona via PUT (upsert por id) com definition copiada.
        await api(`/qualification/flows/${newFlowId()}`, {
          method: "PUT",
          body: JSON.stringify({ nome: `${flow.nome} (cópia)`, ativo: false, definition: flow.definition }),
        });
      }
    });
  }

  function alternarAtivo(flow: FlowSummary) {
    void run(flow.id, async () => {
      await api(`/qualification/flows/${flow.id}`, {
        method: "PUT",
        body: JSON.stringify({ nome: flow.nome, ativo: !flow.ativo }),
      });
    });
  }

  if (!canRead) {
    return (
      <Shell>
        <p className="error" role="alert">Você não tem permissão para ver fluxos.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Fluxos</h1>
          <p className="sub">Atendimento automático por robô: mensagens, perguntas, esperas e ações no CRM.</p>
        </div>
        <Button type="button" tone="primary" disabled={!canManage || busyId !== null} onClick={novoFluxo}>
          <Plus size={16} aria-hidden="true" /> Novo fluxo
        </Button>
      </header>

      {actionError ? <p className="error" role="alert">{actionError}</p> : null}

      {isLoading ? <div className="skeleton h-24 w-full" aria-hidden="true" /> : null}
      {error ? <p className="error" role="alert">Não foi possível carregar os fluxos.</p> : null}

      {!isLoading && !error && flows.length === 0 ? (
        <section className="card mt-4 grid place-items-center gap-3 p-10 text-center">
          <Plugs size={28} aria-hidden="true" style={{ color: "var(--text-disabled)" }} />
          <p className="label">Nenhum fluxo</p>
          <p className="sub">Crie um fluxo para automatizar o atendimento por WhatsApp.</p>
          {canManage ? (
            <Button type="button" tone="primary" onClick={novoFluxo}>
              <Plus size={16} aria-hidden="true" /> Novo fluxo
            </Button>
          ) : null}
        </section>
      ) : null}

      {flows.length > 0 ? (
        <div className="card mt-4 overflow-hidden" style={{ padding: 0 }}>
          <ul role="list" className="m-0 grid gap-0 p-0" style={{ listStyle: "none" }}>
            {flows.map((flow, index) => (
              <li
                key={flow.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
                style={index > 0 ? { borderTop: "1px solid var(--border-subtle)" } : undefined}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/fluxos/${flow.id}`} className="font-semibold" style={{ color: "var(--text)" }}>{flow.nome}</Link>
                    <span className={isActivePillClass(flow.ativo)}>{flow.ativo ? "Ativo" : "Inativo"}</span>
                  </div>
                  <p className="sub m-0">{triggerSummary(flow.definition)} · atualizado {flow.atualizado_em ? formatPanelDateTime(flow.atualizado_em) : "—"}</p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Minimalismo (README §4): só "Novo fluxo" tem texto; ações
                      por linha viram IconButton com o texto antigo no label. */}
                  <IconButton label="Editar" size="sm" asChild>
                    <Link href={`/fluxos/${flow.id}`}>
                      <PencilSimple size={15} aria-hidden="true" />
                    </Link>
                  </IconButton>
                  <IconButton
                    label="Duplicar"
                    size="sm"
                    disabled={!canManage || busyId !== null}
                    onClick={() => duplicar(flow)}
                  >
                    <CopySimple size={15} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={flow.ativo ? "Desativar" : "Ativar"}
                    size="sm"
                    disabled={!canManage || busyId !== null}
                    onClick={() => alternarAtivo(flow)}
                  >
                    <ArrowsClockwise size={15} aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Shell>
  );
}

function isActivePillClass(ativo: boolean): string {
  const base = "mono rounded-full border px-3 py-1 type-caption font-semibold uppercase tracking-[.12em]";
  return `${base} ${ativo ? "border-[var(--success-border)] text-[var(--success-text)]" : "border-[var(--border)] text-[var(--text-muted)]"}`;
}

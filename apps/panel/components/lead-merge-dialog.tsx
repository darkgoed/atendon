"use client";

/**
 * Merge de contatos (B5 da spec v7 / R11 da v6) — dialog acionado com
 * exatamente 2 contatos selecionados em /contatos. O backend decide tudo
 * (preflight conta os vínculos, merge move as FKs em transação única e
 * soft-deleta o source com merged_into_id); aqui só se escolhe qual contato
 * permanece como principal, mostram-se as consequências e pede-se confirmação
 * explícita quando os telefones normalizados são diferentes.
 */

import { useEffect, useState } from "react";
import { ArrowsLeftRight, Warning } from "@/components/icons";
import { Button, Dialog, SaveButton } from "@/components/ui";
import { api } from "@/lib/api";

export type LeadMergePairItem = { id: string; nome: string | null; telefone: string };

type Preflight = {
  source_id: string;
  target_id: string;
  same_normalized_phone: boolean;
  conflicts: {
    conversations: number;
    tasks: number;
    tags: number;
    pipeline_positions: number;
    notes: number;
    custom_fields: number;
    appointments: number;
  };
};

type MergeResult = {
  target: { id: string; phone: string; name: string | null };
  moved: Record<string, number>;
};

const conflictLabels: Array<[keyof Preflight["conflicts"], string]> = [
  ["conversations", "conversa(s)"],
  ["tasks", "tarefa(s)"],
  ["tags", "etiqueta(s)"],
  ["notes", "nota(s)"],
  ["custom_fields", "valor(es) personalizado(s)"],
  ["appointments", "agendamento(s)"]
];

const movedLabels: Array<[string, string]> = [
  ["conversations", "conversa(s)"],
  ["tasks", "tarefa(s)"],
  ["notes", "nota(s)"],
  ["tags", "etiqueta(s)"],
  ["custom_values", "valor(es) personalizado(s)"],
  ["appointments", "agendamento(s)"],
  ["flow_states", "estado(s) de fluxo"],
  ["flow_log", "registro(s) de execução de fluxo"],
  ["lead_events", "evento(s) do contato"],
  ["post_sales", "cliente(s) de pós-venda"]
];

function leadName(lead: LeadMergePairItem) {
  return lead.nome ?? "Sem nome";
}

export function LeadMergeDialog({
  open,
  pair,
  onClose,
  onMerged
}: {
  open: boolean;
  pair: [LeadMergePairItem, LeadMergePairItem];
  onClose: () => void;
  onMerged: () => unknown | Promise<unknown>;
}) {
  const [principalId, setPrincipalId] = useState(pair[0].id);
  const [phase, setPhase] = useState<"choose" | "confirm" | "done">("choose");
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [ackDifferentPhone, setAckDifferentPhone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  // Reabrir sempre no passo inicial, com o primeiro selecionado como principal.
  useEffect(() => {
    if (!open) return;
    setPrincipalId(pair[0].id);
    setPhase("choose");
    setPreflight(null);
    setResult(null);
    setAckDifferentPhone(false);
    setError("");
  }, [open, pair]);

  const principal = pair.find((lead) => lead.id === principalId) ?? pair[0];
  const absorbed = pair.find((lead) => lead.id !== principalId) ?? pair[1];

  async function runPreflight() {
    setPending(true);
    setError("");
    try {
      const result = await api<Preflight>("/organization/leads/merge/preflight", {
        method: "POST",
        body: JSON.stringify({ source_id: absorbed.id, target_id: principal.id })
      });
      setPreflight(result);
      setAckDifferentPhone(false);
      setPhase("confirm");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao analisar a mesclagem");
    } finally {
      setPending(false);
    }
  }

  async function merge() {
    if (!preflight) return;
    if (!preflight.same_normalized_phone && !ackDifferentPhone) return;
    setPending(true);
    setError("");
    try {
      const moved = await api<MergeResult>("/organization/leads/merge", {
        method: "POST",
        body: JSON.stringify({
          source_id: absorbed.id,
          target_id: principal.id,
          ...(!preflight.same_normalized_phone ? { confirmations: { different_phone: true } } : {})
        })
      });
      setResult(moved);
      setPhase("done");
      await onMerged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao mesclar os contatos");
      // O backend pode ter detectado mudança de estado desde o preflight
      // (409 LEAD_ALREADY_MERGED): volta ao passo 1 para reanalisar.
      setPhase("choose");
      setPreflight(null);
    } finally {
      setPending(false);
    }
  }

  const conflictSummary = preflight
    ? conflictLabels
        .filter(([key]) => preflight.conflicts[key] > 0)
        .map(([key, label]) => `${preflight.conflicts[key]} ${label}`)
    : [];
  const movedSummary = result
    ? movedLabels
        .filter(([key]) => (result.moved[key] ?? 0) > 0)
        .map(([key, label]) => `${result.moved[key]} ${label}`)
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Mesclar contatos"
      description="Um contato absorve o outro: conversas, tarefas, notas, etiquetas e agendamentos passam para o contato principal."
      size="md"
    >
      {phase === "choose" ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => { event.preventDefault(); void runPreflight(); }}
          aria-busy={pending}
        >
          <fieldset className="grid gap-2">
            <legend className="label">Qual contato permanece como principal?</legend>
            {pair.map((lead) => (
              <label
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${lead.id === principalId ? "border-[var(--primary-border)] bg-[var(--primary-subtle)]" : "border-[var(--border)]"}`}
                key={lead.id}
              >
                <input
                  type="radio"
                  name="merge-principal"
                  value={lead.id}
                  checked={lead.id === principalId}
                  onChange={() => setPrincipalId(lead.id)}
                />
                <span className="min-w-0">
                  <strong>{leadName(lead)}</strong>
                  <span className="mono block text-xs text-[var(--text-secondary)]">{lead.telefone}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="sub">O contato <strong>{leadName(absorbed)}</strong> sai da lista de contatos e não pode ser recuperado como contato separado — todo o histórico dele passa para <strong>{leadName(principal)}</strong>.</p>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" onClick={onClose}>Cancelar</Button>
            <SaveButton type="submit" state={pending ? "busy" : "idle"} busyLabel="Analisando…">
              Analisar mesclagem
            </SaveButton>
          </div>
        </form>
      ) : null}

      {phase === "confirm" && preflight ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => { event.preventDefault(); void merge(); }}
          aria-busy={pending}
        >
          <p className="text-sm">
            <ArrowsLeftRight size={15} className="mr-1 inline text-[var(--primary-text)]" aria-hidden="true" />
            Tudo de <strong>{leadName(absorbed)}</strong> (<span className="mono">{absorbed.telefone}</span>) passa para{" "}
            <strong>{leadName(principal)}</strong> (<span className="mono">{principal.telefone}</span>), que mantém o próprio telefone e cadastro.
          </p>
          <div className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
            {conflictSummary.length > 0 ? (
              <p>Serão movidos: {conflictSummary.join(", ")}.</p>
            ) : (
              <p className="text-[var(--text-secondary)]">Nenhum vínculo para mover — só o cadastro de {leadName(absorbed)} será desativado.</p>
            )}
            {preflight.conflicts.pipeline_positions > 0 ? <p className="mt-1">Os contatos estão em etapas diferentes do pipeline: <strong>vale a etapa do contato principal</strong>.</p> : null}
          </div>
          {preflight.same_normalized_phone ? (
            <p className="rounded-md border border-[var(--success-border)] bg-[var(--success-subtle)] px-3 py-2 text-sm text-[var(--success-text)]" role="status">
              Os telefones coincidem após a normalização — mesclagem padrão de duplicado.
            </p>
          ) : (
            <div className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-subtle)] px-3 py-2 text-sm text-[var(--warning-text)]">
              <p className="flex items-start gap-2"><Warning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />Os telefones são <strong>diferentes</strong>. Só confirme se tiver certeza de que é a mesma pessoa com dois cadastros — a ação não pode ser desfeita.</p>
              <label className="mt-2 flex items-start gap-2 text-[var(--text)]">
                <input type="checkbox" checked={ackDifferentPhone} onChange={(event) => setAckDifferentPhone(event.target.checked)} />
                <span>Confirmo que quero mesclar contatos com telefones diferentes.</span>
              </label>
            </div>
          )}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" disabled={pending} onClick={() => { setPhase("choose"); setPreflight(null); }}>Voltar</Button>
            <SaveButton
              type="submit"
              tone="danger"
              state={pending ? "busy" : "idle"}
              busyLabel="Mesclando…"
              disabled={!preflight.same_normalized_phone && !ackDifferentPhone}
            >
              Mesclar contatos
            </SaveButton>
          </div>
        </form>
      ) : null}

      {phase === "done" && result ? (
        <div className="grid gap-3" role="status">
          <p className="text-sm">
            Contatos mesclados: <strong>{leadName(absorbed)}</strong> agora aponta para{" "}
            <strong>{result.target.name ?? result.target.phone}</strong> e sai das listas.
          </p>
          <div className="rounded-md border border-[var(--success-border)] bg-[var(--success-subtle)] px-3 py-2 text-sm text-[var(--success-text)]">
            {movedSummary.length > 0 ? `Movidos para o contato principal: ${movedSummary.join(", ")}.` : "Nenhum vínculo precisava ser movido."}
          </div>
          <div className="flex justify-end">
            <Button type="button" tone="primary" onClick={() => { onClose(); }}>Fechar</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

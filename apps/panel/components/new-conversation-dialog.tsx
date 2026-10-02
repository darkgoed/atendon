"use client";

/**
 * Nova conversa outbound (B7/B8 da spec v7) — dialog da caixa de entrada.
 * Usa os endpoints existentes: busca de contatos (/scheduling/leads),
 * conexões WhatsApp (/connections) e POST /conversations/initiate, que cria
 * (ou reusa) a conversa, pausa a IA do contato e envia a primeira mensagem
 * pela conexão escolhida. O backend é a única fonte de regras: escopo do
 * lead, conexão conectada e idempotência do envio.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { PaperPlaneTilt } from "@/components/icons";
import { Button, Dialog, Field, Input, SaveButton, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { randomUUID } from "@/lib/compat";
import type { ConnectionState } from "@/lib/connections";

const fetcher = <T,>(url: string) => api<T>(url);

type LeadHit = { id: string; telefone: string; nome?: string };
type LeadsResponse = { leads: LeadHit[] };

const MAX_TEXT = 4_000;

export function NewConversationDialog({
  open,
  onClose,
  onInitiated
}: {
  open: boolean;
  onClose: () => void;
  onInitiated: (conversationId: string) => void;
}) {
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [leadId, setLeadId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setBusca(""); setDebounced(""); setLeadId(""); setSessionId(""); setText("");
    setError("");
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(busca.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [busca]);

  const { data: connectionData, error: connectionError, isLoading: connectionsLoading } = useSWR<{ connections: ConnectionState[] }>(
    open ? "/connections" : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  // O initiate exige conexão WhatsApp conectada — só essas são candidatas.
  const connections = useMemo(
    () => (connectionData?.connections ?? []).filter((connection) => connection.channel === "whatsapp" && connection.status === "connected"),
    [connectionData]
  );
  useEffect(() => {
    if (!open) return;
    if (connections.some((connection) => connection.id === sessionId)) return;
    setSessionId(connections[0]?.id ?? "");
  }, [connections, open, sessionId]);

  const { data: leadData, error: leadError } = useSWR<LeadsResponse>(
    open && debounced.length >= 2 ? `/scheduling/leads?busca=${encodeURIComponent(debounced)}&limit=8` : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const hits = leadData?.leads ?? [];
  const canSubmit = Boolean(leadId && sessionId && text.trim()) && !sending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError("");
    try {
      const result = await api<{ conversation_id: string }>(
        "/conversations/initiate",
        {
          method: "POST",
          headers: { "idempotency-key": randomUUID() },
          body: JSON.stringify({ lead_id: leadId, session_id: sessionId, text: text.trim() })
        }
      );
      setText("");
      onInitiated(result.conversation_id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao iniciar a conversa");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Nova conversa"
      description="Escolha o contato, a conexão de WhatsApp e escreva a primeira mensagem. A IA do contato fica pausada até um atendente reativar."
    >
      <form className="grid gap-3" onSubmit={submit} aria-busy={sending}>
        <Field label="Buscar contato" help="Busca por nome ou telefone; só contatos que você pode acessar aparecem.">
          <Input
            type="search"
            value={busca}
            onChange={(event) => setBusca(event.target.value)}
            placeholder="Nome ou telefone"
            autoComplete="off"
          />
        </Field>
        <div aria-live="polite">
          {debounced.length < 2 ? (
            <p className="sub">Digite ao menos 2 caracteres para buscar contatos.</p>
          ) : leadError ? (
            <p className="error" role="alert">Falha ao buscar contatos.</p>
          ) : hits.length === 0 ? (
            <p className="sub">Nenhum contato encontrado. Cadastre em Contatos para iniciar a conversa.</p>
          ) : (
            <fieldset className="grid gap-1">
              <legend className="sr-only">Contatos encontrados</legend>
              {hits.map((lead) => (
                <label
                  key={lead.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors ${lead.id === leadId ? "border-[var(--primary-border)] bg-[var(--primary-subtle)]" : "border-[var(--border)]"}`}
                >
                  <input
                    type="radio"
                    name="new-conversation-lead"
                    checked={lead.id === leadId}
                    onChange={() => setLeadId(lead.id)}
                  />
                  <span className="min-w-0"><strong>{lead.nome ?? "Sem nome"}</strong><span className="mono block text-xs text-[var(--text-secondary)]">{lead.telefone}</span></span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
        <Field label="Conexão de WhatsApp" hint="Só conexões conectadas podem iniciar conversas.">
          <select
            className="input"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            disabled={connectionsLoading || connections.length === 0}
            required
          >
            <option value="">{connectionsLoading ? "Carregando…" : "Selecione"}</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}{connection.phone_number ? ` · ${connection.phone_number}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {connectionsError(connectionError) ? <p className="error" role="alert">Falha ao carregar as conexões.</p> : null}
        {!connectionsLoading && connections.length === 0 && !connectionsError(connectionError) ? (
          <p className="sub">Nenhuma conexão WhatsApp conectada. Conecte uma em Configurações · Conexão.</p>
        ) : null}
        <Field label="Primeira mensagem" hint={`Até ${MAX_TEXT} caracteres.`}>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT))}
            rows={3}
            placeholder="Ex.: Olá! Aqui é a Ana da loja…"
            required
          />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" disabled={sending} onClick={onClose}>Cancelar</Button>
          <SaveButton type="submit" state={sending ? "busy" : "idle"} busyLabel="Enviando…" disabled={!canSubmit} icon={<PaperPlaneTilt size={15} aria-hidden="true" />}>
            Iniciar conversa
          </SaveButton>
        </div>
      </form>
    </Dialog>
  );
}

function connectionsError(error: unknown): boolean {
  return Boolean(error);
}

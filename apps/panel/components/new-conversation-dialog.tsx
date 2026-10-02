"use client";

/**
 * Nova conversa outbound (B7/B8 da spec v7) — dialog da caixa de entrada.
 * Usa os endpoints existentes: busca de contatos (/scheduling/leads),
 * conexões WhatsApp (/connections) e POST /conversations/initiate, que cria
 * (ou reusa) a conversa, pausa a IA do contato e envia a primeira mensagem
 * pela conexão escolhida. O backend é a única fonte de regras: escopo do
 * lead, conexão conectada e idempotência do envio.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { PaperPlaneTilt } from "@/components/icons";
import { Button, Dialog, Field, Input, SaveButton, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { randomUUID } from "@/lib/compat";
import type { ConnectionState } from "@/lib/connections";
import { formatBrazilianPhone, isValidBrazilianPhone } from "@/lib/phone";
import { usePermission } from "@/lib/use-permission";

const fetcher = <T,>(url: string) => api<T>(url, undefined, { reportErrors: false });

type LeadHit = { id: string; telefone: string; nome?: string };
type LeadsResponse = { leads: LeadHit[] };

const MAX_TEXT = 4_000;

export function NewConversationDialog({
  open,
  onClose,
  onInitiated,
  initialLead
}: {
  open: boolean;
  onClose: () => void;
  onInitiated: (conversationId: string) => void;
  initialLead?: LeadHit;
}) {
  const canCreate = usePermission("leads.create");
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedLead, setSelectedLead] = useState<LeadHit | undefined>(initialLead);
  const [newContact, setNewContact] = useState(false);
  const [draft, setDraft] = useState({ nome: "", telefone: "", origem: "" });
  const [creating, setCreating] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const session = useRef(0);
  const createLock = useRef(false);
  const sendLock = useRef(false);
  const initialId = initialLead?.id;
  const initialPhone = initialLead?.telefone;
  const initialName = initialLead?.nome;
  const busy = sending || creating;

  useLayoutEffect(() => {
    session.current += 1;
    if (open) {
      setBusca(""); setDebounced(""); setSessionId(""); setText("");
      setSelectedLead(initialId && initialPhone ? { id: initialId, telefone: initialPhone, nome: initialName } : undefined);
      setNewContact(false);
      setDraft({ nome: "", telefone: "", origem: "" });
      setError("");
    }
    return () => { session.current += 1; };
  }, [open, initialId, initialPhone, initialName]);

  function close() {
    session.current += 1;
    onClose();
  }

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

  const { data: leadData, error: leadError, isLoading: leadsLoading } = useSWR<LeadsResponse>(
    open && !newContact && debounced.length >= 2 ? `/scheduling/leads?busca=${encodeURIComponent(debounced)}&limit=8` : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const hits = leadData?.leads ?? [];
  const searchPending = busca.trim() !== debounced || leadsLoading;
  const leadId = selectedLead?.id;
  const canSubmit = Boolean(leadId && sessionId && text.trim()) && !busy && !newContact;
  const phoneValid = isValidBrazilianPhone(draft.telefone);
  const canCreateContact = canCreate && phoneValid && Boolean(draft.origem.trim()) && !busy;

  async function createContact() {
    if (!open || !newContact || !canCreateContact || createLock.current || sendLock.current) return;
    createLock.current = true;
    const requestSession = session.current;
    setCreating(true);
    setError("");
    try {
      const result = await api<{ lead: LeadHit }>("/scheduling/leads", {
        method: "POST",
        body: JSON.stringify({ telefone: draft.telefone, nome: draft.nome.trim() || undefined, origem: draft.origem.trim() })
      }, { reportErrors: false });
      if (session.current !== requestSession) return;
      if (!result?.lead?.id || !result.lead.telefone) throw new Error("Não foi possível selecionar o contato criado");
      setSelectedLead(result.lead);
      setBusca(""); setDebounced("");
      setNewContact(false);
    } catch (cause) {
      if (session.current === requestSession) setError(cause instanceof Error ? cause.message : "Falha ao criar o contato");
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (newContact) { await createContact(); return; }
    if (!open || !canSubmit || sendLock.current || createLock.current) return;
    sendLock.current = true;
    const requestSession = session.current;
    setSending(true);
    setError("");
    try {
      const result = await api<{ conversation_id: string }>(
        "/conversations/initiate",
        {
          method: "POST",
          headers: { "idempotency-key": randomUUID() },
          body: JSON.stringify({ lead_id: leadId, session_id: sessionId, text: text.trim() })
        },
        { reportErrors: false }
      );
      if (session.current !== requestSession) return;
      setText("");
      onInitiated(result.conversation_id);
      close();
    } catch (cause) {
      if (session.current === requestSession) setError(cause instanceof Error ? cause.message : "Falha ao iniciar a conversa");
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      title="Nova conversa"
      description="Escolha o contato, a conexão de WhatsApp e escreva a primeira mensagem. A IA do contato fica pausada até um atendente reativar."
    >
      <form className="grid gap-3" onSubmit={submit} aria-busy={busy}>
        {canCreate ? <Button type="button" disabled={busy} onClick={() => { setNewContact(!newContact); setError(""); }}>
          {newContact ? "Buscar contato existente" : "Novo contato"}
        </Button> : null}
        {newContact && canCreate ? (
          <fieldset className="grid gap-3" disabled={busy}>
            <legend>Novo contato</legend>
            <Field label="Nome (opcional)">
              <Input value={draft.nome} maxLength={200} onChange={(event) => setDraft({ ...draft, nome: event.target.value })} />
            </Field>
            <Field label="Telefone / WhatsApp" hint="Informe DDD + número." error={draft.telefone && !phoneValid ? "Informe um telefone com 10 ou 11 dígitos." : undefined}>
              <Input type="tel" value={draft.telefone} autoComplete="tel-national" onChange={(event) => setDraft({ ...draft, telefone: formatBrazilianPhone(event.target.value) })} required />
            </Field>
            <Field label="Origem" hint="Ex.: Indicação ou anúncio. Obrigatória para um novo contato.">
              <Input value={draft.origem} maxLength={200} onChange={(event) => setDraft({ ...draft, origem: event.target.value })} required />
            </Field>
            <SaveButton type="button" state={creating ? "busy" : "idle"} busyLabel="Criando…" disabled={!canCreateContact} onClick={createContact}>Criar contato</SaveButton>
          </fieldset>
        ) : (
        <>
        <Field label="Buscar contato" help="Busca por nome ou telefone; só contatos que você pode acessar aparecem.">
          <Input
            type="search"
            value={busca}
            disabled={busy}
            onChange={(event) => { setBusca(event.target.value); setSelectedLead(undefined); setError(""); }}
            placeholder="Nome ou telefone"
            autoComplete="off"
          />
        </Field>
        {selectedLead ? <p className="sub" role="status">Contato selecionado: {selectedLead.nome || "Sem nome"} · {selectedLead.telefone}</p> : null}
        <div aria-live="polite">
          {searchPending ? (
            <p className="sub">Buscando contatos…</p>
          ) : debounced.length < 2 ? (
            <p className="sub">Digite ao menos 2 caracteres para buscar contatos.</p>
          ) : leadError ? (
            <p className="error" role="alert">Falha ao buscar contatos.</p>
          ) : hits.length === 0 ? (
            <p className="sub">Nenhum contato encontrado.</p>
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
                    disabled={busy}
                    checked={lead.id === leadId}
                    onChange={() => setSelectedLead(lead)}
                  />
                  <span className="min-w-0"><strong>{lead.nome ?? "Sem nome"}</strong><span className="mono block text-xs text-[var(--text-secondary)]">{lead.telefone}</span></span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
        </>
        )}
        <Field label="Conexão de WhatsApp" hint="Só conexões conectadas podem iniciar conversas.">
          <select
            className="input"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            disabled={busy || connectionsLoading || connections.length === 0}
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
            disabled={sending}
            onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT))}
            rows={3}
            placeholder="Ex.: Olá! Aqui é a Ana da loja…"
            required
          />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" disabled={busy} onClick={close}>Cancelar</Button>
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

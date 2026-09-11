"use client";

import { CalendarDots, Check, PencilSimple, X } from "@phosphor-icons/react";
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";

function localValue(value: string | null, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).reduce<Record<string, string>>((all, part) => {
    if (part.type !== "literal") all[part.type] = part.value;
    return all;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function ConversationNextAction({
  leadId, nextAction, nextActionAt, assignedUserEmail,
  timezone, canManage, onSaved
}: {
  leadId: string;
  nextAction: string | null;
  nextActionAt: string | null;
  assignedUserEmail: string | null;
  timezone: string;
  canManage: boolean;
  onSaved: () => void | Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState(nextAction ?? "");
  const [when, setWhen] = useState(localValue(nextActionAt, timezone));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    setAction(nextAction ?? "");
    setWhen(localValue(nextActionAt, timezone));

    setError("");
    setNotice("");
  }, [nextAction, nextActionAt, open, timezone]);

  const due = useMemo(() => Boolean(nextActionAt && new Date(nextActionAt).getTime() <= clock), [clock, nextActionAt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const description = action.trim();
    if (!description || !when) {
      setError("Informe a descrição e a data da próxima ação.");
      return;
    }
    if (description.length > 500) {
      setError("A descrição deve ter no máximo 500 caracteres.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    let followUpSaved = false;
    try {
      await api(`/scheduling/leads/${leadId}/follow-up`, {
        method: "PATCH",
        body: JSON.stringify({ proxima_acao: description, proxima_acao_em_local: when })
      });
      followUpSaved = true;
      await onSaved();
      setNotice("Próxima ação atualizada.");
      setOpen(false);
    } catch (saveError) {
      setError(followUpSaved
        ? `Próxima ação salva, mas a lista não foi revalidada: ${saveError instanceof Error ? saveError.message : "falha desconhecida"}`
        : saveError instanceof Error ? saveError.message : "Falha ao salvar a próxima ação");
    } finally { setBusy(false); }
  }

  return (
    <section className={`card ${due ? "border-[var(--warn-border)]" : ""}`} aria-labelledby="conversation-next-action-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id="conversation-next-action-title" className="cardtitle flex items-center gap-1.5"><CalendarDots size={14} aria-hidden="true" /> Próxima ação</div>
          {due ? <strong className="mt-1 block text-xs text-[var(--warn)]">Pendência</strong> : null}
          <p className={`mt-1 whitespace-pre-wrap text-sm ${due ? "text-[var(--warn)]" : "text-[var(--text-3)]"}`}>{nextAction || "Nenhuma próxima ação definida."}</p>
          {nextActionAt ? <time className="mono mt-1 block text-[11px] text-[var(--faint)]">{new Date(nextActionAt).toLocaleString("pt-BR", { timeZone: timezone })}</time> : null}
          {assignedUserEmail ? <p className="mt-1 text-[11px] text-[var(--faint)]">Responsável: {assignedUserEmail}</p> : null}
        </div>
        {canManage ? <button type="button" className="btn shrink-0 p-2" onClick={() => setOpen(true)} aria-label="Editar próxima ação"><PencilSimple size={14} /></button> : null}
      </div>
      {notice ? <p className="mt-2 text-xs text-[var(--ok)]" role="status">{notice}</p> : null}
      {open ? <ModalDialog labelledBy="next-action-dialog-title" onClose={() => { if (!busy) setOpen(false); }}>
        <form onSubmit={save} className="grid gap-4">
          <div className="flex items-center justify-between"><h2 id="next-action-dialog-title" className="text-base font-semibold">Próxima ação</h2><button type="button" className="btn p-2" onClick={() => setOpen(false)} disabled={busy} aria-label="Fechar"><X size={16} /></button></div>
          <label className="field"><span className="label">Descrição <b aria-hidden="true">*</b></span><textarea className="input min-h-24" value={action} maxLength={500} required onChange={(event) => setAction(event.target.value)} /><small className="text-[var(--faint)]">{action.length}/500</small></label>
          <label className="field"><span className="label">Data e hora local <b aria-hidden="true">*</b></span><input className="input" type="datetime-local" value={when} required onChange={(event) => setWhen(event.target.value)} /><small className="text-[var(--faint)]">Fuso do workspace: {timezone}</small></label>

          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancelar</button><button type="submit" className="btn primary" disabled={busy}>{busy ? "Salvando…" : <><Check size={14} /> Salvar</>}</button></div>
        </form>
      </ModalDialog> : null}
    </section>
  );
}

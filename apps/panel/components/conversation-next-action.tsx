"use client";

import { Button, HelpHint, IconButton, Input, SaveButton, SaveToast, Textarea, useSaveFeedback } from "@/components/ui";
import { CalendarDots, Check, PencilSimple, X } from "@/components/icons";
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
  const saveFeedback = useSaveFeedback();
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
      saveFeedback.markDone();
      setOpen(false);
    } catch (saveError) {
      setError(followUpSaved
        ? `Próxima ação salva, mas a lista não foi revalidada: ${saveError instanceof Error ? saveError.message : "falha desconhecida"}`
        : saveError instanceof Error ? saveError.message : "Falha ao salvar a próxima ação");
    } finally { setBusy(false); }
  }

  return (
    <section className={`card ${due ? "border-[var(--warning-border)]" : ""}`} aria-labelledby="conversation-next-action-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id="conversation-next-action-title" className="cardtitle flex items-center gap-1.5"><CalendarDots size={14} aria-hidden="true" /> Próxima ação<HelpHint label="Ajuda: Próxima ação">Define o próximo passo do follow-up e a data em que ele vence. Passada a data, o card fica marcado como Pendência.</HelpHint></div>
          {due ? <strong className="mt-1 block text-xs text-[var(--warning-text)]">Pendência</strong> : null}
          <p className={`mt-1 whitespace-pre-wrap text-sm ${due ? "text-[var(--warning-text)]" : "text-[var(--text-secondary)]"}`}>{nextAction || "Nenhuma próxima ação definida."}</p>
          {nextActionAt ? <time className="mono mt-1 block text-xs text-[var(--text-muted)]">{new Date(nextActionAt).toLocaleString("pt-BR", { timeZone: timezone })}</time> : null}
          {assignedUserEmail ? <p className="mt-1 text-xs text-[var(--text-muted)]">Responsável: {assignedUserEmail}</p> : null}
        </div>
        {canManage ? <IconButton type="button" label="Editar próxima ação" className="shrink-0" onClick={() => setOpen(true)}><PencilSimple size={14} aria-hidden="true" /></IconButton> : null}
      </div>
      {notice ? <p className="mt-2 text-xs text-[var(--success-text)]" role="status">{notice}</p> : null}
      {open ? <ModalDialog labelledBy="next-action-dialog-title" onClose={() => { if (!busy) setOpen(false); }}>
        <form onSubmit={save} className="grid gap-4">
          <div className="flex items-center justify-between"><h2 id="next-action-dialog-title" className="text-base font-semibold">Próxima ação</h2><IconButton type="button" label="Fechar" onClick={() => setOpen(false)} disabled={busy}><X size={16} aria-hidden="true" /></IconButton></div>
          <label className="field"><span className="label">Descrição <b aria-hidden="true">*</b></span><Textarea className="input" value={action} maxLength={500} required onChange={(event) => setAction(event.target.value)} /><small className="text-[var(--text-muted)]">{action.length}/500</small></label>
          <label className="field"><span className="label">Data e hora local <b aria-hidden="true">*</b></span><Input className="input" type="datetime-local" value={when} required onChange={(event) => setWhen(event.target.value)} /><small className="text-[var(--text-muted)]">Fuso do workspace: {timezone}</small></label>

          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2"><Button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button><SaveButton type="submit" state={busy ? "busy" : saveFeedback.state} icon={<Check size={14} aria-hidden="true" />}>Salvar</SaveButton></div>
        </form>
      </ModalDialog> : null}
      <SaveToast show={saveFeedback.done}>Próxima ação salva</SaveToast>
    </section>
  );
}

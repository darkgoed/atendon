"use client";

import { CalendarX, Trash, X } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import { defaultManualAppointmentStart, instantFromLocalMinute, localMinute } from "@/lib/timezone";
import type { AttendantTimeBlock } from "./agenda-types";
import { messageFrom } from "./agenda-utils";

export function AgendaTimeBlockDialog({ open, anchor, timezone, onClose, onSaved }: {
  open: boolean;
  anchor: string;
  timezone: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const initialStart = defaultManualAppointmentStart(anchor, timezone);
    setStart(localMinute(initialStart, timezone));
    setEnd(localMinute(new Date(new Date(initialStart).getTime() + 60 * 60_000).toISOString(), timezone));
    setReason("");
    setError("");
  }, [anchor, open, timezone]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const startInstant = instantFromLocalMinute(start, timezone);
    const endInstant = instantFromLocalMinute(end, timezone);
    if (!startInstant || !endInstant || new Date(endInstant) <= new Date(startInstant)) {
      setError("Informe um término posterior ao início.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/scheduling/attendants/me/time-blocks", {
        method: "POST",
        body: JSON.stringify({ start: startInstant, end: endInstant, reason: reason.trim() || null })
      });
      await onSaved();
      onClose();
    } catch (submitError) {
      setError(messageFrom(submitError, "Não foi possível bloquear esse horário."));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <ModalDialog
      labelledBy="agenda-time-block-title"
      describedBy="agenda-time-block-description"
      onClose={saving ? () => undefined : onClose}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">INDISPONIBILIDADE PESSOAL</span>
          <h2 id="agenda-time-block-title" className="mt-2 text-lg font-semibold">Bloquear horário</h2>
          <p id="agenda-time-block-description" className="mt-1 text-xs text-[var(--muted)]">A IA e o agendamento automático tratarão o período como ocupado somente para você.</p>
        </div>
        <button type="button" className="btn" onClick={onClose} disabled={saving} aria-label="Fechar"><X aria-hidden="true" /></button>
      </div>
      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field"><span className="label">Início</span><input className="input" type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} required disabled={saving} /></label>
          <label className="field"><span className="label">Término</span><input className="input" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} required disabled={saving} /></label>
        </div>
        <label className="field"><span className="label">Motivo (opcional)</span><input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Ex.: compromisso pessoal" disabled={saving} /></label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={saving}><CalendarX size={15} aria-hidden="true" />{saving ? "Bloqueando…" : "Bloquear período"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function AgendaTimeBlockList({ blocks, timezone, deletingId, onDelete }: {
  blocks: AttendantTimeBlock[];
  timezone: string;
  deletingId: string;
  onDelete: (id: string) => void | Promise<void>;
}) {
  if (!blocks.length) return null;
  return (
    <section className="agenda-block-list mb-4 border-y border-[var(--border)] py-3" aria-label="Seus horários bloqueados">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold"><CalendarX size={16} aria-hidden="true" />Seus horários bloqueados neste período</div>
      <div className="flex flex-wrap gap-2">
        {blocks.map((block) => (
          <div key={block.id} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
            <span>{new Date(block.start).toLocaleString("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} — {new Date(block.end).toLocaleString("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{block.reason ? ` · ${block.reason}` : ""}</span>
            <button type="button" className="grid size-7 place-items-center rounded border border-[var(--border)]" onClick={() => void onDelete(block.id)} disabled={deletingId === block.id} aria-label="Remover bloqueio"><Trash size={13} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
    </section>
  );
}

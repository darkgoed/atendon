import { Fragment } from "react";
import { Plus, Prohibit } from "@/components/icons";
import { isAppointmentResultPending } from "./agenda-appointment-state";
import type { Appointment, Slot } from "./agenda-types";
import { APPOINTMENT_STATUS_LABELS, dayKey, isActiveAppointment } from "./agenda-utils";

export type AgendaTimeGrid = {
  byDay: Map<string, Map<string, Slot>>;
  appointmentsByDay: Map<string, Map<string, Appointment[]>>;
  labels: string[];
};

export function AgendaCalendar({ days, today, timezone, failedDays, timeGrid, now, dragging, reschedulingId, pendingActionId, canReschedule, canCreate, blockMode = false, onDrag, onDrop, onOpen, onSelectSlot }: {
  days: Date[];
  today: string;
  timezone: string;
  failedDays: string[];
  timeGrid: AgendaTimeGrid;
  now: number;
  dragging: string;
  reschedulingId: string;
  pendingActionId: string;
  canReschedule: boolean;
  canCreate: boolean;
  /** Modo bloqueio: o clique num horário livre bloqueia em vez de agendar. */
  blockMode?: boolean;
  onDrag: (id: string) => void;
  onDrop: (start: string) => void;
  onCreate: (slot: Slot) => void;
  onOpen: (appointment: Appointment) => void;
  onSelectSlot?: (slot: Slot) => void;
}) {
  return (
    <section className={`agenda-grid${blockMode ? " agenda-grid--blocking" : ""}`} style={{ "--agenda-cols": days.length } as React.CSSProperties} aria-label="Disponibilidade da agenda">
      <div className="agenda-corner" aria-hidden="true" />
      {days.map((day) => {
        const key = dayKey(day);
        const failed = failedDays.includes(key);
        const hasData = timeGrid.byDay.has(key);
        const closed = hasData && !failed && (timeGrid.byDay.get(key)?.size ?? 0) === 0;
        return (
          <header key={key} className={`agenda-day-head ${key === today ? "is-today" : ""}`}>
            <span className="agenda-day-head__weekday">{day.toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "short" })}</span>
            <strong className="mono agenda-day-head__date">{day.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" })}</strong>
            {failed ? <span className="agenda-day-head__note agenda-day-head__note--warn">{hasData ? "Somente consulta" : "Falha ao atualizar"}</span> : null}
            {closed ? <span className="agenda-day-head__note">Fechado</span> : null}
          </header>
        );
      })}
      {timeGrid.labels.length === 0 ? <p className="agenda-empty">Nenhum horário configurado neste período.</p> : timeGrid.labels.map((label) => (
        <Fragment key={label}>
          <div className="agenda-time mono">{label}</div>
          {days.map((day) => {
            const key = dayKey(day);
            const items = timeGrid.appointmentsByDay.get(key)?.get(label) ?? [];
            const configuredSlot = timeGrid.byDay.get(key)?.get(label);
            const slot = configuredSlot ?? (items[0] ? {
              start: items[0].start,
              end: items[0].end,
              vagas: 0,
              capacidade: items.length,
              ocupados_no_inicio: items.length
            } : undefined);
            if (!slot) return <div key={key} className={`agenda-cell agenda-cell--closed ${key === today ? "is-today" : ""}`} aria-hidden="true" />;
            return (
              <SlotCell
                key={key}
                slot={slot}
                timezone={timezone}
                isToday={key === today}
                availabilityFailed={failedDays.includes(key)}
                items={items}
                dragging={dragging}
                reschedulingId={reschedulingId}
                pendingActionId={pendingActionId}
                now={now}
                canReschedule={canReschedule}
                canCreate={(blockMode || canCreate) && Boolean(configuredSlot)}
                blockMode={blockMode}
                onDrag={onDrag}
                onDrop={onDrop}
                onOpen={onOpen}
                onSelectSlot={onSelectSlot}
              />
            );
          })}
        </Fragment>
      ))}
    </section>
  );
}

function SlotCell({ slot, timezone, isToday, availabilityFailed, items, dragging, reschedulingId, pendingActionId, now, canReschedule, canCreate, blockMode, onDrag, onDrop, onOpen, onSelectSlot }: {
  slot: Slot;
  timezone: string;
  isToday: boolean;
  availabilityFailed: boolean;
  items: Appointment[];
  dragging: string;
  reschedulingId: string;
  pendingActionId: string;
  now: number;
  canReschedule: boolean;
  canCreate: boolean;
  blockMode: boolean;
  onDrag: (id: string) => void;
  onDrop: (start: string) => void;
  onOpen: (appointment: Appointment) => void;
  onSelectSlot?: (slot: Slot) => void;
}) {
  const acceptsDrop = !availabilityFailed && canReschedule && Boolean(dragging);
  const canSchedule = !availabilityFailed && canCreate;
  const availabilityLabel = slot.vagas > 0 ? `${slot.vagas} livre${slot.vagas === 1 ? "" : "s"}` : (slot.ocupados_no_inicio ?? 0) > 0 ? "Compartilhado" : "Conflito";
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
  // Pré-visualização: o horário mostra o que o clique vai fazer.
  const preview = blockMode ? `Bloquear ${clock(slot.start)} – ${clock(slot.end)}` : `Agendar às ${clock(slot.start)}`;
  const selectable = items.length === 0 && canSchedule;
  const slotStart = new Date(slot.start).getTime();
  const slotEnd = new Date(slot.end).getTime();
  const nowPosition = isToday && slotEnd > slotStart && now >= slotStart && now < slotEnd
    ? Math.min(100, Math.max(0, ((now - slotStart) / (slotEnd - slotStart)) * 100))
    : null;
  return (
    <div
      onDragOver={(event) => { if (acceptsDrop) event.preventDefault(); }}
      onDrop={() => { if (acceptsDrop) void onDrop(slot.start); }}
      {...(selectable ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `${preview} · ${availabilityLabel}`,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectSlot?.(slot); } },
        onClick: () => onSelectSlot?.(slot)
      } : {})}
      className={`agenda-cell agenda-cell--open ${slot.vagas > 0 ? "" : "agenda-cell--full"} ${canSchedule ? "agenda-cell--clickable" : ""} ${acceptsDrop ? "agenda-cell--drop" : ""} ${isToday ? "is-today" : ""}`}
    >
      {selectable ? <span className="agenda-cell__preview" aria-hidden="true">{blockMode ? <Prohibit size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}{preview}</span> : null}
      {nowPosition !== null ? <span className="agenda-now-indicator" style={{ "--agenda-now": `${nowPosition}%` } as React.CSSProperties} aria-hidden="true" /> : null}
      <div className="agenda-cell__meta">
        <span className="sr-only mono agenda-cell__vagas" aria-label={`Disponibilidade: ${availabilityLabel}`}>{availabilityLabel}</span>
      </div>
      <div className={`agenda-cell__appointments ${items.length > 1 ? "agenda-cell__appointments--shared" : ""}`} style={{ "--appointment-columns": Math.max(items.length, 1) } as React.CSSProperties}>
        {items.map((item) => (
          <article
            key={item.id}
            draggable={isActiveAppointment(item.status) && canReschedule && !reschedulingId && !pendingActionId}
            onDragStart={() => onDrag(item.id)}
            onDragEnd={() => onDrag("")}
            onClick={() => onOpen(item)}
            style={{ "--appointment-color": item.responsavel?.cor_agenda ?? "var(--primary)" } as React.CSSProperties}
            className={`agenda-appointment agenda-appointment--${item.status} ${isAppointmentResultPending(item, now) ? "agenda-appointment--pending" : ""} ${isActiveAppointment(item.status) && canReschedule ? "agenda-appointment--draggable" : ""}`}
          >
            <button type="button" className="agenda-appointment__contact" onClick={(event) => { event.stopPropagation(); onOpen(item); }} aria-label={`Abrir detalhes de ${item.lead_nome ?? item.lead_telefone}`}>{item.lead_nome ?? item.lead_telefone}</button>
            <span className="agenda-appointment__time">{new Date(item.start).toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" })} — {new Date(item.end).toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" })}</span>
            <span className={`agenda-appointment__status ${isAppointmentResultPending(item, now) ? "text-[var(--warning-text)]" : ""}`}>{isAppointmentResultPending(item, now) ? "Resultado pendente" : APPOINTMENT_STATUS_LABELS[item.status]}</span>
            <span className="truncate type-caption text-[var(--text-muted)]">{item.responsavel?.email ?? "Sem responsável"}</span>
          </article>
        ))}
      </div>
    </div>
  );
}

"use client";

import { ArrowLeft, ArrowRight, WarningCircle } from "@/components/icons";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { useRealtimeSignals } from "@/lib/realtime";
import { usePermission } from "@/lib/use-permission";
import { AgendaCalendar, type AgendaTimeGrid } from "./agenda-calendar";
import { AgendaMonth } from "./agenda-month";
import { AgendaCreateDialog } from "./agenda-create-dialog";
import { AgendaDetailDialog } from "./agenda-detail-dialog";
import { AgendaHeader } from "./agenda-header";
import { AgendaTimeBlockDialog, AgendaTimeBlockList } from "./agenda-time-blocks";
import { AgendaSlotDialog } from "./agenda-slot-dialog";
import { isAppointmentResultPending } from "./agenda-appointment-state";
import { AgendaError, AgendaLoading } from "./agenda-states";
import type { AgendaPermissions, Appointment, AppointmentView, Slot } from "./agenda-types";
import { dayKey, isActiveAppointment, messageFrom } from "./agenda-utils";
import { useAgendaActions } from "./use-agenda-actions";
import { useAgendaData } from "./use-agenda-data";

function AgendaContent() {
  const searchParams = useSearchParams();
  const requestedAppointmentId = searchParams.get("appointment")?.match(/^[0-9a-f-]{36}$/i)?.[0] ?? "";
  const requestedUnit = searchParams.get("unit")?.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)?.[0] ?? "";
  const requestedDate = searchParams.get("date")?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? "";
  const permissions: AgendaPermissions = {
    canReschedule: usePermission("appointments.reschedule"),
    canCreate: usePermission("appointments.create"),
    canCancel: usePermission("appointments.cancel"),
    canComplete: usePermission("appointments.complete"),
    canNoShow: usePermission("appointments.no_show"),
    canManageNotes: usePermission("appointments.notes.manage"),
    canCreateLeads: usePermission("leads.create"),
    canReply: usePermission("conversations.reply"),
    canDeleteLead: usePermission("leads.delete")
  };
  const canBlockTime = usePermission("appointments.read");
  const data = useAgendaData({ requestedUnit, requestedDate, requestedAppointmentId });
  const { units, unitsStatus, unitsError, unit, anchor, mode, days, availability, appointmentsData, appointmentsError, appointmentsLoading, appointments, timezone, today, loadUnits, loadAvailability, mutateAppointments, navigate, goToday, timeBlocks, timeBlocksError, mutateTimeBlocks } = data;
  const [appointmentView, setAppointmentView] = useState<AppointmentView>("all");
  const [timeBlockOpen, setTimeBlockOpen] = useState(false);
  const [slotChoice, setSlotChoice] = useState<Slot | null>(null);
  const [deletingTimeBlockId, setDeletingTimeBlockId] = useState("");
  const [timeBlockActionError, setTimeBlockActionError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const openedDeepLink = useRef(false);
  const periodKey = `${anchor}:${mode}:${unit}`;
  const actions = useAgendaActions({ permissions, unit, anchor, timezone, appointments, periodKey, loadAvailability, mutateAppointments });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!requestedAppointmentId || openedDeepLink.current) return;
    const requested = appointments.find((appointment) => appointment.id === requestedAppointmentId);
    if (!requested) return;
    openedDeepLink.current = true;
    actions.openAppointment(requested);
  }, [actions, appointments, requestedAppointmentId]);

  useRealtimeSignals({
    onCatchUp: () => {
      if (document.visibilityState !== "visible") return;
      void Promise.allSettled([mutateAppointments(), loadAvailability()]);
    },
    onSignal: (signal) => {
      if (document.visibilityState === "visible" && (signal.type === "appointment.changed" || signal.type === "case.assignment.changed")) {
        actions.setJoinBlockedIds(new Set());
        void Promise.allSettled([mutateAppointments(), loadAvailability()]);
      }
    }
  });

  const pendingAppointmentsCount = useMemo(() => appointments.filter((appointment) => isAppointmentResultPending(appointment, now)).length, [appointments, now]);
  const visibleAppointments = useMemo(() => appointments.filter((appointment) => (
    appointmentView === "all"
    || (appointmentView === "active" && isActiveAppointment(appointment.status))
    || (appointmentView === "pending" && isAppointmentResultPending(appointment, now))
    || (appointmentView === "finished" && !isActiveAppointment(appointment.status))
  )), [appointmentView, appointments, now]);
  const timeGrid = useMemo<AgendaTimeGrid>(() => buildTimeGrid(days, availability.slots, visibleAppointments, timezone), [availability.slots, days, timezone, visibleAppointments]);
  const displayedDayKeys = days.map(dayKey);
  const hasAvailabilityForPeriod = availability.unitId === unit && displayedDayKeys.some((date) => availability.loadedDays.includes(date));
  const agendaLoading = (availability.status === "loading" && !hasAvailabilityForPeriod) || appointmentsLoading;
  const agendaError = availability.status === "error" ? availability.error : appointmentsError ? messageFrom(appointmentsError, "Não foi possível carregar os agendamentos.") : "";
  const agendaReady = (availability.status === "ready" || (availability.status === "loading" && hasAvailabilityForPeriod)) && Boolean(appointmentsData) && !agendaError;

  async function refreshAfterTimeBlock() {
    setTimeBlockActionError("");
    await Promise.allSettled([mutateTimeBlocks(), loadAvailability()]);
  }

  async function deleteTimeBlock(id: string) {
    if (deletingTimeBlockId) return;
    setDeletingTimeBlockId(id);
    setTimeBlockActionError("");
    try {
      await api(`/scheduling/attendants/me/time-blocks/${id}`, { method: "DELETE" });
      await refreshAfterTimeBlock();
    } catch (error) {
      setTimeBlockActionError(messageFrom(error, "Não foi possível remover o bloqueio."));
    } finally {
      setDeletingTimeBlockId("");
    }
  }

  return (
    <Shell fitViewport>
      <AgendaHeader canCreate={permissions.canCreate} canBlock={canBlockTime} unit={unit} mode={mode} view={appointmentView} pendingCount={pendingAppointmentsCount} onCreate={actions.beginManualCreate} onBlock={() => setTimeBlockOpen(true)} onMode={data.setMode} onView={setAppointmentView} />
      <AgendaTimeBlockDialog open={timeBlockOpen} anchor={anchor} timezone={timezone} onClose={() => setTimeBlockOpen(false)} onSaved={refreshAfterTimeBlock} />
      <AgendaSlotDialog open={Boolean(slotChoice)} slot={slotChoice} onClose={() => setSlotChoice(null)} onAddLead={() => { if (slotChoice) actions.beginCreate(slotChoice); setSlotChoice(null); }} onBlock={() => { setTimeBlockOpen(true); setSlotChoice(null); }} />
      {unitsStatus === "loading" ? <AgendaLoading label="Carregando unidades e agenda" /> : null}
      {unitsStatus === "error" ? <AgendaError message={unitsError} onRetry={loadUnits} /> : null}
      {unitsStatus === "ready" && units.length === 0 ? <Empty>Cadastre uma unidade para montar a agenda.</Empty> : null}
      {unitsStatus === "ready" && unit ? (
        <>
          <nav className="agenda-toolbar" aria-label="Navegação da agenda">
            <div className="agenda-toolbar__period-nav">
              <button type="button" className="agenda-toolbar__nav" onClick={() => navigate(-1)} aria-label="Período anterior"><ArrowLeft aria-hidden="true" /></button>
              <button type="button" className="agenda-toolbar__nav" onClick={() => navigate(1)} aria-label="Próximo período"><ArrowRight aria-hidden="true" /></button>
            </div>
            <button type="button" className="agenda-toolbar__today" onClick={goToday}>Hoje</button>
            <strong className="agenda-period">{mode === "month" ? days[0].toLocaleDateString("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" }) : mode === "day" ? days[0].toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "long" }) : `${days[0].toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "short" })} — ${days[6].toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "short" })}`}</strong>
            <div className="agenda-legend" aria-label="Tipos de evento">
              <span><i className="agenda-legend__swatch agenda-legend__swatch--meet" />Reunião</span>
              <span><i className="agenda-legend__swatch agenda-legend__swatch--demo" />Demo</span>
              <span><i className="agenda-legend__swatch agenda-legend__swatch--follow" />Follow-up</span>
              <span><i className="agenda-legend__swatch agenda-legend__swatch--block" />Bloqueio</span>
            </div>
          </nav>
          {!actions.createTarget && actions.actionError ? <p className="error mb-4" role="alert">{actions.actionError}</p> : null}
          {actions.notice ? <p className="accent mb-4 text-sm" role="status" aria-live="polite">{actions.notice}</p> : null}
          {timeBlockActionError || timeBlocksError ? <p className="error mb-4" role="alert">{timeBlockActionError || messageFrom(timeBlocksError, "Não foi possível carregar seus bloqueios.")}</p> : null}
          <AgendaTimeBlockList blocks={timeBlocks} timezone={timezone} deletingId={deletingTimeBlockId} onDelete={deleteTimeBlock} />
          {availability.status === "loading" && hasAvailabilityForPeriod ? <p className="sub mb-4" role="status" aria-live="polite">Atualizando a disponibilidade sem ocultar os últimos dados válidos.</p> : null}
          {availability.status === "ready" && availability.failedDays.length > 0 ? <AvailabilityWarning failedDays={availability.failedDays} retrying={actions.retrying} onRetry={actions.refreshAgenda} /> : null}
          {agendaLoading ? <AgendaLoading label="Carregando disponibilidade e agendamentos" /> : null}
          {!agendaLoading && agendaError ? <AgendaError message={agendaError} onRetry={actions.refreshAgenda} retrying={actions.retrying} /> : null}
          {agendaReady ? (
            <>
              {pendingAppointmentsCount > 0 ? <PendingWarning count={pendingAppointmentsCount} onShow={() => setAppointmentView("pending")} /> : null}
              {mode === "month" ? <AgendaMonth days={days} appointments={visibleAppointments} today={today} onSelect={(date) => { data.setMode("day"); data.setAnchor(date); }} /> : <div className={`agenda-scroll ${mode === "day" ? "agenda-scroll--day" : ""}`}>
                <AgendaCalendar days={days} today={today} timezone={timezone} failedDays={availability.failedDays} timeGrid={timeGrid} now={now} dragging={actions.dragging} reschedulingId={actions.reschedulingId} pendingActionId={actions.pendingActionId} canReschedule={permissions.canReschedule} canCreate={permissions.canCreate} onDrag={actions.setDragging} onDrop={actions.drop} onCreate={actions.beginCreate} onOpen={actions.openAppointment} onSelectSlot={setSlotChoice} />
              </div>}
              <AgendaDetailDialog actions={actions} timezone={timezone} now={now} />
              <AgendaCreateDialog actions={actions} timezone={timezone} />
            </>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}

function buildTimeGrid(days: Date[], slots: Record<string, Slot[]>, appointments: Appointment[], timezone: string): AgendaTimeGrid {
  const byDay = new Map<string, Map<string, Slot>>();
  const appointmentsByDay = new Map<string, Map<string, Appointment[]>>();
  const labels = new Set<string>();
  days.forEach((day) => {
    const perDay = new Map<string, Slot>();
    (slots[dayKey(day)] ?? []).forEach((slot) => {
      const label = new Date(slot.start).toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
      perDay.set(label, slot);
      labels.add(label);
    });
    byDay.set(dayKey(day), perDay);
  });
  appointments.forEach((appointment) => {
    const date = new Date(appointment.start);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    const label = date.toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
    const perDay = appointmentsByDay.get(key) ?? new Map<string, Appointment[]>();
    perDay.set(label, [...(perDay.get(label) ?? []), appointment]);
    appointmentsByDay.set(key, perDay);
    labels.add(label);
  });
  return { byDay, appointmentsByDay, labels: [...labels].sort() };
}

function AvailabilityWarning({ failedDays, retrying, onRetry }: { failedDays: string[]; retrying: boolean; onRetry: () => Promise<void> }) {
  return (
    <section className="mb-5 flex flex-wrap items-center justify-between gap-4 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="status" aria-live="polite">
      <div className="flex min-w-0 flex-1 items-start gap-3"><WarningCircle className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={20} aria-hidden="true" /><div><strong className="block text-sm text-[var(--warning-text)]">Disponibilidade atualizada parcialmente</strong><p className="mt-1 text-sm text-[var(--warning-text)]">Falha em {failedDays.map((date) => new Date(`${date}T00:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" })).join(", ")}. Os demais dias continuam válidos; onde havia dados anteriores, eles foram preservados e sinalizados.</p></div></div>
      <button type="button" className="btn warn" disabled={retrying} onClick={() => void onRetry()}>{retrying ? "Tentando novamente…" : "Tentar dias com falha novamente"}</button>
    </section>
  );
}

function PendingWarning({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-3" aria-live="polite">
      <div className="flex items-start gap-3"><WarningCircle className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={19} aria-hidden="true" /><div><strong className="block text-sm text-[var(--warning-text)]">{count} {count === 1 ? "reunião aguarda" : "reuniões aguardam"} resultado</strong><p className="mt-0.5 text-xs text-[var(--warning-text)]">Registre o desfecho para manter o acompanhamento comercial atualizado.</p></div></div>
      <button type="button" className="btn warn" onClick={onShow}>Ver resultados pendentes</button>
    </section>
  );
}

export default function AgendaPage() {
  return <Suspense fallback={<Shell><AgendaLoading label="Carregando agenda" /></Shell>}><AgendaContent /></Suspense>;
}

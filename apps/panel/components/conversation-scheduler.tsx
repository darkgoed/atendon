"use client";

import { Button, Input, Select } from "@/components/ui";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDots,
  CheckCircle,
  Clock,
  MapPin,
  UsersThree,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import {
  availableConversationSlots,
  formatConversationSlot,
  futureConversationSlots,
  isoDay,
  shiftIsoDay,
  type ConversationSchedulingSlot
} from "@/lib/conversation-scheduling";
import { localDay } from "@/lib/timezone";

type Unit = { id: string; nome: string };
type SchedulingContext = {
  contact: { id: string; nome: string | null; telefone: string };
  lead: {
    id: string;
    nome: string | null;
    telefone: string;
    status: string;
    unidade_id: string;
  } | null;
  agendamento_ativo: {
    id: string;
    unidade_id: string;
    start: string;
    end: string;
    status: "confirmado" | "reagendado";
    assigned_member_id: string | null;
    assigned_user_id: string | null;
    assigned_name: string | null;
    assigned_email: string | null;
  } | null;
  can_select_assignee: boolean;
  timezone: string;
};
type AvailabilityResponse = {
  data: string;
  timezone: string;
  horarios: ConversationSchedulingSlot[];
};
type CreatedAppointment = {
  id: string;
  start: string;
  end: string;
  status: string;
};
type AppointmentAssignee = {
  member_id: string;
  user_id: string;
  name: string | null;
  email: string;
  online: boolean;
  availability_status: "available" | "unavailable";
  future_meetings_count: number;
  conflicts: Array<{ id: string; start: string; end: string; lead_name: string | null }>;
  selectable: boolean;
  suggested: boolean;
};
type AppointmentAssigneesResponse = {
  assignees: AppointmentAssignee[];
  can_select_assignee: boolean;
  suggested_member_id: string | null;
};

const fetcher = <T,>(url: string) => api<T>(url);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ConversationScheduler({
  conversationId,
  contactName,
  contactPhone,
  onClose
}: {
  conversationId: string;
  contactName?: string;
  contactPhone: string;
  onClose: () => void;
}) {
  const utcToday = isoDay(new Date());
  const [unitId, setUnitId] = useState("");
  const [date, setDate] = useState(utcToday);
  const [dateTouched, setDateTouched] = useState(false);
  const [selectedStart, setSelectedStart] = useState("");
  const [creating, setCreating] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [assignedMemberId, setAssignedMemberId] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [created, setCreated] = useState<CreatedAppointment | null>(null);
  const [idempotencyKey] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${conversationId}`);

  const {
    data: context,
    error: contextError,
    isLoading: contextLoading,
    mutate: retryContext
  } = useSWR<SchedulingContext>(
    `/scheduling/conversations/${conversationId}/appointment-context`,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const {
    data: unitsData,
    error: unitsError,
    isLoading: unitsLoading,
    mutate: retryUnits
  } = useSWR<{ unidades: Unit[] }>(
    "/scheduling/config/unidades",
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const units = useMemo(() => unitsData?.unidades ?? [], [unitsData?.unidades]);

  useEffect(() => {
    if (!units.length) {
      setUnitId("");
      return;
    }
    setUnitId((current) => {
      if (units.some((unit) => unit.id === current)) return current;
      const preferred = context?.lead?.unidade_id;
      return units.some((unit) => unit.id === preferred) ? preferred! : units[0].id;
    });
  }, [context?.lead?.unidade_id, units]);

  const availabilityKey = context?.lead && !context.agendamento_ativo && unitId
    ? `/scheduling/availability?unidade_id=${encodeURIComponent(unitId)}&data=${date}${context.can_select_assignee && assignedMemberId ? `&assigned_member_id=${encodeURIComponent(assignedMemberId)}` : ""}`
    : null;
  const {
    data: availability,
    error: availabilityError,
    isLoading: availabilityLoading,
    mutate: retryAvailability
  } = useSWR<AvailabilityResponse>(
    availabilityKey,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const timezone = availability?.timezone ?? context?.timezone ?? "UTC";
  const today = localDay(new Date(), context?.timezone ?? timezone);
  useEffect(() => {
    if (!context?.timezone || dateTouched) return;
    setDate(localDay(new Date(), context.timezone));
  }, [context?.timezone, dateTouched]);
  const futureSlots = useMemo(
    () => futureConversationSlots(availability?.horarios ?? []),
    [availability?.horarios]
  );
  const slots = useMemo(
    () => context?.can_select_assignee && !assignedMemberId
      ? futureSlots
      : availableConversationSlots(availability?.horarios ?? []),
    [assignedMemberId, availability?.horarios, context?.can_select_assignee, futureSlots]
  );

  useEffect(() => {
    setSelectedStart((current) => slots.some((slot) => slot.start === current) ? current : (slots[0]?.start ?? ""));
  }, [slots]);

  const selectedSlot = slots.find((slot) => slot.start === selectedStart);
  const assigneeReferenceSlot = selectedSlot ?? futureSlots[0];
  const assigneeInterval = context?.agendamento_ativo
    ? { start: context.agendamento_ativo.start, end: context.agendamento_ativo.end, excludeId: context.agendamento_ativo.id }
    : assigneeReferenceSlot ? { start: assigneeReferenceSlot.start, end: assigneeReferenceSlot.end, excludeId: undefined } : null;
  const assigneeKey = assigneeInterval
    ? `/scheduling/appointment-assignees?start=${encodeURIComponent(assigneeInterval.start)}&end=${encodeURIComponent(assigneeInterval.end)}${assigneeInterval.excludeId ? `&exclude_appointment_id=${encodeURIComponent(assigneeInterval.excludeId)}` : ""}`
    : null;
  const {
    data: assigneeData,
    error: assigneeError,
    isLoading: assigneesLoading,
    mutate: retryAssignees
  } = useSWR<AppointmentAssigneesResponse>(
    assigneeKey,
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 15_000, shouldRetryOnError: false }
  );
  useEffect(() => {
    if (!assigneeData) return;
    setAssignedMemberId((current) => {
      const currentAssignee = assigneeData.assignees.find((assignee) => assignee.member_id === current);
      if (currentAssignee && (context?.agendamento_ativo ? currentAssignee.selectable : currentAssignee.availability_status === "available")) return current;
      if (context?.agendamento_ativo?.assigned_member_id) return context.agendamento_ativo.assigned_member_id;
      return assigneeData.suggested_member_id ?? "";
    });
  }, [assigneeData, context?.agendamento_ativo]);
  const selectableAssignees = assigneeData?.assignees.filter((assignee) => (
    context?.agendamento_ativo ? assignee.selectable : assignee.availability_status === "available"
  )) ?? [];
  const noSelectableAssignee = Boolean(assigneeData && selectableAssignees.length === 0);
  const selectedUnit = units.find((unit) => unit.id === unitId);
  const loading = contextLoading || unitsLoading;
  const loadError = contextError ?? unitsError;

  async function createAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context?.lead || !selectedStart || !unitId || creating || availabilityLoading) return;
    setCreating(true);
    setSubmitError("");
    try {
      const response = await api<{ agendamento: CreatedAppointment }>("/scheduling/appointments", {
        method: "POST",
        body: JSON.stringify({
          lead_id: context.lead.id,
          unidade_id: unitId,
          start: selectedStart,
          idempotency_key: idempotencyKey,
          ...(context.can_select_assignee ? { assigned_member_id: assignedMemberId || null } : {})
        })
      });
      setCreated(response.agendamento);
    } catch (error) {
      setSubmitError(errorMessage(error, "Não foi possível criar o agendamento."));
      await retryAvailability();
    } finally {
      setCreating(false);
    }
  }

  async function reassignAppointment() {
    if (!context?.agendamento_ativo || !context.can_select_assignee || reassigning) return;
    setReassigning(true);
    setSubmitError("");
    try {
      await api(`/scheduling/appointments/${context.agendamento_ativo.id}/assignee`, {
        method: "PATCH",
        body: JSON.stringify({ assigned_member_id: assignedMemberId || null })
      });
      await Promise.all([retryContext(), retryAssignees()]);
    } catch (error) {
      setSubmitError(errorMessage(error, "Não foi possível reatribuir a reunião."));
    } finally {
      setReassigning(false);
    }
  }

  function AssigneePicker() {
    if (!assigneeInterval) return null;
    return (
      <section className="border-y border-[var(--border)] py-5" aria-labelledby="appointment-assignee-title">
        <div className="mb-3 flex items-start gap-3">
          <UsersThree className="mt-0.5 text-[var(--accent-soft)]" size={19} aria-hidden="true" />
          <div>
            <strong id="appointment-assignee-title" className="block text-sm">Closer responsável</strong>
            <p className="sub mt-1 text-xs">
              {context?.agendamento_ativo
                ? "Online é informativo. Indisponibilidade manual ou conflito impedem a seleção."
                : "Escolha o closer para ver abaixo somente os horários livres dele."}
            </p>
          </div>
        </div>
        {assigneesLoading ? <div className="skeleton h-20" aria-label="Carregando closers" /> : assigneeError ? (
          <div className="flex items-center justify-between gap-3 text-sm text-[var(--warn)]" role="alert">
            <span>{errorMessage(assigneeError, "Não foi possível carregar os closers.")}</span>
            <Button type="button" className="btn warn" onClick={() => void retryAssignees()}>Tentar novamente</Button>
          </div>
        ) : (
          <>
            {context?.can_select_assignee ? (
              <Select
                className="input w-full"
                value={assignedMemberId}
                disabled={creating || reassigning}
                onChange={(event) => {
                  setAssignedMemberId(event.target.value);
                  if (!context?.agendamento_ativo) setSelectedStart("");
                  setSubmitError("");
                }}
                aria-label="Closer responsável pela reunião"
              >
                {noSelectableAssignee ? <option value="">Sem closer disponível</option> : null}
                {(assigneeData?.assignees ?? []).map((assignee) => {
                  const disabled = context?.agendamento_ativo
                    ? !assignee.selectable
                    : assignee.availability_status !== "available";
                  return (
                    <option key={assignee.member_id} value={assignee.member_id} disabled={disabled}>
                      {assignee.name?.trim() || assignee.email}{assignee.suggested ? " · sugerido" : ""}{disabled ? " · indisponível" : assignee.conflicts.length ? " · outro horário será exibido" : ""}
                    </option>
                  );
                })}
              </Select>
            ) : (
              <p className="text-sm text-[var(--body)]">
                {context?.agendamento_ativo?.assigned_name || context?.agendamento_ativo?.assigned_email || "Definido automaticamente ao confirmar"}
              </p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(assigneeData?.assignees ?? []).map((assignee) => (
                <div key={assignee.member_id} className={`border px-3 py-2 text-xs ${assignee.selectable ? "border-[var(--border)]" : "border-[var(--warn-border)]"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate">{assignee.name?.trim() || assignee.email}</strong>
                    <span className={assignee.online ? "text-[var(--ok)]" : "text-[var(--faint)]"}>{assignee.online ? "online" : "offline"}</span>
                  </div>
                  <p className="mt-1 text-[var(--muted)]">
                    {assignee.availability_status === "available" ? "Disponível" : "Indisponível"} · {assignee.future_meetings_count} futura(s)
                    {assignee.conflicts.length ? ` · ${assignee.conflicts.length} conflito(s)` : " · sem conflito"}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }

  function moveDate(amount: number) {
    const next = shiftIsoDay(date, amount);
    if (next < today) return;
    setDate(next);
    setSubmitError("");
  }

  return (
    <ModalDialog
      className="conversation-scheduler-dialog"
      labelledBy="conversation-scheduler-title"
      describedBy="conversation-scheduler-description"
      onClose={creating ? () => undefined : onClose}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="label">Agenda da conversa</span>
          <h2 id="conversation-scheduler-title" className="mt-1 truncate">Agendar contato</h2>
          <p id="conversation-scheduler-description" className="mt-1 text-sm text-[var(--muted)]">
            {contactName ?? contactPhone} <span className="mono text-xs text-[var(--faint)]">· {contactPhone}</span>
          </p>
        </div>
        <Button type="button" className="btn shrink-0 p-2" aria-label="Fechar agenda" disabled={creating} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>

      {loading ? (
        <div className="grid gap-3 py-2" aria-busy="true" aria-label="Carregando agenda do contato">
          <div className="skeleton h-16" aria-hidden="true" />
          <div className="grid grid-cols-2 gap-3">
            <div className="skeleton h-16" aria-hidden="true" />
            <div className="skeleton h-16" aria-hidden="true" />
          </div>
          <div className="skeleton h-28" aria-hidden="true" />
        </div>
      ) : loadError ? (
        <section className="grid gap-4 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 text-[var(--warn)]" role="alert">
          <div className="flex items-start gap-3">
            <WarningCircle className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
            <div>
              <strong className="block text-sm">Não foi possível abrir a agenda</strong>
              <p className="mt-1 text-sm text-[var(--warn-muted)]">{errorMessage(loadError, "Tente novamente.")}</p>
            </div>
          </div>
          <Button type="button" className="btn warn justify-self-start" onClick={() => void Promise.all([retryContext(), retryUnits()])}>
            Tentar novamente
          </Button>
        </section>
      ) : created ? (
        <section className="grid gap-5 py-2" role="status" aria-live="polite">
          <div className="flex items-start gap-3 border-y border-[var(--ok-border)] bg-[var(--ok-bg)] px-4 py-5 text-[var(--ok)]">
            <CheckCircle className="mt-0.5 shrink-0" size={23} weight="fill" aria-hidden="true" />
            <div>
              <strong className="block text-sm">Contato agendado</strong>
              <p className="mt-1 text-sm leading-relaxed">
                {formatConversationSlot(created.start, timezone, { includeDate: true })}
                {selectedUnit ? ` · ${selectedUnit.nome}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Link className="btn" href="/agenda">Abrir agenda completa</Link>
            <Button type="button" className="btn primary" onClick={onClose}>Concluir</Button>
          </div>
        </section>
      ) : !context?.lead ? (
        <section className="grid gap-4 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5" role="status">
          <div className="flex items-start gap-3">
            <WarningCircle className="mt-0.5 shrink-0 text-[var(--warn)]" size={20} aria-hidden="true" />
            <div>
              <strong className="block text-sm text-[var(--warn)]">Contato ainda não está disponível para agendamento</strong>
              <p className="mt-1 text-sm leading-relaxed text-[var(--warn-muted)]">
                Conclua o cadastro do lead com categoria e unidade. Depois, volte a esta conversa para escolher o horário.
              </p>
            </div>
          </div>
          <Link className="btn warn justify-self-start" href="/leads">Abrir leads</Link>
        </section>
      ) : context.agendamento_ativo ? (
        <section className="grid gap-5 py-2">
          <div className="flex items-start gap-3 border-y border-[var(--border-ai)] bg-[var(--accent-bg)] px-4 py-5 text-[var(--accent-soft)]">
            <CalendarDots className="mt-0.5 shrink-0" size={22} aria-hidden="true" />
            <div>
              <strong className="block text-sm">Este contato já possui agendamento ativo</strong>
              <p className="mt-1 text-sm leading-relaxed">
                {formatConversationSlot(context.agendamento_ativo.start, context.timezone, { includeDate: true })}
              </p>
            </div>
          </div>
          <AssigneePicker />
          {submitError ? <p className="error" role="alert">{submitError}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Link className="btn" href="/agenda">Ver agenda</Link>
            {context.can_select_assignee ? (
              <Button type="button" className="btn primary" disabled={reassigning || assigneesLoading || (!assignedMemberId && !noSelectableAssignee)} onClick={() => void reassignAppointment()}>
                {reassigning ? "Salvando…" : "Salvar responsável"}
              </Button>
            ) : null}
          </div>
        </section>
      ) : units.length === 0 ? (
        <section className="border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 text-sm text-[var(--warn)]" role="status">
          Cadastre ao menos uma unidade antes de criar um agendamento.
        </section>
      ) : (
        <form className="grid gap-5" onSubmit={createAppointment}>
          <div className="grid gap-4 border-y border-[var(--border)] py-5 sm:grid-cols-2">
            <label className="field">
              <span className="label">Unidade</span>
              <span className="relative">
                <MapPin className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]" size={16} aria-hidden="true" />
                <Select
                  data-autofocus
                  className="input w-full pl-9"
                  value={unitId}
                  disabled={creating}
                  onChange={(event) => {
                    setUnitId(event.target.value);
                    setSubmitError("");
                  }}
                  required
                >
                  {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.nome}</option>)}
                </Select>
              </span>
            </label>
            <label className="field">
              <span className="label">Data</span>
              <Input
                className="input"
                type="date"
                min={today}
                value={date}
                disabled={creating}
                onChange={(event) => {
                  setDate(event.target.value);
                  setDateTouched(true);
                  setSubmitError("");
                }}
                required
              />
            </label>
          </div>

          <AssigneePicker />

          <section aria-labelledby="conversation-scheduler-slots">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <span className="label">Horários livres</span>
                <strong id="conversation-scheduler-slots" className="mt-1 block text-sm capitalize">
                  {new Date(`${date}T12:00:00.000Z`).toLocaleDateString("pt-BR", {
                    timeZone: "UTC",
                    weekday: "long",
                    day: "2-digit",
                    month: "long"
                  })}
                </strong>
              </div>
              <div className="flex gap-2">
                <Button type="button" className="btn p-2" disabled={date <= today || creating} onClick={() => moveDate(-1)} aria-label="Dia anterior">
                  <ArrowLeft size={16} aria-hidden="true" />
                </Button>
                <Button type="button" className="btn p-2" disabled={creating} onClick={() => moveDate(1)} aria-label="Próximo dia">
                  <ArrowRight size={16} aria-hidden="true" />
                </Button>
              </div>
            </div>

            {availabilityLoading ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-busy="true" aria-label="Carregando horários">
                {Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton h-11" aria-hidden="true" />)}
              </div>
            ) : availabilityError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-4 text-sm text-[var(--warn)]" role="alert">
                <span>{errorMessage(availabilityError, "Não foi possível carregar os horários.")}</span>
                <Button type="button" className="btn warn" onClick={() => void retryAvailability()}>Tentar novamente</Button>
              </div>
            ) : slots.length === 0 ? (
              <div className="grid justify-items-start gap-2 border-y border-[var(--border)] py-5 text-[var(--muted)]" role="status">
                <strong className="text-sm text-[var(--body)]">Nenhum horário livre nesta data</strong>
                <p className="text-sm">Avance para o próximo dia ou escolha outra unidade.</p>
                <Button type="button" className="btn mt-1" onClick={() => moveDate(1)}>Ver o próximo dia</Button>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {slots.map((slot) => {
                  const selected = slot.start === selectedStart;
                  return (
                    <Button
                      type="button"
                      key={slot.start}
                      aria-pressed={selected}
                      className={[
                        "flex min-h-11 items-center justify-center gap-1.5 border px-3 py-2 text-sm font-semibold transition active:translate-y-px",
                        selected
                          ? "border-[var(--border-ai)] bg-[var(--accent-bg)] text-[var(--accent-soft)]"
                          : "border-[var(--border)] text-[var(--body)] hover:border-[var(--strong)]"
                      ].join(" ")}
                      disabled={creating}
                      onClick={() => {
                        setSelectedStart(slot.start);
                        setSubmitError("");
                      }}
                    >
                      <Clock size={14} aria-hidden="true" />
                      {formatConversationSlot(slot.start, timezone)}
                    </Button>
                  );
                })}
              </div>
            )}
          </section>

          {selectedSlot ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4 text-sm">
              <div>
                <span className="label">Confirmação</span>
                <p className="mt-1 text-[var(--body)]">
                  {formatConversationSlot(selectedSlot.start, timezone, { includeDate: true })}
                  {selectedUnit ? ` · ${selectedUnit.nome}` : ""}
                </p>
              </div>
              <span className="mono text-xs text-[var(--faint)]">{timezone}</span>
            </div>
          ) : null}

          {submitError ? <p className="error" role="alert">{submitError}</p> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" className="btn" disabled={creating} onClick={onClose}>Cancelar</Button>
            <Button type="submit" className="btn primary" disabled={!selectedStart || creating || availabilityLoading || Boolean(availabilityError) || assigneesLoading || (context.can_select_assignee && !assignedMemberId && !noSelectableAssignee)}>
              <CalendarDots size={16} aria-hidden="true" />
              {creating ? "Agendando…" : "Confirmar agendamento"}
            </Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}

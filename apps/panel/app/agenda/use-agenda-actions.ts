"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { isValidBrazilianPhone } from "@/lib/phone";
import { defaultManualAppointmentStart, instantFromLocalMinute, localMinute } from "@/lib/timezone";
import type { AppointmentCancellationPayload, AppointmentOutcomePayload } from "./appointment-action-contracts";
import type { AgendaPermissions, Appointment, AppointmentLead, FinalAction, Slot } from "./agenda-types";
import { DEFAULT_APPOINTMENT_DURATION_MS, FINAL_ACTION_SUCCESS, formatSlot, messageFrom } from "./agenda-utils";
import { useAgendaAssignees } from "./use-agenda-assignees";

export function useAgendaActions({ permissions, unit, anchor, timezone, appointments, periodKey, loadAvailability, mutateAppointments }: {
  permissions: AgendaPermissions;
  unit: string;
  anchor: string;
  timezone: string;
  appointments: Appointment[];
  periodKey: string;
  loadAvailability: () => Promise<void>;
  mutateAppointments: () => Promise<unknown>;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState("");
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  const [selectedStart, setSelectedStart] = useState("");
  const [selectedEnd, setSelectedEnd] = useState("");
  const [reschedulingId, setReschedulingId] = useState("");
  const [createLeadId, setCreateLeadId] = useState("");
  const [createLead, setCreateLead] = useState<AppointmentLead | null>(null);
  const [createTarget, setCreateTarget] = useState<Slot | null>(null);
  const [createMode, setCreateMode] = useState<"existing" | "new">("existing");
  const [createAssignedMemberId, setCreateAssignedMemberId] = useState("");
  const [newLead, setNewLead] = useState({ nome: "", telefone: "", campanha: "" });
  const [creating, setCreating] = useState(false);
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);
  const [detailAssignedMemberId, setDetailAssignedMemberId] = useState("");
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [appointmentObservation, setAppointmentObservation] = useState("");
  const [savingObservation, setSavingObservation] = useState(false);
  const [openingConversationId, setOpeningConversationId] = useState("");
  const [joiningAppointmentId, setJoiningAppointmentId] = useState("");
  const [joinBlockedIds, setJoinBlockedIds] = useState<Set<string>>(() => new Set());
  const [joinReadyUrl, setJoinReadyUrl] = useState("");
  const [finalAction, setFinalAction] = useState<{ appointment: Appointment; action: FinalAction } | null>(null);
  const [pendingActionId, setPendingActionId] = useState("");
  const [confirmDeleteLead, setConfirmDeleteLead] = useState(false);
  const [deletingLead, setDeletingLead] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [retrying, setRetrying] = useState(false);
  const appointmentAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const createStartInstant = createTarget ? instantFromLocalMinute(selectedStart, timezone) : "";
  const createEndInstant = createStartInstant
    ? new Date(new Date(createStartInstant).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString()
    : "";
  const assignees = useAgendaAssignees({ createStart: createStartInstant, createEnd: createEndInstant, selectedAppointment, canReschedule: permissions.canReschedule });

  useEffect(() => {
    if (!assignees.createAssigneesData) return;
    setCreateAssignedMemberId((current) => {
      if (assignees.createAssigneesData?.assignees.some((candidate) => candidate.member_id === current && candidate.selectable)) return current;
      return assignees.createAssigneesData?.suggested_member_id ?? "";
    });
  }, [assignees.createAssigneesData]);

  useEffect(() => {
    setDetailAssignedMemberId(selectedAppointment?.responsavel?.member_id ?? "");
  }, [selectedAppointment?.id, selectedAppointment?.responsavel?.member_id]);

  useEffect(() => {
    setRescheduleTarget(null);
    setFinalAction(null);
    setCreateTarget(null);
    setSelectedStart("");
    setJoinBlockedIds(new Set());
    setActionError("");
    setNotice("");
  }, [periodKey]);

  async function refreshAgenda() {
    setRetrying(true);
    setActionError("");
    await Promise.allSettled([loadAvailability(), mutateAppointments()]);
    setJoinBlockedIds(new Set());
    setRetrying(false);
  }

  async function reschedule(appointmentId: string, start: string, end: string) {
    if (!permissions.canReschedule || !unit || !start || reschedulingId) return false;
    setReschedulingId(appointmentId);
    setActionError("");
    setNotice("");
    try {
      await api(`/scheduling/appointments/${appointmentId}/reagendar`, {
        method: "PATCH",
        body: JSON.stringify({ start, end, unidade_id: unit })
      });
      setNotice(`Agendamento transferido para ${formatSlot({ start, end: start, vagas: 1, capacidade: 1 }, timezone)}.`);
      setRescheduleTarget(null);
      setSelectedAppointment((current) => current?.id === appointmentId ? null : current);
      setSelectedStart("");
      await Promise.allSettled([mutateAppointments(), loadAvailability()]);
      return true;
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível reagendar."));
      return false;
    } finally {
      setReschedulingId("");
    }
  }

  async function drop(start: string) {
    const appointmentId = dragging;
    setDragging("");
    const appointment = appointments.find((item) => item.id === appointmentId);
    const duration = appointment ? new Date(appointment.end).getTime() - new Date(appointment.start).getTime() : DEFAULT_APPOINTMENT_DURATION_MS;
    if (appointmentId) await reschedule(appointmentId, start, new Date(new Date(start).getTime() + duration).toISOString());
  }

  function beginReschedule(appointment: Appointment) {
    setActionError("");
    setNotice("");
    setFinalAction(null);
    setRescheduleTarget(appointment);
    setSelectedStart(localMinute(appointment.start, timezone));
    setSelectedEnd(localMinute(appointment.end, timezone));
  }

  function beginCreate(slot: Slot) {
    setActionError("");
    setNotice("");
    setFinalAction(null);
    setRescheduleTarget(null);
    setCreateTarget(slot);
    setCreateMode("existing");
    setCreateLead(null);
    setCreateLeadId("");
    setCreateAssignedMemberId("");
    setSelectedStart(localMinute(slot.start, timezone));
  }

  function beginManualCreate() {
    const start = defaultManualAppointmentStart(anchor, timezone);
    beginCreate({ start, end: new Date(new Date(start).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString(), vagas: 1, capacidade: 1 });
  }

  function closeCreate() {
    if (creating) return;
    setCreateTarget(null);
    setActionError("");
    setCreateLead(null);
    setCreateLeadId("");
    setNewLead({ nome: "", telefone: "", campanha: "" });
    setCreateAssignedMemberId("");
  }

  async function submitReschedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = instantFromLocalMinute(selectedStart, timezone);
    const end = instantFromLocalMinute(selectedEnd, timezone);
    if (!start || !end || new Date(end).getTime() <= new Date(start).getTime()) {
      setActionError("Informe um término posterior ao início.");
      return;
    }
    if (rescheduleTarget && selectedStart) await reschedule(rescheduleTarget.id, start, end);
  }

  async function createAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permissions.canCreate || !unit || !createTarget || creating) return;
    if (assignees.createAssigneesLoading || assignees.createAssigneesError) return;
    if (assignees.createAssigneesData?.can_select_assignee && !createAssignedMemberId && !assignees.noCreateSelectableAssignee) return;
    if (createMode === "existing" && !createLeadId) return;
    if (createMode === "new" && (!permissions.canCreateLeads || !newLead.nome.trim() || !isValidBrazilianPhone(newLead.telefone))) return;
    const createStart = instantFromLocalMinute(selectedStart, timezone);
    if (!createStart) {
      setActionError("Informe o início do agendamento.");
      return;
    }
    const createEnd = new Date(new Date(createStart).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString();
    setCreating(true);
    setActionError("");
    setNotice("");
    try {
      let leadId = createLeadId;
      if (createMode === "new") {
        const response = await api<{ lead: AppointmentLead }>("/scheduling/leads", {
          method: "POST",
          body: JSON.stringify({ nome: newLead.nome.trim(), telefone: newLead.telefone.trim(), origem: "agenda_manual", campanha: newLead.campanha.trim() || undefined, unidade_id: unit })
        });
        leadId = response.lead.id;
      }
      const canSelectAssignee = assignees.createAssigneesData?.can_select_assignee === true;
      const fingerprint = JSON.stringify({ leadId, unit, start: createStart, end: createEnd, assignedMemberId: canSelectAssignee ? createAssignedMemberId || null : undefined });
      if (appointmentAttempt.current?.fingerprint !== fingerprint) {
        appointmentAttempt.current = { fingerprint, key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${leadId}` };
      }
      await api("/scheduling/appointments", {
        method: "POST",
        body: JSON.stringify({
          lead_id: leadId,
          unidade_id: unit,
          start: createStart,
          end: createEnd,
          idempotency_key: appointmentAttempt.current.key,
          ...(canSelectAssignee ? { assigned_member_id: createAssignedMemberId || null } : {})
        })
      });
      appointmentAttempt.current = null;
      setNotice(`Agendamento criado para ${formatSlot({ start: createStart, end: createStart, vagas: 1, capacidade: 1 }, timezone)}.`);
      setCreateTarget(null);
      setCreateLead(null);
      setCreateLeadId("");
      setNewLead({ nome: "", telefone: "", campanha: "" });
      setCreateAssignedMemberId("");
      await Promise.allSettled([mutateAppointments(), loadAvailability()]);
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível criar o agendamento."));
      await Promise.allSettled([mutateAppointments(), loadAvailability()]);
    } finally {
      setCreating(false);
    }
  }

  async function runFinalAction(payload?: AppointmentOutcomePayload | AppointmentCancellationPayload) {
    if (!finalAction || pendingActionId) return;
    const { appointment, action } = finalAction;
    if ((action === "cancel" && !permissions.canCancel) || (action === "complete" && !permissions.canComplete) || (action === "no_show" && !permissions.canNoShow)) return;
    if ((action === "cancel" || action === "complete") && !payload) return;
    const base = `/scheduling/appointments/${appointment.id}`;
    setPendingActionId(appointment.id);
    setActionError("");
    setNotice("");
    try {
      const endpoint = action === "cancel" ? `${base}/cancelar` : `${base}/${action === "complete" ? "concluir" : "no-show"}`;
      await api(endpoint, { method: "PATCH", ...(payload ? { body: JSON.stringify(payload) } : {}) });
      setNotice(`${FINAL_ACTION_SUCCESS[action]} registrado com sucesso.`);
      setFinalAction(null);
      setRescheduleTarget(null);
      setSelectedAppointment(null);
      setJoinBlockedIds(new Set());
      await Promise.allSettled([mutateAppointments(), loadAvailability()]);
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível atualizar o agendamento."));
    } finally {
      setPendingActionId("");
    }
  }

  async function deleteLeadAction() {
    if (!selectedAppointment || !permissions.canDeleteLead || deletingLead) return;
    setDeletingLead(true);
    setActionError("");
    setNotice("");
    try {
      await api(`/scheduling/appointments/${selectedAppointment.id}/remove`, { method: "DELETE" });
      setNotice("Agendamento excluído com sucesso.");
      setConfirmDeleteLead(false);
      setSelectedAppointment(null);
      await Promise.allSettled([mutateAppointments(), loadAvailability()]);
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível excluir o agendamento."));
    } finally {
      setDeletingLead(false);
    }
  }

  async function openConversation(appointment: Appointment) {
    if (!permissions.canReply || openingConversationId) return;
    if (appointment.conversation_id) {
      router.push(`/conversas?id=${appointment.conversation_id}`);
      return;
    }
    setOpeningConversationId(appointment.id);
    setActionError("");
    setNotice("");
    try {
      const response = await api<{ conversation: { id: string } }>(`/scheduling/appointments/${appointment.id}/conversation`, { method: "POST" });
      setSelectedAppointment((current) => current?.id === appointment.id ? { ...current, conversation_id: response.conversation.id } : current);
      await mutateAppointments();
      router.push(`/conversas?id=${response.conversation.id}`);
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível iniciar a conversa pelo WhatsApp."));
    } finally {
      setOpeningConversationId("");
    }
  }

  async function joinAppointment(appointment: Appointment) {
    if (joiningAppointmentId || joinBlockedIds.has(appointment.id)) return;
    setJoiningAppointmentId(appointment.id);
    setJoinReadyUrl("");
    setActionError("");
    setNotice("");
    try {
      const response = await api<{ url: string }>(`/scheduling/appointments/${appointment.id}/join`, { method: "POST" });
      setJoinReadyUrl(response.url);
      const opened = window.open(response.url, "_blank", "noopener,noreferrer");
      setNotice(opened ? "Sala autorizada e aberta em uma nova aba." : "Sala autorizada. Use o botão liberado para abrir o Meet.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && /resultado da reunião anterior/i.test(error.message)) {
        setJoinBlockedIds((current) => new Set(current).add(appointment.id));
        setActionError(error.message);
      } else {
        setActionError(messageFrom(error, "Não foi possível liberar a sala desta reunião."));
      }
    } finally {
      setJoiningAppointmentId("");
    }
  }

  function beginFinalAction(appointment: Appointment, action: FinalAction) {
    setActionError("");
    setNotice("");
    setRescheduleTarget(null);
    setJoinReadyUrl("");
    setSelectedAppointment(appointment);
    setFinalAction({ appointment, action });
  }

  function openAppointment(appointment: Appointment) {
    setActionError("");
    setFinalAction(null);
    setRescheduleTarget(null);
    setConfirmDeleteLead(false);
    setJoinReadyUrl("");
    setSelectedAppointment(appointment);
    setAppointmentObservation(appointment.observacao ?? "");
  }

  function closeAppointment() {
    if (savingObservation || savingAssignee || pendingActionId || reschedulingId || openingConversationId || joiningAppointmentId || deletingLead) return;
    setSelectedAppointment(null);
    setRescheduleTarget(null);
    setFinalAction(null);
    setConfirmDeleteLead(false);
    setJoinReadyUrl("");
    setActionError("");
  }

  async function saveObservation() {
    if (!selectedAppointment || !permissions.canManageNotes || savingObservation) return;
    setSavingObservation(true);
    setActionError("");
    try {
      const response = await api<{ agendamento: { observacao?: string | null } }>(`/scheduling/appointments/${selectedAppointment.id}/observation`, {
        method: "PATCH",
        body: JSON.stringify({ observacao: appointmentObservation.trim() || null, expected_updated_at: selectedAppointment.atualizado_em })
      });
      const savedAppointment = response.agendamento as Appointment;
      setSelectedAppointment((current) => current ? { ...current, ...savedAppointment } : current);
      setAppointmentObservation(savedAppointment.observacao ?? "");
      setNotice("Observação salva.");
      await mutateAppointments();
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível salvar a observação."));
    } finally {
      setSavingObservation(false);
    }
  }

  async function saveAppointmentAssignee() {
    if (!selectedAppointment || !assignees.detailAssigneesData?.can_select_assignee || savingAssignee || detailAssignedMemberId === (selectedAppointment.responsavel?.member_id ?? "")) return;
    setSavingAssignee(true);
    setActionError("");
    try {
      const response = await api<{ agendamento: Appointment }>(`/scheduling/appointments/${selectedAppointment.id}/assignee`, {
        method: "PATCH",
        body: JSON.stringify({ assigned_member_id: detailAssignedMemberId || null })
      });
      setSelectedAppointment(response.agendamento);
      setDetailAssignedMemberId(response.agendamento.responsavel?.member_id ?? "");
      setNotice("Responsável atualizado.");
      await mutateAppointments();
    } catch (error) {
      setActionError(messageFrom(error, "Não foi possível atualizar o responsável."));
    } finally {
      setSavingAssignee(false);
    }
  }

  return {
    permissions, dragging, setDragging, rescheduleTarget, setRescheduleTarget, selectedStart, setSelectedStart,
    selectedEnd, setSelectedEnd, reschedulingId, createLeadId, createLead, setCreateLead, setCreateLeadId,
    createTarget, createMode, setCreateMode, createAssignedMemberId, setCreateAssignedMemberId, newLead, setNewLead,
    creating, selectedAppointment, setSelectedAppointment, detailAssignedMemberId, setDetailAssignedMemberId,
    savingAssignee, appointmentObservation, setAppointmentObservation, savingObservation, openingConversationId,
    joiningAppointmentId, joinBlockedIds, setJoinBlockedIds, joinReadyUrl, finalAction, setFinalAction, pendingActionId,
    confirmDeleteLead, setConfirmDeleteLead, deletingLead, actionError, setActionError, notice, retrying,
    ...assignees, refreshAgenda, drop, beginReschedule, beginCreate, beginManualCreate, closeCreate,
    submitReschedule, createAppointment, runFinalAction, deleteLeadAction, openConversation, joinAppointment,
    beginFinalAction, openAppointment, closeAppointment, saveObservation, saveAppointmentAssignee
  };
}

export type AgendaActions = ReturnType<typeof useAgendaActions>;

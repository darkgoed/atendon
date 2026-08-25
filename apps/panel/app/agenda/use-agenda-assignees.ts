"use client";

import useSWR from "swr";
import { api } from "@/lib/api";
import type { Appointment, AppointmentAssigneesResponse } from "./agenda-types";
import { isActiveAppointment } from "./agenda-utils";

const appointmentAssigneesFetcher = (url: string) => api<AppointmentAssigneesResponse>(url);

export function useAgendaAssignees({ createStart, createEnd, selectedAppointment, canReschedule }: {
  createStart: string;
  createEnd: string;
  selectedAppointment: Appointment | null;
  canReschedule: boolean;
}) {
  const createKey = createStart && createEnd
    ? `/scheduling/appointment-assignees?start=${encodeURIComponent(createStart)}&end=${encodeURIComponent(createEnd)}`
    : null;
  const create = useSWR<AppointmentAssigneesResponse>(createKey, appointmentAssigneesFetcher, {
    revalidateOnFocus: true,
    refreshInterval: 15_000,
    shouldRetryOnError: false
  });

  const detailKey = selectedAppointment && isActiveAppointment(selectedAppointment.status) && canReschedule
    ? `/scheduling/appointment-assignees?start=${encodeURIComponent(selectedAppointment.start)}&end=${encodeURIComponent(selectedAppointment.end)}&exclude_appointment_id=${encodeURIComponent(selectedAppointment.id)}`
    : null;
  const detail = useSWR<AppointmentAssigneesResponse>(detailKey, appointmentAssigneesFetcher, {
    revalidateOnFocus: true,
    refreshInterval: 15_000,
    shouldRetryOnError: false
  });

  const createSelectable = create.data?.assignees.filter((assignee) => assignee.selectable) ?? [];
  return {
    createAssigneesData: create.data,
    createAssigneesError: create.error,
    createAssigneesLoading: create.isLoading,
    retryCreateAssignees: create.mutate,
    noCreateSelectableAssignee: Boolean(create.data && createSelectable.length === 0),
    detailAssigneesData: detail.data,
    detailAssigneesError: detail.error,
    detailAssigneesLoading: detail.isLoading
  };
}

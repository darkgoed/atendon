"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { instantFromLocalMinute, localDay } from "@/lib/timezone";
import type { AppointmentsResponse, AttendantTimeBlocksResponse, AvailabilityResponse, AvailabilityState, Unit } from "./agenda-types";
import { addDays, dayKey, messageFrom } from "./agenda-utils";

const appointmentsFetcher = (url: string) => api<AppointmentsResponse>(url);

export function useAgendaData({ requestedUnit, requestedDate, requestedAppointmentId }: {
  requestedUnit: string;
  requestedDate: string;
  requestedAppointmentId: string;
}) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitsStatus, setUnitsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [unitsError, setUnitsError] = useState("");
  const [unit, setUnit] = useState(requestedUnit);
  const [anchor, setAnchor] = useState(() => requestedDate || dayKey(new Date()));
  const [mode, setMode] = useState<"day" | "week">(requestedAppointmentId ? "day" : "week");
  const [availability, setAvailability] = useState<AvailabilityState>({ status: "idle", slots: {}, timezone: "UTC", error: "", failedDays: [], loadedDays: [], unitId: "" });
  const availabilityRequest = useRef(0);
  const anchorAlignedToWorkspace = useRef(Boolean(requestedDate));
  const anchorInteracted = useRef(Boolean(requestedDate));

  const loadUnits = useCallback(async () => {
    setUnitsStatus("loading");
    setUnitsError("");
    try {
      const response = await api<{ unidades: Unit[] }>("/scheduling/config/unidades");
      setUnits(response.unidades);
      setUnit((current) => response.unidades.some(({ id }) => id === current) ? current : (response.unidades[0]?.id ?? ""));
      setUnitsStatus("ready");
    } catch (error) {
      setUnits([]);
      setUnit("");
      setUnitsError(messageFrom(error, "Não foi possível carregar as unidades."));
      setUnitsStatus("error");
    }
  }, []);

  useEffect(() => { void loadUnits(); }, [loadUnits]);
  const days = useMemo(() => {
    const date = new Date(`${anchor}T00:00:00.000Z`);
    if (mode === "day") return [date];
    const monday = addDays(date, -((date.getUTCDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  }, [anchor, mode]);

  const queryKey = unit ? `/scheduling/appointments?unidade_id=${unit}&inicio=${dayKey(days[0])}&fim=${dayKey(addDays(days.at(-1)!, 1))}` : null;
  const appointmentsQuery = useSWR<AppointmentsResponse>(queryKey, appointmentsFetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
    shouldRetryOnError: false
  });
  const appointments = useMemo(() => appointmentsQuery.data?.agendamentos ?? [], [appointmentsQuery.data?.agendamentos]);
  const timezone = appointmentsQuery.data?.timezone ?? availability.timezone;
  const blocksRange = useMemo(() => ({
    start: instantFromLocalMinute(`${dayKey(days[0])}T00:00`, timezone),
    end: instantFromLocalMinute(`${dayKey(addDays(days.at(-1)!, 1))}T00:00`, timezone)
  }), [days, timezone]);
  const timeBlocksQuery = useSWR<AttendantTimeBlocksResponse>(
    blocksRange.start && blocksRange.end
      ? `/scheduling/attendants/me/time-blocks?start=${encodeURIComponent(blocksRange.start)}&end=${encodeURIComponent(blocksRange.end)}`
      : null,
    (url: string) => api<AttendantTimeBlocksResponse>(url),
    { refreshInterval: 10_000, revalidateOnFocus: false, dedupingInterval: 5_000, shouldRetryOnError: false }
  );
  const workspaceTimezoneLoaded = Boolean(appointmentsQuery.data?.timezone || (availability.unitId === unit && availability.loadedDays.length > 0));
  const today = localDay(new Date(), timezone);

  useEffect(() => {
    if (!workspaceTimezoneLoaded || anchorAlignedToWorkspace.current || anchorInteracted.current) return;
    anchorAlignedToWorkspace.current = true;
    setAnchor(localDay(new Date(), timezone));
  }, [timezone, workspaceTimezoneLoaded]);

  const loadAvailability = useCallback(async () => {
    if (!unit) {
      setAvailability((current) => ({ status: "idle", slots: {}, timezone: current.timezone, error: "", failedDays: [], loadedDays: [], unitId: "" }));
      return;
    }
    const requestId = ++availabilityRequest.current;
    const requestedDays = days.map(dayKey);
    setAvailability((current) => {
      const sameUnit = current.unitId === unit;
      return { status: "loading", slots: sameUnit ? current.slots : {}, timezone: current.timezone, error: "", failedDays: sameUnit ? current.failedDays : [], loadedDays: sameUnit ? current.loadedDays : [], unitId: unit };
    });
    const results = await Promise.allSettled(requestedDays.map((date) => api<AvailabilityResponse>(`/scheduling/availability?unidade_id=${unit}&data=${date}`)));
    if (availabilityRequest.current !== requestId) return;
    setAvailability((current) => {
      const sameUnit = current.unitId === unit;
      const slots: Record<string, typeof current.slots[string]> = {};
      const loadedDays: string[] = [];
      const failedDays: string[] = [];
      let nextTimezone = current.timezone;
      let firstError: unknown;
      results.forEach((result, index) => {
        const date = requestedDays[index];
        if (result.status === "fulfilled") {
          slots[date] = result.value.horarios;
          loadedDays.push(date);
          nextTimezone = result.value.timezone || nextTimezone;
        } else {
          failedDays.push(date);
          firstError ??= result.reason;
          if (sameUnit && current.loadedDays.includes(date)) {
            slots[date] = current.slots[date] ?? [];
            loadedDays.push(date);
          }
        }
      });
      if (loadedDays.length === 0) return { status: "error", slots: {}, timezone: nextTimezone, error: messageFrom(firstError, "Não foi possível carregar a disponibilidade."), failedDays, loadedDays: [], unitId: unit };
      return { status: "ready", slots, timezone: nextTimezone, error: "", failedDays, loadedDays, unitId: unit };
    });
  }, [days, unit]);

  useEffect(() => {
    void loadAvailability();
    return () => { availabilityRequest.current += 1; };
  }, [loadAvailability]);

  function navigate(direction: number) {
    anchorInteracted.current = true;
    setAnchor(dayKey(addDays(new Date(`${anchor}T00:00:00.000Z`), direction * (mode === "day" ? 1 : 7))));
  }

  function goToday() {
    anchorInteracted.current = true;
    setAnchor(today);
  }

  return {
    units, unitsStatus, unitsError, unit, setUnit, anchor, mode, setMode, days, availability,
    appointmentsData: appointmentsQuery.data, appointmentsError: appointmentsQuery.error,
    appointmentsLoading: appointmentsQuery.isLoading, mutateAppointments: appointmentsQuery.mutate,
    appointments, timezone, today, loadUnits, loadAvailability, navigate, goToday,
    timeBlocks: timeBlocksQuery.data?.blocks ?? [], timeBlocksError: timeBlocksQuery.error,
    mutateTimeBlocks: timeBlocksQuery.mutate
  };
}

export type AgendaData = ReturnType<typeof useAgendaData>;

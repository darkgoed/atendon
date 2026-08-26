import type { AppointmentStatus, FinalAction, Slot } from "./agenda-types";

export const DEFAULT_APPOINTMENT_DURATION_MS = 60 * 60_000;

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  confirmado: "Confirmado",
  reagendado: "Reagendado",
  cancelado: "Cancelado",
  concluido: "Compareceu",
  no_show: "Não compareceu"
};

export const FINAL_ACTION_SUCCESS: Record<FinalAction, string> = {
  cancel: "Cancelamento",
  complete: "Resultado",
  no_show: "Não comparecimento"
};

export const dayKey = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (date: Date, count: number) => new Date(date.getTime() + count * 86_400_000);

/** Move a calendar anchor by an exact number of calendar months (not 28 days). */
export function addCalendarMonths(date: Date, count: number) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

export function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isActiveAppointment(status: AppointmentStatus) {
  return status === "confirmado" || status === "reagendado";
}

export function formatSlot(slot: Slot, timezone: string) {
  const start = new Date(slot.start);
  return `${start.toLocaleDateString("pt-BR", { timeZone: timezone, weekday: "short", day: "2-digit", month: "2-digit" })} · ${start.toLocaleTimeString("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`;
}

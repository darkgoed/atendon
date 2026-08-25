type ResultPendingAppointment = {
  status: string;
  end: string;
  result_pending?: boolean;
  result_pending_at?: string | null;
};

export function isAppointmentResultPending(appointment: ResultPendingAppointment, now = Date.now()) {
  if (appointment.result_pending || appointment.result_pending_at) return true;
  if (appointment.status !== "confirmado" && appointment.status !== "reagendado") return false;
  const end = new Date(appointment.end).getTime();
  return Number.isFinite(end) && end <= now;
}

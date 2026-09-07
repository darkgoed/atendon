import { api } from "./api";
export const fetchSchedulingConfig = <T>(resource: string) => api<T>(`/scheduling/config/${resource}`);
export const createSchedulingConfig = (resource: string, payload: unknown) => api<unknown>(`/scheduling/config/${resource}`, { method: "POST", body: JSON.stringify(payload) });
export const updateSchedulingConfig = (resource: string, id: string, payload: unknown) => api<unknown>(`/scheduling/config/${resource}/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const deleteSchedulingConfig = (resource: string, id: string) => api<unknown>(`/scheduling/config/${resource}/${id}`, { method: "DELETE" });
export const deleteTimeBlock = (id: string) => api<unknown>(`/scheduling/attendants/me/time-blocks/${id}`, { method: "DELETE" });
export const updateAttendantAvailability = (id: string, status: string) => api<unknown>(`/scheduling/attendants/${id}/availability`, { method: "PATCH", body: JSON.stringify({ availability_status: status }) });
export const updateAttendantCalendarColor = (id: string, color: string) => api<unknown>(`/scheduling/attendants/${id}/calendar-color`, { method: "PATCH", body: JSON.stringify({ cor_agenda: color }) });

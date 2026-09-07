import { api } from "./api";
import type { PanelSession } from "./session";
export const fetchPanelSession = () => api<PanelSession>("/me");
export const fetchWorkspaceTimezone = <T>() => api<T>("/workspaces/current/timezone");
export const updateWorkspaceTimezone = (timezone: string) => api<unknown>("/workspaces/current/timezone", { method: "PATCH", body: JSON.stringify({ timezone }) });
export const updateSignatureSettings = (payload: unknown) => api<unknown>("/signature", { method: "PUT", body: JSON.stringify(payload) });
export const updateNotificationPreferences = (payload: unknown) => api<unknown>("/me/notification-preferences", { method: "PATCH", body: JSON.stringify(payload) });
export const unmuteConversation = (conversationId: string) => api<unknown>(`/conversations/${conversationId}/notification-mute`, { method: "PATCH", body: JSON.stringify({ muted: false }) });

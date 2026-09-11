import { api } from "./api";

export type ConnectionChannel = "whatsapp" | "instagram";

export interface ConnectionState {
  id: string;
  label: string;
  channel?: ConnectionChannel;
  is_primary: boolean;
  phone_number: string | null;
  status: "qr_pending" | "connected" | "disconnected" | "banned";
  qr_code: string | null;
  last_connected_at: string | null;
  disconnected_reason: string | null;
  created_at: string;
}

export interface ConnectionLimits {
  used: number;
  max: number | null;
}

export interface ConnectionsResponse {
  connections: ConnectionState[];
  limits: ConnectionLimits;
}

export async function listConnections() {
  const response = await api<ConnectionsResponse>("/connections");
  return {
    ...response,
    connections: response.connections.map((connection) => ({ ...connection, channel: connection.channel ?? "whatsapp" }))
  };
}

export function createConnection(label: string) {
  return api<{ connection: Pick<ConnectionState, "id" | "label"> }>("/connections", {
    method: "POST",
    body: JSON.stringify({ label })
  });
}

export function renameConnection(id: string, label: string) {
  return api<{ connection: Pick<ConnectionState, "id" | "label" | "is_primary"> }>(`/connections/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ label })
  });
}

export function promoteConnection(id: string) {
  return api<{ connection: Pick<ConnectionState, "id" | "label" | "is_primary"> }>(`/connections/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ is_primary: true })
  });
}

export function archiveConnection(id: string) {
  return api<void>(`/connections/${id}`, { method: "DELETE" });
}

export function reconnectConnection(id: string) {
  return api<void>(`/connections/${id}/reconnect`, { method: "POST" });
}

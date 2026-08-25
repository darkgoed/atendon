import { auditActionLabel, auditResourceLabel } from "./labels";

export type AuditLogEntry = {
  id: string;
  actor_scope: "root" | "workspace";
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
};

export function filterAuditLogs(logs: readonly AuditLogEntry[], query: string, includeWorkspace = false): AuditLogEntry[] {
  const term = query.trim().toLocaleLowerCase("pt-BR");
  if (!term) return [...logs];
  return logs.filter((log) => [
    ...(includeWorkspace ? [log.workspace_name, log.workspace_id] : []),
    log.actor_email,
    log.action,
    auditActionLabel(log.action),
    log.resource_type,
    auditResourceLabel(log.resource_type),
    log.resource_id,
    JSON.stringify(log.metadata ?? {})
  ].filter(Boolean).some((value) => String(value).toLocaleLowerCase("pt-BR").includes(term)));
}

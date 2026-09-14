import { Empty } from "@/components/page-state";
import { TableScroll } from "@/components/ui";
import styles from "@/components/admin/admin.module.css";
import { ReadableDetails } from "@/components/readable-details";
import { actorScopeLabel, auditActionLabel, auditResourceLabel } from "@/lib/labels";
import type { AuditLogEntry } from "@/lib/audit-ui";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function AuditLogTable({ logs, showWorkspace = false }: { logs: readonly AuditLogEntry[]; showWorkspace?: boolean }) {
  if (logs.length === 0) return <Empty>Nenhum evento encontrado para o filtro atual.</Empty>;

  return (
    <TableScroll className={styles.tableScroll}>
      <table className="admin-table responsive-table">
        <thead>
          <tr>
            <th>Quando</th>
            {showWorkspace ? <th>Workspace</th> : null}
            <th>Ator</th>
            <th>Ação</th>
            <th>Recurso</th>
            <th>Metadados</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td data-label="Quando">{dateTime.format(new Date(log.created_at))}</td>
              {showWorkspace ? (
                <td data-label="Workspace">
                  <strong>{log.workspace_name ?? "Global"}</strong>
                  <span className="sub mono">{log.workspace_id ?? "-"}</span>
                </td>
              ) : null}
              <td data-label="Ator">
                <strong>{log.actor_email ?? "Sistema"}</strong>
                <span className={`admin-badge${log.actor_scope === "root" ? " admin-badge--warn" : ""}`}>{actorScopeLabel(log.actor_scope)}</span>
              </td>
              <td data-label="Ação"><span className="admin-pill">{auditActionLabel(log.action)}</span></td>
              <td data-label="Recurso">
                <strong>{auditResourceLabel(log.resource_type)}</strong>
                <span className="sub mono">{log.resource_id ?? "-"}</span>
              </td>
              <td data-label="Metadados"><ReadableDetails details={log.metadata} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

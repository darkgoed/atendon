import { describe, expect, it } from "vitest";
import { filterAuditLogs, type AuditLogEntry } from "../lib/audit-ui";

const log: AuditLogEntry = {
  id: "event-1",
  actor_scope: "root",
  action: "members.invite",
  resource_type: "workspace_member",
  resource_id: "member-7",
  metadata: { email: "ana@example.com" },
  created_at: "2026-07-23T10:00:00.000Z",
  actor_email: "ops@example.com",
  workspace_id: "workspace-1",
  workspace_name: "Operação Sul"
};

describe("audit log filtering", () => {
  it("matches translated action and resource labels", () => {
    expect(filterAuditLogs([log], "convite de membro")).toHaveLength(1);
    expect(filterAuditLogs([log], "membro do workspace")).toHaveLength(1);
  });

  it("only includes workspace fields for the root view", () => {
    expect(filterAuditLogs([log], "operação sul")).toHaveLength(0);
    expect(filterAuditLogs([log], "operação sul", true)).toHaveLength(1);
  });
});

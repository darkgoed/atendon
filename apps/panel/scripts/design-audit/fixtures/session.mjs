import { PERMISSION_KEYS, sessionFor } from "../catalog.mjs";
export const IDS = { user: "qa-user-0001", workspace: "qa-workspace-0001", lead: "qa-lead-0001", conversation: "qa-conversation-0001" };
export const workspace = { id: IDS.workspace, name: "AtendON QA Workspace", slug: "atendon-qa", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" };
export const session = sessionFor(false);
export const rootSession = sessionFor(true);
export const rootWorkspaceSession = {
  ...rootSession,
  activeWorkspace: workspace,
  workspaces: [workspace]
};
export const member = { id: "qa-member-0001", user_id: "qa-member-user", name: "Ana QA", email: "ana@example.test", role: "ADMIN", status: "active" };
export { PERMISSION_KEYS };
export function envelope(value) { return value; }

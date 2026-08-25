export interface SessionUser {
  id: string;
  email: string;
  isRoot: boolean;
  name: string | null;
  mustChangePassword?: boolean;
}

export interface SessionWorkspace {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: string;
  timezone?: string;
}

export interface PanelSession {
  user: SessionUser;
  activeWorkspace: SessionWorkspace | null;
  workspaces: SessionWorkspace[];
  permissions: string[];
  actorScope: "root" | "workspace";
  rootWorkspaceAccess?: boolean;
}

export const WORKSPACE_CONTEXT_STORAGE_KEY = "atendon:workspace-context:v1";
export const WORKSPACE_CONTEXT_CHANNEL = "atendon:workspace-context:v1";

type WorkspaceContextStorage = Pick<Storage, "setItem">;
type WorkspaceContextBroadcast = (channel: string, value: string) => void;

function broadcastWorkspaceContext(channel: string, value: string) {
  if (typeof BroadcastChannel === "undefined") return;
  const broadcast = new BroadcastChannel(channel);
  broadcast.postMessage(value);
  broadcast.close();
}

export function publishWorkspaceContextChange(
  storage: WorkspaceContextStorage,
  workspaceId: string,
  nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  broadcast: WorkspaceContextBroadcast = broadcastWorkspaceContext
) {
  const value = JSON.stringify({ workspaceId, nonce });
  try { storage.setItem(WORKSPACE_CONTEXT_STORAGE_KEY, value); } catch { /* storage pode estar bloqueado */ }
  try { broadcast(WORKSPACE_CONTEXT_CHANNEL, value); } catch { /* canal pode estar indisponível */ }
}

export function shouldReloadForWorkspaceContextChange(
  key: string | null,
  newValue: string | null,
  currentWorkspaceId: string | null | undefined
): boolean {
  if (key !== WORKSPACE_CONTEXT_STORAGE_KEY || !newValue || !currentWorkspaceId) return false;
  try {
    const value = JSON.parse(newValue) as { workspaceId?: unknown };
    return typeof value.workspaceId === "string" && value.workspaceId !== currentWorkspaceId;
  } catch {
    return false;
  }
}

export function hasRequiredPermissions(granted: readonly string[], required?: readonly string[]) {
  if (!required?.length) return true;
  return required.every((permission) => granted.includes(permission));
}

export function canAccessWithSession(session: Pick<PanelSession, "actorScope" | "permissions" | "rootWorkspaceAccess" | "user">, required?: readonly string[]) {
  if (session.user.isRoot && session.actorScope === "root" && session.rootWorkspaceAccess) return true;
  return hasRequiredPermissions(session.permissions, required);
}

export function canAccessRootWorkspace(session: Pick<PanelSession, "actorScope" | "rootWorkspaceAccess" | "user">) {
  return session.user.isRoot && session.actorScope === "root" && session.rootWorkspaceAccess === true;
}

const WORKSPACE_CASE_MANAGER_ROLES = new Set(["ROOT", "OWNER", "ADMIN", "SUPERVISOR"]);

export function hasWorkspaceWideCaseScope(
  session: Pick<PanelSession, "activeWorkspace" | "user">
) {
  if (session.user.isRoot) return true;
  const role = session.activeWorkspace?.role.trim().toUpperCase();
  return Boolean(role && WORKSPACE_CASE_MANAGER_ROLES.has(role));
}

export function canLeaveCaseUnassigned(
  session: Pick<PanelSession, "activeWorkspace" | "user">
) {
  return hasWorkspaceWideCaseScope(session);
}

export function losesCaseAccessAfterTransfer(
  session: Pick<PanelSession, "activeWorkspace" | "user">,
  targetUserId: string | null
) {
  return !hasWorkspaceWideCaseScope(session) && targetUserId !== session.user.id;
}

export function caseScopedNavigationLabel(
  session: Pick<PanelSession, "activeWorkspace" | "user">,
  href: string,
  fallback: string
) {
  if (hasWorkspaceWideCaseScope(session)) return fallback;
  if (href === "/") return "Minha operação";
  if (href === "/conversas") return "Minhas conversas";
  if (href === "/leads") return "Meus leads";
  if (href === "/leads/pipeline") return "Meu pipeline";
  if (href === "/agenda") return "Minha agenda";
  return fallback;
}

export function canViewOperationalOnboarding(
  session: Pick<PanelSession, "actorScope" | "activeWorkspace">
) {
  return session.actorScope !== "workspace" || session.activeWorkspace?.role !== "OPERADOR";
}

export function canPollWorkspaceAlerts(
  session: Pick<PanelSession, "user" | "activeWorkspace" | "actorScope" | "permissions" | "rootWorkspaceAccess"> | null | undefined
) {
  return Boolean(session?.activeWorkspace && session.user.isRoot && canAccessRootWorkspace(session));
}

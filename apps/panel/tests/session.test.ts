import { describe, expect, it } from "vitest";
import {
  canAccessRootWorkspace,
  canAccessWithSession,
  canLeaveCaseUnassigned,
  caseScopedNavigationLabel,
  canPollWorkspaceAlerts,
  canViewOperationalOnboarding,
  hasWorkspaceWideCaseScope,
  losesCaseAccessAfterTransfer,
  publishWorkspaceContextChange,
  shouldReloadForWorkspaceContextChange,
  WORKSPACE_CONTEXT_CHANNEL,
  WORKSPACE_CONTEXT_STORAGE_KEY,
  type PanelSession
} from "../lib/session";

describe("workspace browser context", () => {
  it("publishes tenant switches and reloads only tabs bound to another tenant", () => {
    const values = new Map<string, string>();
    const broadcasts: Array<[string, string]> = [];
    publishWorkspaceContextChange({
      setItem: (key, value) => values.set(key, value)
    }, "tenant-b", "nonce-1", (channel, value) => broadcasts.push([channel, value]));
    const value = values.get(WORKSPACE_CONTEXT_STORAGE_KEY) ?? null;

    expect(value).toBe('{"workspaceId":"tenant-b","nonce":"nonce-1"}');
    expect(broadcasts).toEqual([[WORKSPACE_CONTEXT_CHANNEL, value]]);
    expect(shouldReloadForWorkspaceContextChange(
      WORKSPACE_CONTEXT_STORAGE_KEY,
      value,
      "tenant-a"
    )).toBe(true);
    expect(shouldReloadForWorkspaceContextChange(
      WORKSPACE_CONTEXT_STORAGE_KEY,
      value,
      "tenant-b"
    )).toBe(false);
    expect(shouldReloadForWorkspaceContextChange("unrelated", value, "tenant-a")).toBe(false);
  });
});

function buildSession(overrides: Partial<PanelSession> = {}): PanelSession {
  return {
    user: { id: "user-1", email: "user@test.local", isRoot: false, name: null },
    activeWorkspace: { id: "workspace-1", name: "Workspace", slug: "workspace", status: "active", role: "OWNER" },
    workspaces: [],
    permissions: ["dashboard.read"],
    actorScope: "workspace",
    ...overrides
  };
}

describe("canPollWorkspaceAlerts", () => {
  it("allows polling only for ROOT with assisted access to an active workspace", () => {
    expect(canPollWorkspaceAlerts(buildSession())).toBe(false);
    expect(canPollWorkspaceAlerts(buildSession({ permissions: [] }))).toBe(false);
    expect(canPollWorkspaceAlerts(buildSession({ actorScope: "root", permissions: [] }))).toBe(false);
    expect(canPollWorkspaceAlerts(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      permissions: [],
      rootWorkspaceAccess: false
    }))).toBe(false);
    expect(canPollWorkspaceAlerts(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      permissions: [],
      rootWorkspaceAccess: true
    }))).toBe(true);
    expect(canPollWorkspaceAlerts(buildSession({ activeWorkspace: null }))).toBe(false);
    expect(canPollWorkspaceAlerts(null)).toBe(false);
  });
});

describe("canAccessWithSession", () => {
  it("allows root assisted access to operational screens without role permissions", () => {
    expect(canAccessWithSession(buildSession({ permissions: [] }), ["dashboard.read"])).toBe(false);
    expect(canAccessWithSession(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      permissions: [],
      rootWorkspaceAccess: true
    }), ["dashboard.read"])).toBe(true);
  });

  it("allows root assisted access to member administration and invitations", () => {
    const rootSession = buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      permissions: [],
      rootWorkspaceAccess: true
    });
    expect(canAccessWithSession(rootSession, ["members.invite"])).toBe(true);
    expect(canAccessWithSession(rootSession, ["members.update"])).toBe(true);
    expect(canAccessWithSession(rootSession, ["members.remove"])).toBe(true);
  });
});

describe("canAccessRootWorkspace", () => {
  it("rejects every non-ROOT role even when it has all workspace permissions", () => {
    expect(canAccessRootWorkspace(buildSession({ permissions: ["agent.read", "humanizer.read", "roles.read", "api_keys.read", "usage.read"] }))).toBe(false);
    expect(canAccessRootWorkspace(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      rootWorkspaceAccess: false
    }))).toBe(false);
    expect(canAccessRootWorkspace(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      rootWorkspaceAccess: true
    }))).toBe(true);
  });
});

describe("canViewOperationalOnboarding", () => {
  it("hides the entire operational preparation from operators", () => {
    expect(canViewOperationalOnboarding(buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role: "OPERADOR"
      }
    }))).toBe(false);
  });

  it("keeps operational preparation available to administrative profiles", () => {
    expect(canViewOperationalOnboarding(buildSession())).toBe(true);
    expect(canViewOperationalOnboarding(buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role: "ADMIN"
      }
    }))).toBe(true);
    expect(canViewOperationalOnboarding(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      actorScope: "root",
      rootWorkspaceAccess: true,
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role: "ROOT"
      }
    }))).toBe(true);
  });
});

describe("hasWorkspaceWideCaseScope", () => {
  it.each(["ROOT", "OWNER", "ADMIN", "SUPERVISOR", " owner ", " supervisor "])("grants workspace case scope to %s", (role) => {
    expect(hasWorkspaceWideCaseScope(buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role
      }
    }))).toBe(true);
  });

  it.each(["OPERADOR", "CLOSER", "SUPERVISOR_CUSTOM"])("keeps %s restricted to assigned cases", (role) => {
    expect(hasWorkspaceWideCaseScope(buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role
      }
    }))).toBe(false);
  });

  it("keeps platform root access global even without a workspace role", () => {
    expect(hasWorkspaceWideCaseScope(buildSession({
      user: { id: "root-1", email: "root@test.local", isRoot: true, name: null },
      activeWorkspace: null
    }))).toBe(true);
  });
});

describe("case transfer UI scope", () => {
  it("never offers an unassigned state to operators or custom roles", () => {
    const operator = buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role: "OPERADOR"
      }
    });
    expect(canLeaveCaseUnassigned(operator)).toBe(false);
    expect(losesCaseAccessAfterTransfer(operator, null)).toBe(true);
    expect(losesCaseAccessAfterTransfer(operator, "user-2")).toBe(true);
    expect(losesCaseAccessAfterTransfer(operator, operator.user.id)).toBe(false);
    expect(caseScopedNavigationLabel(operator, "/conversas", "Conversas")).toBe("Minhas conversas");
    expect(caseScopedNavigationLabel(operator, "/leads", "Leads")).toBe("Meus leads");
    expect(caseScopedNavigationLabel(operator, "/leads/pipeline", "Pipeline")).toBe("Meu pipeline");
    expect(caseScopedNavigationLabel(operator, "/agenda", "Agenda")).toBe("Minha agenda");
  });

  it("keeps managers on the case after assigning or removing an owner", () => {
    const manager = buildSession();
    expect(canLeaveCaseUnassigned(manager)).toBe(true);
    expect(losesCaseAccessAfterTransfer(manager, null)).toBe(false);
    expect(losesCaseAccessAfterTransfer(manager, "user-2")).toBe(false);
    expect(caseScopedNavigationLabel(manager, "/conversas", "Conversas")).toBe("Conversas");
  });

  it("keeps supervisors on workspace-wide navigation and transferred cases", () => {
    const supervisor = buildSession({
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        status: "active",
        role: "SUPERVISOR"
      }
    });
    expect(canLeaveCaseUnassigned(supervisor)).toBe(true);
    expect(losesCaseAccessAfterTransfer(supervisor, "user-2")).toBe(false);
    expect(caseScopedNavigationLabel(supervisor, "/conversas", "Conversas")).toBe("Conversas");
    expect(caseScopedNavigationLabel(supervisor, "/leads", "Leads")).toBe("Leads");
    expect(caseScopedNavigationLabel(supervisor, "/agenda", "Agenda")).toBe("Agenda");
  });
});

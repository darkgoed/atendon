// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

type MemberRow = {
  id: string; status: string; joined_at: string; created_at: string; user_id: string;
  name: string; email: string; user_status: string; is_root: boolean; must_change_password: boolean;
  role_id: string; role_name: string; is_owner_role: boolean; team_id?: string | null; team_name?: string | null;
};

const MEMBERS: { members: MemberRow[] } = {
  members: [
    { id: "m-1", status: "active", joined_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", user_id: "u-1", name: "Alice", email: "alice@example.com", user_status: "active", is_root: false, must_change_password: false, role_id: "r-1", role_name: "OWNER", is_owner_role: true, team_id: null, team_name: null },
    { id: "m-2", status: "active", joined_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z", user_id: "u-2", name: "Bob", email: "bob@example.com", user_status: "active", is_root: false, must_change_password: false, role_id: "r-2", role_name: "AGENTE", is_owner_role: false, team_id: null, team_name: null }
  ]
};
const ROLES = { roles: [{ id: "r-2", name: "AGENTE", description: "", is_owner_role: false, is_system: true, permissions: [], member_count: 1 }] };
const INVITATIONS = { invitations: [] };
const TEAMS = { teams: [{ id: "team-1", name: "Suporte nível 2", created_at: "", updated_at: "", member_count: 0, active_member_count: 0 }] };
const SESSION = {
  user: { id: "u-owner", email: "owner@example.com", isRoot: false, name: "Owner", totpEnabled: false },
  activeWorkspace: { id: "w-1", name: "WS", slug: "ws", status: "active", role: "OWNER" },
  workspaces: [],
  // O /me real devolve as permissions da função — sem elas canAccessWithSession
  // nega members.update e o seletor de equipe não renderiza.
  permissions: ["members.read", "members.update", "members.invite", "members.remove"],
  actorScope: "workspace",
  rootWorkspaceAccess: false
};

apiMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
  if (url === "/me") return Promise.resolve(SESSION);
  if (url === "/workspaces/current/members") {
    if (init?.method === "PATCH") return Promise.resolve({ ok: true });
    return Promise.resolve(MEMBERS);
  }
  if (url === "/workspaces/current/member-roles") return Promise.resolve(ROLES);
  if (url === "/workspaces/current/invitations") return Promise.resolve(INVITATIONS);
  if (url === "/organization/teams") return Promise.resolve(TEAMS);
  return Promise.resolve({});
});

// Estado mutável do cache "swr": testes que precisam de members diferentes
// sobrescrevem `membersData` antes do render.
let membersData: { members: MemberRow[] } = MEMBERS;

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "/me" ? SESSION
      : key === "/workspaces/current/members" ? membersData
      : key === "/workspaces/current/member-roles" ? ROLES
      : key === "/workspaces/current/invitations" ? INVITATIONS
      : key === "/organization/teams" ? TEAMS
      : undefined,
    error: undefined,
    mutate: vi.fn(),
    isLoading: false
  })
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/labels", () => ({ accessStatusLabel: (s: string) => s, workspaceRoleLabel: (r: string) => r }));
vi.mock("@/lib/session", async (importOriginal) => await importOriginal<typeof import("@/lib/session")>());
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, LoadingCards: () => <div>carregando…</div> }));
vi.mock("@/components/popover-menu", () => ({ PopoverMenu: () => null }));
vi.mock("@/components/admin", () => ({
  AdminPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  AdminPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  AdminTableScroll: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AdminField: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>
}));

import { WorkspaceMembersContent } from "../app/workspace/members/content";

function memberCalls() {
  return apiMock.mock.calls.filter(([path, init]) => String(path).startsWith("/workspaces/current/members/") && (init as RequestInit | undefined)?.method === "PATCH");
}

beforeEach(() => {
  cleanup();
  membersData = MEMBERS;
  apiMock.mockClear();
  apiMock.mockImplementation((url: string) => {
    if (url === "/me") return Promise.resolve(SESSION);
    if (url === "/workspaces/current/members") return Promise.resolve(MEMBERS);
    if (url === "/workspaces/current/member-roles") return Promise.resolve(ROLES);
    if (url === "/workspaces/current/invitations") return Promise.resolve(INVITATIONS);
    if (url === "/organization/teams") return Promise.resolve(TEAMS);
    return Promise.resolve({});
  });
});

describe("membros — atribuição de equipe (B6)", () => {
  it("lista a coluna Equipe com opção atual do membro e cria card de equipes", async () => {
    render(<WorkspaceMembersContent />);
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Equipe de Bob" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select).toHaveDisplayValue(["Sem equipe"]);
    // Dono não tem seletor de equipe (papel de owner é fixo).
    expect(screen.queryByRole("combobox", { name: "Equipe de Alice" })).toBeNull();
    // O card de equipes lista a mesma estrutura.
    const teamsList = screen.getByRole("list", { name: "Lista de equipes" });
    expect(teamsList).toHaveTextContent("Suporte nível 2");
  });

  it("atribuir equipe PATCHa /workspaces/current/members/:id com team_id", async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersContent />);
    const select = await screen.findByRole("combobox", { name: "Equipe de Bob" }) as HTMLSelectElement;
    await user.selectOptions(select, "team-1");
    await waitFor(() => expect(memberCalls()).toHaveLength(1));
    const [, init] = memberCalls()[0]!;
    expect(String(memberCalls()[0]![0])).toBe("/workspaces/current/members/m-2");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ team_id: "team-1" });
  });

  it("voltar para Sem equipe PATCHa com team_id null", async () => {
    const user = userEvent.setup();
    membersData = { members: MEMBERS.members.map((m) => m.id === "m-2" ? { ...m, team_id: "team-1", team_name: "Suporte nível 2" } : m) };
    render(<WorkspaceMembersContent />);
    const select = (await screen.findByRole("combobox", { name: "Equipe de Bob" })) as HTMLSelectElement;
    expect(select.value).toBe("team-1");
    await user.selectOptions(select, "");
    await waitFor(() => expect(memberCalls()).toHaveLength(1));
    const [, init] = memberCalls()[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ team_id: null });
  });
});

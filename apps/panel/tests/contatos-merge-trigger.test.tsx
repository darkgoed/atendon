// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, permissions, mergeDialogSpy } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  permissions: { value: true },
  mergeDialogSpy: vi.fn()
}));

const LEADS_DATA = {
  leads: [
    { id: "lead-1", telefone: "5511999990000", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" },
    { id: "lead-2", telefone: "5511999990000", nome: "Ana (2)", status: "novo", atualizado_em: "2026-01-02T00:00:00Z" },
    { id: "lead-3", telefone: "5511977776666", nome: "Bruno", status: "novo", atualizado_em: "2026-01-03T00:00:00Z" }
  ],
  total: 3,
  page: { limit: 50, has_more: false, next_cursor: null }
};
const SESSION_DATA = {};

apiMock.mockImplementation((url: string) => {
  if (url === "/me") return Promise.resolve(SESSION_DATA);
  if (url === "/scheduling/config/unidades") return Promise.resolve({ unidades: [] });
  if (url === "/scheduling/config/categorias") return Promise.resolve({ categorias: [] });
  if (url === "/scheduling/config/parceiros") return Promise.resolve({ parceiros: [] });
  if (url.startsWith("/scheduling/leads")) return Promise.resolve(LEADS_DATA);
  return Promise.resolve({});
});

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "/me" ? SESSION_DATA : key?.startsWith("/scheduling/leads") ? LEADS_DATA : undefined,
    error: undefined,
    mutate: vi.fn(),
    isLoading: false
  })
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/lead-filters", () => ({ buildLeadFilterQuery: () => "" }));
vi.mock("@/lib/meet", () => ({ apiContentUrl: (path: string) => `/backend${path}` }));
vi.mock("@/lib/labels", () => ({ leadStatusLabel: (status: string) => status }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (permission: string) => (permission === "leads.delete" ? permissions.value : true) }));
vi.mock("@/lib/organization", () => ({
  useCaseOrganizationEnabled: () => true,
  applyLeadSavedViewFilters: (current: unknown) => current,
  leadFiltersForSavedView: (filters: unknown) => filters
}));
vi.mock("@/lib/session", () => ({ hasWorkspaceWideCaseScope: () => true }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => <button type="button">Visões</button> }));
vi.mock("@/components/tag-catalog-settings", () => ({ TagCatalogSettings: () => null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/contact-avatar", () => ({ ContactAvatar: () => <span /> }));
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null, LeadTagMenuItems: () => null }));
vi.mock("@/components/new-lead-dialog", () => ({ NewLeadDialog: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/lead-merge-dialog", () => ({
  LeadMergeDialog: (props: { open: boolean; pair: Array<{ id: string; nome: string | null; telefone: string }> }) => {
    mergeDialogSpy(props);
    return props.open ? <div role="dialog" aria-label="Mesclar contatos">{props.pair.map((lead) => <span key={lead.id}>{lead.id}</span>)}</div> : null;
  }
}));

import LeadsPage from "../app/contatos/page";

async function selectTwo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: "Selecionar Ana" }));
  await user.click(screen.getByRole("checkbox", { name: "Selecionar Ana (2)" }));
}

beforeEach(() => {
  permissions.value = true;
  apiMock.mockClear();
  mergeDialogSpy.mockClear();
});
afterEach(cleanup);

describe("contatos: gatilho do merge de contatos", () => {
  it("com 2 selecionados e permissão leads.delete, abre o dialog com o par fixado", async () => {
    const user = userEvent.setup();
    render(<LeadsPage />);
    await screen.findByText("Ana (2)");
    await selectTwo(user);
    await user.click(await screen.findByRole("button", { name: "Mesclar 2 selecionados" }));
    const last = mergeDialogSpy.mock.calls.at(-1)![0];
    expect(last.open).toBe(true);
    expect(last.pair.map((lead: { id: string }) => lead.id)).toEqual(["lead-1", "lead-2"]);
  });

  it("sem permissão leads.delete o gatilho não aparece", async () => {
    const user = userEvent.setup();
    permissions.value = false;
    render(<LeadsPage />);
    await screen.findByText("Ana (2)");
    await selectTwo(user);
    expect(screen.queryByRole("button", { name: "Mesclar 2 selecionados" })).toBeNull();
  });

  it("com um único selecionado o gatilho não aparece", async () => {
    const user = userEvent.setup();
    render(<LeadsPage />);
    await screen.findByText("Bruno");
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Bruno" }));
    expect(screen.queryByRole("button", { name: "Mesclar 2 selecionados" })).toBeNull();
  });
});

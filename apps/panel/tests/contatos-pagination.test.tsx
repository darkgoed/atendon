// @vitest-environment jsdom
// C3 (auditoria P1): "Carregar mais" repetia `limit` na query; o Fastify vira
// array e o z.coerce.number() do GET /scheduling/leads responde 400.
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, permissions, exportResult } = vi.hoisted(() => ({ apiMock: vi.fn(), permissions: { value: true }, exportResult: { value: Promise.resolve("id,nome\n") as Promise<unknown> } }));

// Referências ESTÁVEIS: o efeito de sincronia da paginação keyset compara
// data?.page por referência; mock que devolve objeto novo por render entra em
// loop infinito de re-render (o swr real cacheia e mantém a identidade).
const LEADS_DATA = { leads: [{ id: "lead-1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], total: 2, page: { limit: 50, has_more: true, next_cursor: "cursor-1" } };
const SESSION_DATA = { workspace_role: "owner" };

apiMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
  if (url === "/me") return Promise.resolve(SESSION_DATA);
  if (url === "/scheduling/config/unidades") return Promise.resolve({ unidades: [{ id: "u1", nome: "Matriz" }] });
  if (url === "/scheduling/config/categorias") return Promise.resolve({ categorias: [{ id: "c1", nome: "Pousada" }] });
  if (url === "/scheduling/config/parceiros") return Promise.resolve({ parceiros: [] });
  if (url === "/scheduling/leads" && init?.method === "POST") {
    return Promise.resolve({ lead: { id: "lead-new", nome: "Maria", telefone: "5511912345678", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" } });
  }
  if (url.startsWith("/contact-ops/export.csv")) return exportResult.value;
  if (url.startsWith("/scheduling/leads") && url.includes("cursor=")) {
    return Promise.resolve({ leads: [{ id: "lead-2", telefone: "5511988888888", nome: "Bruno", status: "novo", atualizado_em: "2025-12-01T00:00:00Z" }], total: 2, page: { limit: 50, has_more: false, next_cursor: null } });
  }
  if (url.startsWith("/scheduling/leads")) {
    return Promise.resolve(LEADS_DATA);
  }
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
vi.mock("@/lib/use-permission", () => ({ usePermission: (permission: string) => permission === "leads.create" ? permissions.value : permission !== "leads.update_status" }));
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
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import LeadsPage from "../app/contatos/page";

afterEach(cleanup);

describe("contatos: paginação por cursor", () => {
  beforeEach(() => { permissions.value = true; apiMock.mockClear(); });

  it("Carregar mais envia cursor com um único limit e anexa a página seguinte", async () => {
    const user = userEvent.setup();
    render(<LeadsPage />);
    expect(await screen.findByText("Ana")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Carregar mais contatos" }));
    expect(await screen.findByText("Bruno")).toBeInTheDocument();

    const pageCall = apiMock.mock.calls.map(([url]) => String(url)).find((url) => url.includes("cursor="));
    expect(pageCall).toBeDefined();
    const params = new URLSearchParams(pageCall!.split("?")[1]);
    expect(params.getAll("limit")).toEqual(["50"]);
    expect(params.get("cursor")).toBe("cursor-1");
  });
});

// Suspeita da auditoria P1 (confirmada): o export abria /contact-ops/export.csv
// com location.assign; qualquer 4xx virava uma página de JSON cru.
describe("contatos: exportar CSV", () => {
  beforeEach(() => { apiMock.mockClear(); });

  it("erro do export aparece no painel e não navega para o JSON da API", async () => {
    exportResult.value = Promise.reject(new Error("Campo status: valor não permitido"));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
    const user = userEvent.setup();
    render(<LeadsPage />);
    await user.click(await screen.findByRole("button", { name: "Exportar CSV" }));
    expect(await screen.findByText("Campo status: valor não permitido")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sucesso baixa o CSV como arquivo", async () => {
    exportResult.value = Promise.resolve("id,nome\n1,Ana\n");
    const createObjectURL = vi.fn(() => "blob:csv");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<LeadsPage />);
    await user.click(await screen.findByRole("button", { name: "Exportar CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith("/contact-ops/export.csv");
    expect(createObjectURL).toHaveBeenCalled();
  });
});

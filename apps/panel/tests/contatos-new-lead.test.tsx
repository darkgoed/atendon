// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, permissions } = vi.hoisted(() => ({ apiMock: vi.fn(), permissions: { value: true } }));

// Referências ESTÁVEIS: o efeito de sincronia da paginação keyset compara
// data?.page por referência; mock que devolve objeto novo por render entra em
// loop infinito de re-render (o swr real cacheia e mantém a identidade).
const LEADS_DATA = { leads: [{ id: "lead-1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], total: 1, page: { limit: 50, has_more: false, next_cursor: null } };
const SESSION_DATA = { workspace_role: "owner" };

apiMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
  if (url === "/me") return Promise.resolve(SESSION_DATA);
  if (url === "/scheduling/config/unidades") return Promise.resolve({ unidades: [{ id: "u1", nome: "Matriz" }] });
  if (url === "/scheduling/config/categorias") return Promise.resolve({ categorias: [{ id: "c1", nome: "Pousada" }] });
  if (url === "/scheduling/config/parceiros") return Promise.resolve({ parceiros: [] });
  if (url === "/scheduling/leads" && init?.method === "POST") {
    return Promise.resolve({ lead: { id: "lead-new", nome: "Maria", telefone: "5511912345678", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" } });
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

describe("contatos: cadastro manual de contato", () => {
  beforeEach(() => { permissions.value = true; apiMock.mockClear(); });

  it("abre o dialog pelo botão Novo contato, cria via POST /scheduling/leads e recarrega a lista", async () => {
    const user = userEvent.setup();
    render(<LeadsPage />);
    expect(await screen.findByText("Ana")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Novo contato" }));
    const dialog = await screen.findByRole("dialog", { name: "Novo contato" });
    expect(dialog).toBeInTheDocument();

    await user.type(screen.getByLabelText("Nome"), "Maria");
    await user.type(screen.getByLabelText("Telefone / WhatsApp"), "11 91234-5678");
    await user.type(screen.getByLabelText("Origem (opcional)"), "Indicação");

    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/scheduling/leads",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"telefone":"11 91234-5678"')
      })
    ));
  });

  it("envia apenas os campos preenchidos (opcionais vazios ficam de fora do payload)", async () => {
    const user = userEvent.setup();
    render(<LeadsPage />);
    await screen.findByText("Ana");

    await user.click(screen.getByRole("button", { name: "Novo contato" }));
    await screen.findByRole("dialog", { name: "Novo contato" });

    await user.type(screen.getByLabelText("Telefone / WhatsApp"), "11 91234-5678");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/scheduling/leads",
      expect.objectContaining({ method: "POST" })
    ));
    const body = JSON.parse(apiMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body ?? "{}");
    expect(body).toEqual({ telefone: "11 91234-5678" });
  });

  it("não mostra o botão sem a permissão leads.create", () => {
    permissions.value = false;
    render(<LeadsPage />);
    expect(screen.queryByRole("button", { name: "Novo contato" })).not.toBeInTheDocument();
  });
});

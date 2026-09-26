// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

// Radix Popover/Dialog medem conteúdo com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const permissions: Record<string, boolean> = {
  "leads.follow_up.read": true,
  "leads.update_status": true,
  "leads.create": true,
  "trash.manage": true,
};

vi.mock("swr", () => ({ default: (key: string | null) => ({
  data: key === "/me" ? { workspace_role: "owner" } : key?.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }] } : undefined,
  error: undefined,
  mutate: vi.fn(),
  isLoading: false,
}) }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/lib/lead-filters", () => ({ buildLeadFilterQuery: () => "" }));
vi.mock("@/lib/meet", () => ({ apiContentUrl: (path: string) => `/backend${path}` }));
vi.mock("@/lib/labels", () => ({ leadStatusLabel: (status: string) => status }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (permission: string) => permissions[permission] ?? false }));
vi.mock("@/lib/organization", () => ({
  useCaseOrganizationEnabled: () => true,
  applyLeadSavedViewFilters: (current: unknown) => current,
  leadFiltersForSavedView: (filters: unknown) => filters,
}));
vi.mock("@/lib/session", () => ({ hasWorkspaceWideCaseScope: () => true }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => <button type="button">Visões</button> }));
vi.mock("@/components/tag-catalog-settings", () => ({ TagCatalogSettings: () => <button type="button">Catálogo</button> }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/contact-avatar", () => ({ ContactAvatar: () => <span /> }));
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null, LeadTagMenuItems: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import LeadsPage from "../app/contatos/page";
import TrashPage from "../app/contatos/lixeira/page";

describe("ajuda contextual — contatos", () => {
  it("lista de contatos traz ajuda nos cabeçalhos Etapa e Contexto", () => {
    const markup = renderToStaticMarkup(<LeadsPage />);
    expect(markup).toContain('aria-label="Ajuda: Etapa"');
    expect(markup).toContain('aria-label="Ajuda: Contexto"');
    // Os rótulos originais dos cabeçalhos continuam presentes.
    expect(markup).toContain("Etapa");
    expect(markup).toContain("Contexto");
  });

  it("dialog de novo contato explica reuso do telefone e exigência de origem sem mudar nomes acessíveis", async () => {
    const { NewLeadDialog } = await import("../components/new-lead-dialog");
    render(<NewLeadDialog open onClose={() => undefined} onCreated={() => undefined} />);
    expect(screen.getByRole("button", { name: "Ajuda: Telefone / WhatsApp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Origem (opcional)" })).toBeInTheDocument();
    // O nome acessível dos campos permanece intacto (o "?" fica fora do label).
    expect(screen.getByLabelText("Telefone / WhatsApp")).toBeInTheDocument();
    expect(screen.getByLabelText("Origem (opcional)")).toBeInTheDocument();
  });

  it("lixeira traz ajuda sobre restaurar e exclusão definitiva", () => {
    render(<TrashPage />);
    expect(screen.getByRole("button", { name: "Ajuda: Lixeira" })).toBeInTheDocument();
  });
});

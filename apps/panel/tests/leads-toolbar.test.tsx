import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const permissions: Record<string, boolean> = {
  "leads.follow_up.read": true,
  "leads.update_status": true,
  "tags.manage": true,
  "tags.apply": true,
  "leads.transfer": true,
};

vi.mock("swr", () => ({ default: (key: string | null) => ({
  data: key === "/me" ? { workspace_role: "owner" } : key?.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }] } : undefined,
  error: undefined,
  mutate: vi.fn(),
  isLoading: false,
}) }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/lib/lead-filters", () => ({ buildLeadFilterQuery: () => "", }));
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
vi.mock("@/components/tag-catalog-settings", () => ({ TagCatalogSettings: () => permissions["tags.manage"] ? <button type="button">Catálogo</button> : null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: ({ selected }: { selected: unknown[] }) => selected.length ? <button type="button">Ações em lote ({selected.length})</button> : null }));
vi.mock("@/components/contact-avatar", () => ({ ContactAvatar: () => <span /> }));
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null, LeadTagPicker: () => <button type="button">Etiquetas</button>, LeadTagMenuItems: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@phosphor-icons/react", () => ({ DotsThreeVertical: () => null, DownloadSimple: () => null, Eye: () => null, MagnifyingGlass: () => null, MagicWand: () => null, WhatsappLogo: () => null, Funnel: () => null, X: () => null, UploadSimple: () => null }));

import LeadsPage from "../app/contatos/page";
import { BulkLeadActions } from "../components/bulk-lead-actions";

describe("leads toolbar", () => {
  vi.stubGlobal("React", React);
  it("renders the expected top actions and only the table surface as the scroll container", () => {
    const markup = renderToStaticMarkup(<LeadsPage />);
    expect(markup).toContain("Visões");
    expect(markup).toContain("Filtros");
    expect(markup).toContain("Catálogo");
    expect(markup).toContain("Exportar CSV");
    expect(markup).toContain('class="leads-table-surface responsive-table-wrap overflow-y-auto"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).not.toContain('class="leads-filters"');
  });

  it("does not render catalog without tags.manage permission", () => {
    permissions["tags.manage"] = false;
    const markup = renderToStaticMarkup(<LeadsPage />);
    expect(markup).not.toContain("Catálogo");
    permissions["tags.manage"] = true;
  });

  it("omits the CSV export without leads.follow_up.read", () => {
    permissions["leads.follow_up.read"] = false;
    const markup = renderToStaticMarkup(<LeadsPage />);
    expect(markup).not.toContain("Exportar CSV");
    permissions["leads.follow_up.read"] = true;
  });


  it("shows the selected lead count in bulk actions", () => {
    const markup = renderToStaticMarkup(<BulkLeadActions selected={[{ id: "1" }, { id: "2" }]} onClear={() => undefined} onChanged={() => undefined} />);
    expect(markup).toContain("Ações em lote (2)");
  });
});

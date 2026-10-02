// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineLead, PipelineStage } from "@/lib/pipeline";

const { apiMock, canMoveState } = vi.hoisted(() => ({ apiMock: vi.fn(), canMoveState: { value: true } }));
const pagination = vi.hoisted(() => ({ value: { next_cursor: "cursor-1", has_more: false, limit: 50 } }));
apiMock.mockImplementation((url: string) => Promise.resolve(url === "/me" ? {
  user: { id: "user-1" }, activeWorkspace: { id: "workspace-1", timezone: "UTC" }, workspace_role: "owner"
} : url === "/organization/pipeline" ? { stages: [{ id: "stage-1", name: "Novo", technical_status: "novo", position: 1 }], transitions: [], follow_up_config: {} } : url.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", nome: "Ana", telefone: "5511999999999", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }] } : { members: [] }));
vi.mock("swr", () => ({ default: (key: string | null) => ({ data: key === "/me" ? { user: { id: "user-1" }, activeWorkspace: { id: "workspace-1", timezone: "UTC" }, workspace_role: "owner" } : key === "/organization/pipeline" ? { stages: [{ id: "stage-1", name: "Novo", technical_status: "novo", position: 1 }], transitions: [], follow_up_config: {} } : key?.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", nome: "Ana", telefone: "5511999999999", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], page: pagination.value } : key === "/workspaces/current/members" ? { members: [] } : undefined, error: undefined, mutate: vi.fn(), isLoading: false }) }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (p: string) => p !== "leads.update_status" ? true : canMoveState.value }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/lib/session", () => ({ hasWorkspaceWideCaseScope: () => true, canAccessWithSession: () => true }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/pipeline-board", () => ({ PipelineBoard: ({ onColumnLoadMore, leads }: { onColumnLoadMore: (stage: PipelineStage) => void; leads: PipelineLead[] }) => <><div data-testid="pipeline-board">Kanban board</div><button onClick={() => onColumnLoadMore({ id: "stage-1", name: "Novo", color: "#64748B", technical_status: "novo", position: 1, is_default: true })}>Mais na etapa</button>{leads.map((lead) => <span key={lead.id}>{lead.nome}</span>)}</> }));
vi.mock("@/components/pipeline-filters", () => ({ PipelineFilters: ({ filters, onChange }: { filters: Record<string, string>; onChange: (filters: Record<string, string>) => void }) => <select aria-label="Origem filtro" value={filters.origem} onChange={(event) => onChange({ ...filters, origem: event.target.value })}><option value="">Todas</option><option value="instagram">Instagram</option></select> }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => null }));
vi.mock("@/components/pipeline-view-preferences", () => ({ PipelineViewPreferences: () => null }));
vi.mock("@/components/pipeline-settings", () => ({ PipelineSettings: () => null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/pipeline-transition-dialog", () => ({ PipelineTransitionDialog: () => null }));
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import PipelinePage from "../app/pipeline/page";
import { buildPipelineTransitionPayload } from "../lib/pipeline";

describe("pipeline view interactions", () => {
  beforeEach(() => { localStorage.clear(); apiMock.mockClear(); canMoveState.value = true; pagination.value = { next_cursor: "cursor-1", has_more: false, limit: 50 }; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  async function mounted() { const user = userEvent.setup(); render(<PipelinePage />); await screen.findByText("Kanban board"); return user; }

  it("switches between Kanban and Lista with real clicks", async () => { const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(screen.getByRole("table")).toBeTruthy(); expect(screen.queryByTestId("pipeline-board")).toBeNull(); await user.click(screen.getByRole("button", { name: "Kanban" })); expect(screen.getByTestId("pipeline-board")).toBeTruthy(); });
  it("supports Tab plus Enter and Space keyboard activation", async () => { const user = await mounted(); screen.getByRole("button", { name: "Kanban" }).focus(); await user.tab(); await user.keyboard("{Enter}"); expect(screen.getByRole("table")).toBeTruthy(); for (let i = 0; i < 15 && document.activeElement !== screen.getByRole("button", { name: "Kanban" }); i++) await user.tab(); await user.keyboard(" "); expect(screen.getByTestId("pipeline-board")).toBeTruthy(); });
  it("omits Mover without permission", async () => { canMoveState.value = false; const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(screen.queryByRole("button", { name: "Mover" })).toBeNull(); });
  it("does not fetch when only the view changes", async () => { const user = await mounted(); const calls = apiMock.mock.calls.length; await user.click(screen.getByRole("button", { name: "Lista" })); await user.click(screen.getByRole("button", { name: "Kanban" })); expect(apiMock).toHaveBeenCalledTimes(calls); });
  it("persists and rereads the preference", async () => { const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(localStorage.getItem("atendon.pipeline.view:workspace-1:user-1")).toBe("list"); cleanup(); render(<PipelinePage />); expect(await screen.findByRole("table")).toBeTruthy(); });

  it("hides pagination without hasMore", async () => {
    const user = await mounted();
    await user.click(screen.getByRole("button", { name: "Lista" }));
    expect(screen.queryByRole("button", { name: "Carregar mais leads" })).toBeNull();
  });

  it.each([1440, 375])("places compact pagination below results at %ipx and guards duplicate loads", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    pagination.value = { next_cursor: "cursor-1", has_more: true, limit: 50 };
    const user = await mounted();
    await user.click(screen.getByRole("button", { name: "Lista" }));
    const button = screen.getByRole("button", { name: "Carregar mais leads" });
    const footer = button.closest("footer")!;
    expect(footer.className).toBe("pipeline-list__footer");
    expect(footer.previousElementSibling?.contains(screen.getByRole("table"))).toBe(true);
    expect(footer.parentElement?.classList.contains("pipeline-page__board--list")).toBe(true);
    expect(button.classList.contains("btn--sm")).toBe(true);
    let resolve!: (value: unknown) => void;
    apiMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve({ leads: [{ id: "lead-1", nome: "Ana", telefone: "5511999999999", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }, { id: "lead-2", nome: "Bia", telefone: "5511888888888", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], page: { next_cursor: null, has_more: false, limit: 50 } });
    await screen.findByText("Bia");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Carregar mais leads" })).toBeNull());
    expect(screen.getAllByText("Ana")).toHaveLength(1);
  });

  it.each(["success", "failure", "roundtrip"])("discards stale list %s after filter changes without releasing the new request lock", async (outcome) => {
    pagination.value = { next_cursor: "cursor-1", has_more: true, limit: 50 };
    const user = await mounted();
    await user.click(screen.getByRole("button", { name: "Lista" }));
    let resolveA!: (value: unknown) => void;
    let rejectA!: (reason: Error) => void;
    let resolveB!: (value: unknown) => void;
    apiMock.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais leads" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Origem filtro" }), "instagram");
    if (outcome === "roundtrip") await user.selectOptions(screen.getByRole("combobox", { name: "Origem filtro" }), "");
    const buttonB = await screen.findByRole("button", { name: "Carregar mais leads" });
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    fireEvent.click(buttonB);
    await act(async () => {
      if (outcome === "failure") rejectA(new Error("Erro antigo"));
      else resolveA({ leads: [{ id: "stale", nome: "Lead antigo", telefone: "5511", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], page: { has_more: false, next_cursor: null, limit: 50 } });
    });
    expect(screen.queryByText("Lead antigo")).toBeNull();
    expect(screen.queryByText("Erro antigo")).toBeNull();
    expect((buttonB as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttonB);
    expect(apiMock).toHaveBeenCalledTimes(2);
    await act(async () => { resolveB({ leads: [{ id: "fresh", nome: "Lead atual", telefone: "5512", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], page: { has_more: false, next_cursor: null, limit: 50 } }); });
    expect(await screen.findByText("Lead atual")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carregar mais leads" })).toBeNull();
  });

  it.each(["success", "failure"])("discards stale column %s after filter changes", async (outcome) => {
    const user = await mounted();
    let resolveA!: (value: unknown) => void;
    let rejectA!: (reason: Error) => void;
    apiMock.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; }));
    await user.click(screen.getByRole("button", { name: "Mais na etapa" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Origem filtro" }), "instagram");
    await act(async () => {
      if (outcome === "failure") rejectA(new Error("Erro antigo da coluna"));
      else resolveA({ leads: [{ id: "stale", nome: "Lead antigo da coluna", telefone: "5511", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }], page: { has_more: false, next_cursor: null, limit: 50 } });
    });
    expect(screen.queryByText("Lead antigo da coluna")).toBeNull();
    expect(screen.queryByText("Erro antigo da coluna")).toBeNull();
  });

  it.each([
    ["list", false, "http"], ["list", true, "http"],
    ["column", false, "http"], ["column", true, "http"],
    ["list", false, "network"], ["list", true, "network"],
    ["column", false, "network"], ["column", true, "network"]
  ] as const)("real api: %s stale=%s %s failure stays scoped", async (mode, stale, failure) => {
    const { api: realApi } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    pagination.value = { next_cursor: "cursor-1", has_more: true, limit: 50 };
    const user = await mounted();
    if (mode === "list") await user.click(screen.getByRole("button", { name: "Lista" }));
    apiMock.mockImplementationOnce(realApi);
    const events = vi.fn();
    window.addEventListener("atendon:error", events);
    try {
      fireEvent.click(screen.getByRole("button", { name: mode === "list" ? "Carregar mais leads" : "Mais na etapa" }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (stale) await user.selectOptions(screen.getByRole("combobox", { name: "Origem filtro" }), "instagram");
      await act(async () => {
        if (failure === "network") reject(new Error("Falha R1"));
        else resolve(new Response(JSON.stringify({ error: "Falha R1" }), { status: 500, headers: { "content-type": "application/json" } }));
      });
      if (stale) expect(screen.queryByText("Falha R1")).toBeNull();
      else expect(await screen.findByText("Falha R1")).toBeTruthy();
      expect(events).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("atendon:error", events);
    }
  });

  it("ajuda do título aparece por hover sem texto ou botão adicional", async () => {
    const user = await mounted();
    const title = screen.getByRole("heading", { name: "Pipeline" });
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    expect(screen.queryByText("Pipeline e etapas")).toBeNull();
    await user.hover(title.querySelector("span")!);
    expect((await screen.findByRole("tooltip")).textContent).toContain("mudar de etapa aplica etiquetas e responsável");
  });

  it("keeps the selected responsible member in the stage payload", () => {
    expect(buildPipelineTransitionPayload({
      stage: { id: "stage-closed", name: "Venda", color: "#000000", position: 1, technical_status: "fechado", is_default: false },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      commercial: { sale_value: 100, sale_product: "Plano", sale_source: "Indicação", sale_channel: "WhatsApp", responsavel_member_id: "member-1" }
    }).commercial).toMatchObject({ responsavel_member_id: "member-1" });
  });
});

// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, canMoveState } = vi.hoisted(() => ({ apiMock: vi.fn(), canMoveState: { value: true } }));
apiMock.mockImplementation((url: string) => Promise.resolve(url === "/me" ? {
  user: { id: "user-1" }, activeWorkspace: { id: "workspace-1", timezone: "UTC" }, workspace_role: "owner"
} : url === "/organization/pipeline" ? { stages: [{ id: "stage-1", name: "Novo", technical_status: "novo", position: 1 }], transitions: [], follow_up_config: {} } : url.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", nome: "Ana", telefone: "5511999999999", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }] } : { members: [] }));
vi.mock("swr", () => ({ default: (key: string | null) => ({ data: key === "/me" ? { user: { id: "user-1" }, activeWorkspace: { id: "workspace-1", timezone: "UTC" }, workspace_role: "owner" } : key === "/organization/pipeline" ? { stages: [{ id: "stage-1", name: "Novo", technical_status: "novo", position: 1 }], transitions: [], follow_up_config: {} } : key?.startsWith("/scheduling/leads") ? { leads: [{ id: "lead-1", nome: "Ana", telefone: "5511999999999", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }] } : key === "/workspaces/current/members" ? { members: [] } : undefined, error: undefined, mutate: vi.fn(), isLoading: false }) }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (p: string) => p !== "leads.update_status" ? true : canMoveState.value }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/lib/session", () => ({ hasWorkspaceWideCaseScope: () => true, canAccessWithSession: () => true }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/pipeline-board", () => ({ PipelineBoard: () => <div data-testid="pipeline-board">Kanban board</div> }));
vi.mock("@/components/pipeline-filters", () => ({ PipelineFilters: () => null }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => null }));
vi.mock("@/components/pipeline-view-preferences", () => ({ PipelineViewPreferences: () => null }));
vi.mock("@/components/pipeline-settings", () => ({ PipelineSettings: () => null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/pipeline-transition-dialog", () => ({ PipelineTransitionDialog: () => null }));
vi.mock("@/components/page-state", () => ({ Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import PipelinePage from "../app/pipeline/page";
import { buildPipelineTransitionPayload } from "../lib/pipeline";

describe("pipeline view interactions", () => {
  beforeEach(() => { localStorage.clear(); apiMock.mockClear(); canMoveState.value = true; });
  afterEach(cleanup);
  async function mounted() { const user = userEvent.setup(); render(<PipelinePage />); await screen.findByText("Kanban board"); return user; }

  it("switches between Kanban and Lista with real clicks", async () => { const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(screen.getByRole("table")).toBeTruthy(); expect(screen.queryByTestId("pipeline-board")).toBeNull(); await user.click(screen.getByRole("button", { name: "Kanban" })); expect(screen.getByTestId("pipeline-board")).toBeTruthy(); });
  it("supports Tab plus Enter and Space keyboard activation", async () => { const user = await mounted(); await user.tab(); await user.tab(); await user.keyboard("{Enter}"); expect(screen.getByRole("table")).toBeTruthy(); for (let i = 0; i < 10 && document.activeElement !== screen.getByRole("button", { name: "Kanban" }); i++) await user.tab(); await user.keyboard(" "); expect(screen.getByTestId("pipeline-board")).toBeTruthy(); });
  it("omits Mover without permission", async () => { canMoveState.value = false; const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(screen.queryByRole("button", { name: "Mover" })).toBeNull(); });
  it("does not fetch when only the view changes", async () => { const user = await mounted(); const calls = apiMock.mock.calls.length; await user.click(screen.getByRole("button", { name: "Lista" })); await user.click(screen.getByRole("button", { name: "Kanban" })); expect(apiMock).toHaveBeenCalledTimes(calls); });
  it("persists and rereads the preference", async () => { const user = await mounted(); await user.click(screen.getByRole("button", { name: "Lista" })); expect(localStorage.getItem("atendon.pipeline.view:workspace-1:user-1")).toBe("list"); cleanup(); render(<PipelinePage />); expect(await screen.findByRole("table")).toBeTruthy(); });

  it("keeps the selected responsible member in the stage payload", () => {
    expect(buildPipelineTransitionPayload({
      stage: { id: "stage-closed", name: "Venda", color: "#000000", position: 1, technical_status: "fechado", is_default: false },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      commercial: { sale_value: 100, sale_product: "Plano", sale_source: "Indicação", sale_channel: "WhatsApp", responsavel_member_id: "member-1" }
    }).commercial).toMatchObject({ responsavel_member_id: "member-1" });
  });
});

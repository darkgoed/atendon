// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { PipelineLead, PipelineStage } from "../lib/pipeline";

const { apiMock, serverState } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  serverState: { stageOfA: "stage-1", afterPatchStage: "stage-2" }
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => null }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/pipeline-filters", () => ({ PipelineFilters: () => null }));
vi.mock("@/components/pipeline-manager", () => ({ PipelineManager: () => null }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => null }));
vi.mock("@/components/pipeline-view-preferences", () => ({ PipelineViewPreferences: () => null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/pipeline-transition-dialog", () => ({ PipelineTransitionDialog: () => null }));
// Quadro mínimo: uma coluna por etapa, cada card com um botão "Mover para <etapa>".
vi.mock("@/components/pipeline-board", () => ({
  PipelineBoard: ({ stages, leads, onMoveRequest }: {
    stages: PipelineStage[];
    leads: PipelineLead[];
    onMoveRequest: (lead: PipelineLead, target?: PipelineStage) => void;
  }) => (
    <div>
      {stages.map((stage) => (
        <section key={stage.id} aria-label={`Coluna ${stage.name}`}>
          {leads.filter((lead) => lead.pipeline_stage_id === stage.id).map((lead) => (
            <article key={lead.id}>
              <span>{lead.nome}</span>
              {stages.filter((target) => target.id !== stage.id).map((target) => (
                <button key={target.id} type="button" onClick={() => onMoveRequest(lead, target)}>{`Mover ${lead.nome} para ${target.name}`}</button>
              ))}
            </article>
          ))}
        </section>
      ))}
    </div>
  )
}));

import PipelinePage from "../app/pipeline/page";

const STAGES = [
  { id: "stage-1", name: "Novo", color: "#000", position: 1, technical_status: "novo", is_default: true },
  { id: "stage-2", name: "Atendimento", color: "#000", position: 2, technical_status: "em_atendimento", is_default: false },
  { id: "stage-3", name: "Qualificado", color: "#000", position: 3, technical_status: "qualificado", is_default: false }
];

const SESSION = {
  user: { id: "user-1", email: "a@b.c" },
  activeWorkspace: { id: "ws-1", timezone: "UTC" },
  workspaces: [],
  permissions: [],
  actorScope: "workspace"
};

beforeEach(() => {
  localStorage.clear();
  serverState.stageOfA = "stage-1";
  serverState.afterPatchStage = "stage-2";
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/me") return Promise.resolve(SESSION);
    if (path === "/organization/pipelines") return Promise.resolve({ pipelines: [], groups: [], channels: [] });
    if (path.startsWith("/organization/pipeline")) {
      return Promise.resolve({ stages: STAGES, transitions: [], enforce_transitions: false, follow_up_config: {} });
    }
    if (path === "/workspaces/current/members" || path === "/workspaces/current/member-directory") return Promise.resolve({ members: [] });
    if (path === "/organization/leads/lead-a/stage" && method === "PATCH") {
      // Automação da etapa (ou outro usuário) leva o lead adiante logo após o movimento.
      serverState.stageOfA = serverState.afterPatchStage;
      return Promise.resolve({ lead: { id: "lead-a" } });
    }
    if (path.startsWith("/scheduling/leads")) {
      const status = STAGES.find((stage) => stage.id === serverState.stageOfA)!.technical_status;
      return Promise.resolve({
        leads: [{ id: "lead-a", nome: "Aurora", telefone: "5511999999999", status, pipeline_stage_id: serverState.stageOfA, atualizado_em: "2026-01-01T00:00:00Z" }],
        total: 1,
        page: { has_more: false, next_cursor: null }
      });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("pipeline: card não fica preso após um movimento bem-sucedido (C6)", () => {
  it("mostra a etapa que o servidor devolve depois do movimento", async () => {
    serverState.afterPatchStage = "stage-3";
    const user = userEvent.setup();
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <PipelinePage />
      </SWRConfig>
    );
    await user.click(await screen.findByRole("button", { name: "Mover Aurora para Atendimento" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/leads/lead-a/stage", expect.objectContaining({ method: "PATCH" })));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Coluna Qualificado" })).queryByText("Aurora")).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Coluna Atendimento" })).queryByText("Aurora")).not.toBeInTheDocument();
  });

  it("mantém o card na etapa de destino quando o servidor confirma o movimento", async () => {
    const user = userEvent.setup();
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <PipelinePage />
      </SWRConfig>
    );
    await user.click(await screen.findByRole("button", { name: "Mover Aurora para Atendimento" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Coluna Atendimento" })).queryByText("Aurora")).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Coluna Novo" })).queryByText("Aurora")).not.toBeInTheDocument();
  });
});

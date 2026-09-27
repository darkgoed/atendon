// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineList } from "@/components/pipeline-list";
import type { PipelineLead } from "@/lib/pipeline";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
const { useWorkspaceCustomRange } = await import("@/lib/use-workspace-today");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  apiMock.mockReset();
});

describe("datas no fuso do workspace (auditoria painel P3-3/P3-4)", () => {
  it("período personalizado começa no dia do workspace, não no dia UTC", async () => {
    // 23:30 em São Paulo = 02:30 UTC do dia seguinte.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T02:30:00Z"));
    apiMock.mockResolvedValue({ user: { id: "u" }, activeWorkspace: { id: "w", timezone: "America/Sao_Paulo" }, permissions: [] });
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
    const { result } = renderHook(() => useWorkspaceCustomRange(), { wrapper });
    await waitFor(() => expect(result.current.customStart).toBe("2026-09-09"));
    expect(result.current.customEnd).toBe("2026-09-09");
  });

  it("lista do pipeline mostra a próxima ação no fuso do workspace", () => {
    const lead = { id: "l1", telefone: "5511999990000", nome: "Ana", status: "novo", atualizado_em: "2026-09-01T00:00:00Z", proxima_acao_em: "2026-09-10T13:00:00Z" } as PipelineLead;
    render(<PipelineList leads={[lead]} stages={[]} members={[]} legacy loading={false} canMove={false} canSelect={false}
      selectedIds={new Set()} pendingLeadIds={new Set()} onToggleSelected={() => undefined} onMoveRequest={() => undefined} timezone="Asia/Tokyo" />);
    expect(screen.getByText(/10\/09\/2026,? 22:00/)).toBeInTheDocument();
  });
});

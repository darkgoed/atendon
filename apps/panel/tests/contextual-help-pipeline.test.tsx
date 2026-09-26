// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("swr", () => ({ default: () => ({ data: undefined, error: undefined, mutate: vi.fn(), isLoading: false }) }));

// Radix Popper mede o balão do HelpHint com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

import { BulkLeadActions } from "@/components/bulk-lead-actions";
import { PipelineList } from "@/components/pipeline-list";
import { PipelineStageMenu } from "@/components/pipeline-stage-menu";
import { PipelineViewPreferences } from "@/components/pipeline-view-preferences";
import type { PipelineStage } from "@/lib/pipeline";

afterEach(() => { cleanup(); apiMock.mockReset(); });

function stage(overrides: Partial<PipelineStage>): PipelineStage {
  return { id: "s1", pipeline_id: "p1", name: "Proposta", color: "#3366cc", position: 10, technical_status: "em_negociacao", is_default: false, ...overrides } as PipelineStage;
}

describe("ajuda contextual do pipeline", () => {
  it("seleção em massa vira barra de modo com contagem, ações e Limpar", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<BulkLeadActions selected={[{ id: "l1" }, { id: "l2" }]} onClear={onClear} onChanged={vi.fn()} />);
    expect(screen.getByText("2 selecionado(s)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ações em lote (2)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Limpar/ }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("lista vazia ensina o próximo passo (ajustar ou limpar filtros)", () => {
    render(<PipelineList leads={[]} stages={[]} members={[]} legacy={false} loading={false} canMove={false} canSelect={false} selectedIds={new Set()} pendingLeadIds={new Set()} onToggleSelected={vi.fn()} onMoveRequest={vi.fn()} />);
    expect(screen.getByText("Nenhum lead corresponde aos filtros. Ajuste ou limpe os filtros para ver mais leads.")).toBeInTheDocument();
  });

  it("editar etapa traz ajuda para Comportamento e Meta de capacidade", async () => {
    const user = userEvent.setup();
    render(<PipelineStageMenu stage={stage({})} stages={[stage({})]} onChanged={vi.fn()} onMoveStage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Ações da etapa Proposta" }));
    await user.click(screen.getByRole("menuitem", { name: /Editar etapa/ }));
    expect(screen.getByRole("button", { name: "Ajuda: Comportamento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Meta de capacidade" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ajuda: Comportamento" }));
    expect(await screen.findByText(/dados da venda no Ganho, motivo da perda no Perdido/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/dados da venda no Ganho/)).toBeNull();
  });

  it("preferências de exibição explica os alertas auxiliares", async () => {
    const user = userEvent.setup();
    render(<PipelineViewPreferences value={{ density: "compact", visibleFields: [], auxiliaryBadges: [], columnWidth: 280 }} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Exibição" }));
    expect(screen.getByRole("button", { name: "Ajuda: Alertas auxiliares" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ajuda: Alertas auxiliares" }));
    expect(await screen.findByText(/reunião sem resultado registrado, no-show a recuperar/)).toBeInTheDocument();
  });
});

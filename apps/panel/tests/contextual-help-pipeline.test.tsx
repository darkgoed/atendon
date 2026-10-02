// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
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
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    const behavior = screen.getByRole("combobox", { name: "Comportamento" });
    await user.hover(screen.getByText("Comportamento", { selector: "label" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ganho pede dados da venda; Perdido, motivo; Negociação, Proposta e Follow-up, próxima ação com data.");
    await user.unhover(screen.getByText("Comportamento", { selector: "label" }));
    behavior.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Ganho pede dados da venda/);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    screen.getByRole("spinbutton", { name: "Meta de capacidade" }).focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Meta visual de preenchimento; não limita a entrada de leads.");
  });

  it("preferências de exibição explica os alertas auxiliares", async () => {
    const user = userEvent.setup();
    render(<PipelineViewPreferences value={{ density: "compact", visibleFields: [], auxiliaryBadges: [], columnWidth: 280 }} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Exibição" }));
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    const label = screen.getByText("Alertas auxiliares", { selector: "span[tabindex]" });
    expect(label).toHaveAttribute("tabindex", "0");
    await user.hover(label);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Avisos de reunião sem resultado, no-show a recuperar e follow-up atrasado.");
    await user.unhover(label);
    label.focus();
    expect(await screen.findByRole("tooltip")).toHaveClass("tooltip--compact");
    expect(screen.getAllByText("Alertas auxiliares", { selector: "legend span[tabindex]" })).toHaveLength(1);
  });

  it("cabeçalhos existentes da lista mostram ajuda sem botões extras", async () => {
    const user = userEvent.setup();
    render(<PipelineList leads={[{ id: "l1", nome: "Ana", telefone: "5511", status: "novo", atualizado_em: "2026-01-01T00:00:00Z" }]} stages={[]} members={[]} legacy={false} loading={false} canMove={false} canSelect={false} selectedIds={new Set()} pendingLeadIds={new Set()} onToggleSelected={vi.fn()} onMoveRequest={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Estágio atual" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Idade no estágio" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(screen.getByText("Estágio atual", { selector: "span[tabindex]" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("IA indica follow-up automático; Ligação e Manual indicam o tipo da etapa.");
    await user.unhover(screen.getByText("Estágio atual", { selector: "span[tabindex]" }));
    screen.getByText("Idade no estágio", { selector: "span[tabindex]" }).focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Tempo desde a última atualização do lead."));
  });

  it("automações usam legenda e controle reais para ajuda", async () => {
    apiMock.mockResolvedValue({ tags: [], members: [] });
    const user = userEvent.setup();
    render(<PipelineStageMenu stage={stage({})} stages={[stage({})]} onChanged={vi.fn()} onMoveStage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Ações da etapa Proposta" }));
    await user.click(screen.getByRole("menuitem", { name: /Automações e regras/ }));
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(screen.getByText("Etiquetas ao entrar", { selector: "span[tabindex]" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Aplica estas etiquetas a todo lead que entrar nesta etapa.");
    await user.unhover(screen.getByText("Etiquetas ao entrar", { selector: "span[tabindex]" }));
    const responsible = within(screen.getByRole("dialog")).getByRole("combobox", { name: "Responsável ao entrar" });
    responsible.focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Atribui leads ao entrar; sem escolha, mantém o responsável atual."));
  });
});

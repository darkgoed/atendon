// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PIPELINE_PREFERENCES, type PipelineLead, type PipelineStage } from "@/lib/pipeline";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("swr", () => ({ default: () => ({ data: undefined, error: undefined, mutate: vi.fn(), isLoading: false }) }));

import { PipelineBoard } from "@/components/pipeline-board";

function stage(id: string, name: string, overrides: Partial<PipelineStage> = {}): PipelineStage {
  return { id, name, color: "#3B82F6", position: 0, technical_status: "em_atendimento", is_default: false, lead_count: 0, ...overrides } as PipelineStage;
}

const STAGES = [
  stage("s1", "Primeiro contato", { technical_status: "novo", lead_count: 1 }),
  stage("s2", "Qualificação"),
  stage("ai", "Follow-up 1", { operational_kind: "ai_follow_up" }),
  stage("s3", "Pago")
];
const LEADS = [{ id: "l1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z", pipeline_stage_id: "s1" } as PipelineLead];

function renderBoard(manage: boolean, onStagesChanged = vi.fn()) {
  render(<PipelineBoard
    stages={STAGES}
    leads={LEADS}
    allowedTransitions={new Set()}
    legacy={false}
    loading={false}
    hasActiveFilters={false}
    canMove
    canSelect={false}
    selectedIds={new Set()}
    pendingLeadIds={new Set()}
    preferences={DEFAULT_PIPELINE_PREFERENCES}
    timezone="UTC"
    onToggleSelected={() => undefined}
    onMoveRequest={() => undefined}
    onRetry={() => undefined}
    pipelineId="p1"
    manageStages={manage}
    onStagesChanged={onStagesChanged}
  />);
  return onStagesChanged;
}

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}

afterEach(() => { cleanup(); apiMock.mockReset(); });

describe("etapas configuráveis no quadro", () => {
  it("sem pipeline.manage: sem menu ⋯, sem alça e sem coluna nova; nada de #10/Ordem", () => {
    renderBoard(false);
    expect(screen.queryByRole("button", { name: /Ações da etapa/ })).toBeNull();
    expect(screen.queryByLabelText(/Reordenar etapa/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Nova etapa/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/#\d+|Ordem/);
  });

  it("duplica a etapa pela rota da etapa", async () => {
    apiMock.mockResolvedValue({ stage: {} });
    const onChanged = renderBoard(true);
    await userEvent.click(screen.getByRole("button", { name: "Ações da etapa Qualificação" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Duplicar/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline/stages/s2/duplicate", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("'Mover para a direita' persiste a nova ordem sem colunas operacionais de IA", async () => {
    apiMock.mockResolvedValue({ stages: [] });
    renderBoard(true);
    expect(screen.queryByRole("button", { name: "Ações da etapa Follow-up 1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ações da etapa Qualificação" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Mover para a direita/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls[0]![0]).toBe("/organization/pipelines/p1/stages/order");
    expect(bodyOf(apiMock.mock.calls[0]!)).toEqual({ stage_ids: ["s1", "s3", "s2"] });
  });

  it("arrastar a alça de uma etapa e soltar sobre outra reordena", async () => {
    apiMock.mockResolvedValue({ stages: [] });
    renderBoard(true);
    const grip = screen.getByLabelText("Reordenar etapa Pago");
    const target = screen.getByRole("region", { name: /^Primeiro contato,/ });
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(grip, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(bodyOf(apiMock.mock.calls[0]!)).toEqual({ stage_ids: ["s3", "s1", "s2"] });
  });

  it("excluir etapa com contatos exige a etapa que recebe os contatos", async () => {
    apiMock.mockResolvedValue({ archived: true });
    renderBoard(true);
    await userEvent.click(screen.getByRole("button", { name: "Ações da etapa Primeiro contato" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Excluir etapa/ }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^Excluir$/ });
    const select = within(dialog).getByRole("combobox", { name: /receberá os contatos/ });
    if ((select as HTMLSelectElement).value === "") expect(confirm).toBeDisabled();
    expect(within(select).queryByRole("option", { name: "Follow-up 1" })).toBeNull();
    await userEvent.selectOptions(select, "s2");
    await userEvent.click(confirm);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline/stages/s1/archive", expect.objectContaining({ method: "POST" })));
    expect(bodyOf(apiMock.mock.calls[0]!)).toEqual({ replacement_stage_id: "s2" });
  });

  it("'+ Nova etapa' + Enter cria no pipeline ativo", async () => {
    apiMock.mockResolvedValue({ stage: {} });
    renderBoard(true);
    await userEvent.click(screen.getByRole("button", { name: /Nova etapa/ }));
    await userEvent.type(screen.getByLabelText("Nome da nova etapa"), "Aguardando pagamento{Enter}");
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline/stages", expect.objectContaining({ method: "POST" })));
    expect(bodyOf(apiMock.mock.calls[0]!)).toMatchObject({ pipeline_id: "p1", name: "Aguardando pagamento" });
    expect(bodyOf(apiMock.mock.calls[0]!)).not.toHaveProperty("position");
  });
});

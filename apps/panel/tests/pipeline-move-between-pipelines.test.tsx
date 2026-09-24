// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineLead, PipelineStage, PipelineSummary } from "@/lib/pipeline";

const swrData = vi.hoisted(() => ({ pipelines: [] as PipelineSummary[] }));
vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "/organization/pipelines"
      ? { pipelines: swrData.pipelines }
      : key === "/organization/pipeline?pipeline_id=p2"
        ? { stages: [
          { id: "v1", pipeline_id: "p2", name: "Primeiro contato", color: "#000000", position: 0, technical_status: "novo", is_default: true },
          { id: "v2", pipeline_id: "p2", name: "Oferta", color: "#000000", position: 1, technical_status: "em_atendimento", is_default: false }
        ] }
        : undefined
  })
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("@/lib/loss-reasons", () => ({ useLossReasons: () => ({ reasons: [], error: null }), lossReasonRequiresNote: () => false }));

import { PipelineTransitionDialog } from "@/components/pipeline-transition-dialog";

function pipeline(id: string, name: string, isDefault: boolean): PipelineSummary {
  return { id, name, color: "#3B82F6", position: 0, is_default: isDefault, enforce_transitions: false, stage_count: 2, lead_count: 1, channel_ids: [] };
}

const lead = { id: "lead-1", telefone: "5511999999999", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T00:00:00Z", pipeline_stage_id: "b1" } as PipelineLead;
const targets: PipelineStage[] = [
  { id: "b2", pipeline_id: "p1", name: "Análise", color: "#000000", position: 1, technical_status: "em_atendimento", is_default: false }
];

function renderDialog(onSubmit = vi.fn()) {
  render(<PipelineTransitionDialog lead={lead} targets={targets} pending={false} timezone="UTC" onClose={vi.fn()} onSubmit={onSubmit} />);
  return onSubmit;
}

afterEach(() => { cleanup(); });

describe("mover contato para outro pipeline", () => {
  it("com um único pipeline o seletor de pipeline não aparece", () => {
    swrData.pipelines = [pipeline("p1", "Boleto", true)];
    renderDialog();
    expect(screen.queryByRole("combobox", { name: "Pipeline" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Etapa de destino" })).toBeInTheDocument();
  });

  it("com dois pipelines, escolher o outro lista as etapas dele e envia a etapa escolhida", async () => {
    swrData.pipelines = [pipeline("p1", "Boleto", true), pipeline("p2", "À Vista", false)];
    const onSubmit = renderDialog();
    const pipelineSelect = screen.getByRole("combobox", { name: "Pipeline" });
    expect(pipelineSelect).toHaveValue("p1");
    await userEvent.selectOptions(pipelineSelect, "p2");
    expect(screen.getByText("O contato sai de Boleto e entra em À Vista.")).toBeInTheDocument();
    const stageSelect = screen.getByRole("combobox", { name: "Etapa de destino" });
    await waitFor(() => expect(stageSelect.querySelectorAll("option")).toHaveLength(2));
    await userEvent.selectOptions(stageSelect, "v2");
    await userEvent.click(screen.getByRole("button", { name: /Mover|Confirmar|Salvar/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ id: "v2", pipeline_id: "p2" });
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineChannelLink, PipelineSummary } from "@/lib/pipeline";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

import { PipelineManager } from "@/components/pipeline-manager";

function pipeline(overrides: Partial<PipelineSummary>): PipelineSummary {
  return { id: "p1", name: "Boleto", color: "#3B82F6", position: 0, is_default: true, enforce_transitions: false, stage_count: 3, lead_count: 0, channel_ids: [], ...overrides };
}

const pipelines = [pipeline({}), pipeline({ id: "p2", name: "À Vista", color: "#22C55E", position: 1, is_default: false, lead_count: 4 })];
const channels: PipelineChannelLink[] = [
  { id: "s1", label: "WhatsApp A", channel: "whatsapp", phone_number: "5511911110000", pipeline_id: null },
  { id: "s2", label: "WhatsApp B", channel: "whatsapp", phone_number: "5511922220000", pipeline_id: "p2" }
];

afterEach(() => { cleanup(); apiMock.mockReset(); });

describe("PipelineManager", () => {
  it("mostra o pipeline ativo e troca de pipeline pelo seletor", async () => {
    const onSelect = vi.fn();
    render(<PipelineManager pipelines={pipelines} activePipeline={pipelines[0]!} canManage={false} onSelect={onSelect} onChanged={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /Pipeline ativo: Boleto/ });
    expect(trigger).toHaveTextContent("Boleto");
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /Boleto/ })).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("menuitem", { name: /À Vista/ }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("sem pipeline.manage não há menu ⋯ nem 'Novo pipeline'", async () => {
    render(<PipelineManager pipelines={pipelines} activePipeline={pipelines[0]!} canManage={false} onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Ações do pipeline" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Pipeline ativo/ }));
    expect(screen.queryByRole("menuitem", { name: /Novo pipeline/ })).toBeNull();
  });

  it("canais vinculados: envia PUT com os canais marcados", async () => {
    apiMock.mockResolvedValue({ pipeline_id: "p1", session_ids: ["s1", "s2"] });
    const onChanged = vi.fn();
    render(<PipelineManager pipelines={pipelines} activePipeline={pipelines[0]!} channels={channels} canManage onSelect={vi.fn()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Ações do pipeline" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Canais vinculados/ }));
    expect(screen.getByText("hoje em À Vista")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /WhatsApp A/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /WhatsApp B/ }));
    await userEvent.click(screen.getByRole("button", { name: /Salvar canais/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [url, init] = apiMock.mock.calls[0]!;
    expect(url).toBe("/organization/pipelines/p1/channels");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body).session_ids.sort()).toEqual(["s1", "s2"]);
  });

  it("excluir pipeline com contatos exige o pipeline que recebe os contatos", async () => {
    apiMock.mockResolvedValue({ id: "p2", archived: true, moved_leads: 4 });
    const onSelect = vi.fn();
    render(<PipelineManager pipelines={pipelines} activePipeline={pipelines[1]!} canManage onSelect={onSelect} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Ações do pipeline" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Excluir pipeline/ }));
    const confirm = screen.getByRole("button", { name: /^Excluir$/ });
    const select = screen.getByRole("combobox", { name: /receberá os contatos/ });
    if ((select as HTMLSelectElement).value === "") expect(confirm).toBeDisabled();
    await userEvent.selectOptions(select, "p1");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines/p2/archive", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ replacement_pipeline_id: "p1" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("p1"));
  });
});

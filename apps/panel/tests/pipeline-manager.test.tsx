// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineChannelLink, PipelineGroup, PipelineSummary } from "@/lib/pipeline";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

import { PipelineManager } from "@/components/pipeline-manager";

function pipeline(overrides: Partial<PipelineSummary>): PipelineSummary {
  return { id: "p1", name: "Boleto", color: "#3B82F6", position: 0, is_default: true, enforce_transitions: false, stage_count: 3, lead_count: 0, channel_ids: [], ...overrides };
}

function group(id: string, name: string, position: number): PipelineGroup {
  return { id, name, position };
}

const pipelines = [pipeline({}), pipeline({ id: "p2", name: "À Vista", color: "#22C55E", position: 1, is_default: false, lead_count: 4 })];
const channels: PipelineChannelLink[] = [
  { id: "s1", label: "WhatsApp A", channel: "whatsapp", phone_number: "5511911110000", pipeline_id: null },
  { id: "s2", label: "WhatsApp B", channel: "whatsapp", phone_number: "5511922220000", pipeline_id: "p2" }
];

const groups = [group("g1", "Comercial", 0), group("g2", "Pós-venda", 1)];
const groupedPipelines = [
  pipeline({ id: "p1", name: "Boleto", group_id: "g1" }),
  pipeline({ id: "p2", name: "À Vista", color: "#22C55E", position: 1, is_default: false, lead_count: 4, group_id: "g1" }),
  pipeline({ id: "p3", name: "Renovação", color: "#F59E0B", position: 2, is_default: false, group_id: "g2" }),
  pipeline({ id: "p4", name: "Extra", color: "#EF4444", position: 3, is_default: false })
];

const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" };

function renderManager(overrides: { pipelines?: PipelineSummary[]; groups?: PipelineGroup[]; canManage?: boolean; onChanged?: ReturnType<typeof vi.fn>; active?: PipelineSummary } = {}) {
  return render(
    <PipelineManager
      pipelines={overrides.pipelines ?? groupedPipelines}
      groups={overrides.groups ?? groups}
      activePipeline={overrides.active ?? (overrides.pipelines ?? groupedPipelines)[0]!}
      canManage={overrides.canManage ?? true}
      onSelect={vi.fn()}
      onChanged={overrides.onChanged ?? vi.fn()}
    />
  );
}

async function openSelector() {
  await userEvent.click(screen.getByRole("button", { name: /Pipeline ativo: Boleto/ }));
}

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

  it("permite pesquisar pipelines mesmo antes de criar grupos", async () => {
    render(<PipelineManager pipelines={pipelines} activePipeline={pipelines[0]!} canManage={false} onSelect={vi.fn()} onChanged={vi.fn()} />);
    await openSelector();
    await userEvent.type(screen.getByLabelText("Buscar pipeline ou grupo"), "vista");
    expect(screen.queryByRole("menuitem", { name: /Boleto/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /À Vista/ })).toBeInTheDocument();
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

describe("PipelineManager — grupos", () => {
  it("lista grupos com expandir/recolher e seção Sem grupo", async () => {
    renderManager({ canManage: false });
    await openSelector();
    const toggle = screen.getByRole("button", { name: /^Comercial/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /Boleto/ })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: /Boleto/ })).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole("menuitem", { name: /Boleto/ })).toBeInTheDocument();
    expect(screen.getByText("Sem grupo")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Extra/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Renovação/ })).toBeInTheDocument();
  });

  it("busca filtra por nome de grupo OU pipeline sem alterar o colapso", async () => {
    renderManager({ canManage: false });
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: /^Comercial/ }));
    expect(screen.queryByRole("menuitem", { name: /Boleto/ })).toBeNull();
    const input = screen.getByLabelText("Buscar pipeline ou grupo");
    await userEvent.type(input, "boleto");
    expect(screen.getByRole("menuitem", { name: /Boleto/ })).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "Pós-venda");
    expect(screen.getByRole("menuitem", { name: /Renovação/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Boleto/ })).toBeNull();
    await userEvent.clear(input);
    expect(screen.queryByRole("menuitem", { name: /Boleto/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Extra/ })).toBeInTheDocument();
  });

  it("cria grupo pelo botão Novo grupo", async () => {
    apiMock.mockResolvedValue({ id: "g3", name: "Novos", position: 2 });
    const onChanged = vi.fn();
    renderManager({ onChanged });
    await openSelector();
    await userEvent.click(screen.getByRole("menuitem", { name: /Novo grupo/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Nome"), "Novos");
    await userEvent.click(within(dialog).getByRole("button", { name: "Criar grupo" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline-groups", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ name: "Novos" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("renomeia grupo pelo menu ⋯ do grupo", async () => {
    apiMock.mockResolvedValue({ id: "g1", name: "Vendas" });
    renderManager({});
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do grupo Comercial" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Renomear grupo/ }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Nome");
    await userEvent.clear(input);
    await userEvent.type(input, "Vendas");
    await userEvent.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline-groups/g1", expect.objectContaining({ method: "PATCH" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ name: "Vendas" });
  });

  it("arquivar grupo confirma que os pipelines ficam sem grupo", async () => {
    apiMock.mockResolvedValue({ archived: true });
    const onChanged = vi.fn();
    renderManager({ onChanged });
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do grupo Pós-venda" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Arquivar grupo/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/ficam sem grupo/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /^Arquivar$/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline-groups/g2/archive", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("cria pipeline dentro do grupo passando group_id", async () => {
    apiMock.mockResolvedValue({ pipeline: { id: "p9" } });
    renderManager({});
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do grupo Comercial" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Novo pipeline neste grupo/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Nome"), "Upsell");
    await userEvent.click(within(dialog).getByRole("button", { name: "Criar pipeline" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ name: "Upsell", color: "#64748B", group_id: "g1" });
  });

  it("move pipeline para outro grupo pelo menu (PATCH group_id)", async () => {
    apiMock.mockResolvedValue({ id: "p1", group_id: "g2" });
    renderManager({});
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do pipeline Boleto" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Mover para grupo/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: /Grupo/ }), "g2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mover" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines/p1", expect.objectContaining({ method: "PATCH" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ group_id: "g2" });
  });

  it("arrastar grupo sobre outro reordena com PUT de todos os ids", async () => {
    apiMock.mockResolvedValue({});
    renderManager({});
    await openSelector();
    fireEvent.dragStart(screen.getByLabelText("Reordenar grupo Comercial"), { dataTransfer });
    const target = screen.getByText("Pós-venda").closest(".pipeline-switcher__group")!;
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipeline-groups/order", expect.objectContaining({ method: "PUT" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ group_ids: ["g2", "g1"] });
  });

  it("arrastar pipeline sobre outro reordena com a lista completa", async () => {
    apiMock.mockResolvedValue({});
    renderManager({});
    await openSelector();
    fireEvent.dragStart(screen.getByLabelText("Mover pipeline Boleto"), { dataTransfer });
    const target = screen.getByRole("menuitem", { name: /À Vista/ }).closest(".pipeline-switcher__row")!;
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines/order", expect.objectContaining({ method: "PUT" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ pipeline_ids: ["p2", "p1", "p3", "p4"] });
  });

  it("arrastar pipeline sobre outro grupo move com PATCH", async () => {
    apiMock.mockResolvedValue({ id: "p1", group_id: "g2" });
    renderManager({});
    await openSelector();
    fireEvent.dragStart(screen.getByLabelText("Mover pipeline Boleto"), { dataTransfer });
    const target = screen.getByText("Pós-venda").closest(".pipeline-switcher__group")!;
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines/p1", expect.objectContaining({ method: "PATCH" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ group_id: "g2" });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("menu do pipeline tem subir/descer equivalente ao drag", async () => {
    apiMock.mockResolvedValue({});
    renderManager({});
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do pipeline À Vista" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Mover para cima/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/organization/pipelines/order", expect.objectContaining({ method: "PUT" })));
    expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toEqual({ pipeline_ids: ["p2", "p1", "p3", "p4"] });
  });

  it("sem permissão não mostra mutações, mas a busca segue", async () => {
    renderManager({ canManage: false });
    await openSelector();
    expect(screen.queryByLabelText("Reordenar grupo Comercial")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ações do grupo Comercial" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Novo grupo/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ações do pipeline Boleto" })).toBeNull();
    expect(screen.getByLabelText("Buscar pipeline ou grupo")).toBeInTheDocument();
  });

  it("falha na ordenação mantém dados do servidor e avisa localmente", async () => {
    apiMock.mockRejectedValue(new Error("Sem permissão"));
    const onChanged = vi.fn();
    renderManager({ onChanged });
    await openSelector();
    await userEvent.click(screen.getByRole("button", { name: "Ações do pipeline À Vista" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Mover para cima/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem permissão");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Ordem salva")).toBeNull();
  });
});

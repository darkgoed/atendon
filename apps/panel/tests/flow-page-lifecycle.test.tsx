// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* Ciclo de vida das páginas /fluxos e /fluxos/[id]: identidade de rota
   (A→B→A) e respostas tardias, erro do GET (SWR), recarregar vs. salvar,
   saves no mesmo tick. SWR REAL (não mockado) — o cache entre trocas de id
   é parte do cenário (o retorno a A mostra o documento do cache). */

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem). */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  flowId: "lifecycle-base",
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("@/components/shell", () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/lib/use-permission", () => ({
  usePermission: () => true,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: mocks.flowId }),
}));

import { ApiError } from "@/lib/api";
import { normalizeDefinition } from "@/components/flow-editor/flow-model";
import FluxoEditorPage from "@/app/fluxos/[id]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* Definition fixo — válido no schema do backend (mesmo do flow-editor.test). */
const FIXTURE = normalizeDefinition({
  start: "P1",
  origem: "facebook",
  intro: "Olá! Vamos começar.",
  triggers: { ctwa: true, session_ids: [], keywords: ["oi"] },
  steps: {
    P1: {
      kind: "options",
      question: "Qual é o seu nicho?",
      field: "nicho",
      options: [{ value: "Ótica" }, { value: "Outros" }],
      transitions: { "Ótica": "E1" },
      next: "P2",
    },
    P2: {
      kind: "boolean",
      question: "Tem investimentos para crescer?",
      options: [{ value: "SIM" }, { value: "NÃO" }],
      transitions: { "SIM": "E1", "NÃO": "E2" },
    },
    E1: { kind: "final", message: "Perfeito! Em breve falamos com você." },
    E2: { kind: "final", message: "Obrigado pelo contato!" },
  },
});

const CONFLICT_REVISAO = (revisao: number) =>
  new ApiError("Conflito de versão do fluxo — recarregue a revisão atual e tente novamente", 409, {
    error: "Conflito de versão do fluxo — recarregue a revisão atual e tente novamente",
    code: "FLOW_VERSION_CONFLICT",
    revisao,
  });

const flowGet = (flowId: string, revisao: number | undefined, nome = "Fluxo A") =>
  Promise.resolve({ flow: { id: flowId, nome, ativo: true, definition: FIXTURE, revisao, atualizado_em: null } });

const inputNome = () => screen.getByLabelText("Nome do fluxo") as HTMLInputElement;
const saveButton = () => screen.getByTestId("flow-save") as HTMLButtonElement;
const putCalls = (flowPath: string) => mocks.api.mock.calls.filter(([path, init]) => path === flowPath && init?.method === "PUT");
const getFlowCalls = (flowPath: string) => mocks.api.mock.calls.filter(([path, init]) => path === flowPath && (!init || !init.method));
const putBody = (flowPath: string, index: number) => JSON.parse(String(putCalls(flowPath)[index]?.[1]?.body));

describe("ciclo de vida do editor (/fluxos/[id]) — identidade de rota e respostas tardias", () => {
  it("resposta do PUT que atravessou A→B→A é morta: sem 'Salvo' sobre o cache desatualizado e o save seguinte usa o token antigo (409 seguro)", async () => {
    const idA = "lifecycle-aba";
    const idB = "lifecycle-aba-destino";
    const pathA = `/qualification/flows/${idA}`;
    const pathB = `/qualification/flows/${idB}`;
    let resolverPut: (value: unknown) => void = () => {};
    let putCount = 0;
    mocks.flowId = idA;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === pathA && (!init || !init.method)) return flowGet(idA, 5, "Fluxo A");
      if (path === pathB && (!init || !init.method)) return flowGet(idB, 2, "Fluxo B");
      if (path === pathA && init?.method === "PUT") {
        putCount += 1;
        if (putCount === 1) return new Promise((resolve) => { resolverPut = resolve; }); // PUT de A em voo
        return Promise.reject(CONFLICT_REVISAO(6)); // o 1º PUT gravou: servidor está na revisão 6
      }
      return Promise.resolve({});
    });
    const { rerender } = render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.change(inputNome(), { target: { value: "Nome B rascunho" } }); // rascunho que o PUT leva
    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls(pathA)).toHaveLength(1));
    expect(putBody(pathA, 0).nome).toBe("Nome B rascunho");

    mocks.flowId = idB; // A → B
    rerender(<FluxoEditorPage />);
    await waitFor(() => expect(inputNome()).toHaveValue("Fluxo B"));
    mocks.flowId = idA; // B → A: documento volta do CACHE do SWR (pré-save)
    rerender(<FluxoEditorPage />);
    await waitFor(() => expect(inputNome()).toHaveValue("Fluxo A"));

    await act(async () => { resolverPut({ flow: { revisao: 6 } }); }); // resposta tardia do PUT de A
    await act(async () => { await Promise.resolve(); });

    // A resposta atravessou duas trocas de rota: o documento na tela é o do
    // cache, não o que foi salvo — marcar "Salvo"/limpar dirty seria mentira.
    expect(screen.queryByText("Salvo")).toBeNull();
    // Save seguinte envia o token do cache (5), não o da resposta tardia (6):
    // o servidor responde 409 e o modal orienta a recarga — nunca silencioso.
    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls(pathA)).toHaveLength(2));
    expect(putBody(pathA, 1).revisao_base).toBe(5);
    await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });
    mocks.flowId = "lifecycle-base";
  });

  it("restauro no histórico durante save em voo: resposta do save é morta (sem toast 'Fluxo salvo'), o botão fica bloqueado até a recarga adotar o servidor", async () => {
    const flowId = "lifecycle-restauro-save";
    const flowPath = `/qualification/flows/${flowId}`;
    const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let getCalls = 0;
    let putCount = 0;
    let resolverPut: (value: unknown) => void = () => {};
    let resolverReload: (value: unknown) => void = () => {};
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        getCalls += 1;
        if (getCalls === 1) return flowGet(flowId, 5);
        return new Promise((resolve) => { resolverReload = resolve; }); // recarga do restauro
      }
      if (path === flowPath && init?.method === "PUT") {
        putCount += 1;
        if (putCount === 1) return new Promise((resolve) => { resolverPut = resolve; }); // save em voo
        return Promise.resolve({ flow: { revisao: 13 } });
      }
      if (path === `${flowPath}/versions`) {
        return Promise.resolve({ versions: [{ id: VERSION_ID, version: 3, flow_name: "Versão antiga", created_by: null, created_at: "2026-09-01T10:00:00Z" }], next_cursor: null });
      }
      if (path === `${flowPath}/versions/${VERSION_ID}/restore` && init?.method === "POST") {
        return Promise.resolve({ flow: { revisao: 2 }, restored_from: 3, version: 4 });
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.change(inputNome(), { target: { value: "Rascunho do save" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(1)); // PUT em voo

    fireEvent.click(screen.getByRole("button", { name: "Histórico" }));
    fireEvent.click(await screen.findByTestId(`flow-history-restore-3`));
    fireEvent.click(await screen.findByTestId("flow-history-confirm")); // restaura → onRestored → recarga
    await waitFor(() => expect(getFlowCalls(flowPath)).toHaveLength(2)); // recarga pendente
    expect(saveButton().disabled).toBe(true); // botão travado enquanto a recarga adota o servidor

    await act(async () => { resolverPut({ flow: { revisao: 6 } }); }); // resposta do save DURANTE a recarga
    await act(async () => { await Promise.resolve(); });

    // A tela virou unidade da recarga: a resposta do save atravessou essa
    // virada e morre — sem toast de sucesso nem liberação do botão.
    expect(screen.queryByText("Fluxo salvo")).toBeNull();
    expect(saveButton().disabled).toBe(true);

    await act(async () => { resolverReload({ flow: { id: flowId, nome: "Versão restaurada", ativo: true, definition: FIXTURE, revisao: 12, atualizado_em: null } }); });
    await waitFor(() => expect(inputNome()).toHaveValue("Versão restaurada")); // unidade adotada
    expect(saveButton().disabled).toBe(false); // recarga concluída: o dono da trava liberou

    fireEvent.click(saveButton()); // token fresco da recarga (12)
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(2));
    expect(putBody(flowPath, 1).revisao_base).toBe(12);
    await screen.findByText("Salvo");
    mocks.flowId = "lifecycle-base";
  });

  it("edição durante a recarga: rascunho preservado, revisão do servidor NÃO adotada e o próximo save toma 409 seguro", async () => {
    const flowId = "lifecycle-reload-edicao";
    const flowPath = `/qualification/flows/${flowId}`;
    let getCalls = 0;
    let resolverReload: (value: unknown) => void = () => {};
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        getCalls += 1;
        if (getCalls === 1) return flowGet(flowId, 5);
        return new Promise((resolve) => { resolverReload = resolve; });
      }
      if (path === flowPath && init?.method === "PUT") return Promise.reject(CONFLICT_REVISAO(9));
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.change(inputNome(), { target: { value: "Rascunho 1" } }); // rascunho antes do 409
    fireEvent.click(saveButton());
    await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });

    fireEvent.click(screen.getByTestId("flow-conflict-reload"));
    await waitFor(() => expect(getFlowCalls(flowPath)).toHaveLength(2)); // recarga pendente
    fireEvent.change(inputNome(), { target: { value: "Rascunho 2" } }); // edição DURANTE a recarga

    await act(async () => { resolverReload({ flow: { id: flowId, nome: "Fluxo no servidor", ativo: true, definition: FIXTURE, revisao: 9, atualizado_em: null } }); });
    await waitFor(() => expect(inputNome()).toHaveValue("Rascunho 2")); // rascunho NÃO descartado
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("alterações feitas durante a recarga"));

    // Revisão+documento são uma unidade: com edição no meio, NADA é adotado —
    // o token velho (5) fica e o próximo save toma 409 em vez de mascarar.
    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(2));
    expect(putBody(flowPath, 1).revisao_base).toBe(5);
    expect(putBody(flowPath, 1).nome).toBe("Rascunho 2");
    await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });
    mocks.flowId = "lifecycle-base";
  });

  it("dois cliques de Salvar no mesmo tick enviam um único PUT (trava síncrona por ref)", async () => {
    const flowId = "lifecycle-save-duplo";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) return flowGet(flowId, 5);
      if (path === flowPath && init?.method === "PUT") return new Promise(() => undefined); // nunca resolve
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(saveButton());
    fireEvent.click(saveButton()); // mesmo tick: savingRef já está true
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(1));
    // um tick depois, de novo: a trava persiste até a resposta do 1º
    fireEvent.click(saveButton());
    await act(async () => { await Promise.resolve(); });
    expect(putCalls(flowPath)).toHaveLength(1);
    mocks.flowId = "lifecycle-base";
  });
});

describe("ciclo de vida do editor (/fluxos/[id]) — erro do GET (SWR)", () => {
  it("falha do GET inicial (500) mostra erro de carregamento, não 'Fluxo não encontrado'", async () => {
    const flowId = "lifecycle-get-erro";
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${flowId}` && (!init || !init.method)) {
        return Promise.reject(new ApiError("Falha do servidor", 500));
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // O fluxo pode existir: a página não pode afirmar que não existe.
    expect(screen.getByRole("alert").textContent).toBe("Não foi possível carregar o fluxo.");
    mocks.flowId = "lifecycle-base";
  });

  it("404 do GET inicial mantém 'Fluxo não encontrado.'", async () => {
    const flowId = "lifecycle-get-404";
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${flowId}` && (!init || !init.method)) {
        return Promise.reject(new ApiError("Fluxo não encontrado", 404, { error: "Fluxo não encontrado" }));
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toBe("Fluxo não encontrado.");
    mocks.flowId = "lifecycle-base";
  });
});

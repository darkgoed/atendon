// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem) —
   stub mínimo antes de qualquer render (mesmo do flow-history.test.tsx). */
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
  flowId: "conc-base",
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

// Ícones: módulo real (components/icons.tsx é leve — só SVG do lucide).

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

const inputNome = () => screen.getByLabelText("Nome do fluxo") as HTMLInputElement;
const saveButton = () => screen.getByTestId("flow-save") as HTMLButtonElement;
const putCalls = (flowPath: string) => mocks.api.mock.calls.filter(([path, init]) => path === flowPath && init?.method === "PUT");
const getFlowCalls = (flowPath: string) => mocks.api.mock.calls.filter(([path, init]) => path === flowPath && (!init || !init.method));
const putBody = (flowPath: string, index: number) => JSON.parse(String(putCalls(flowPath)[index]?.[1]?.body));

function dispatchBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("editor de fluxo — concorrência UI (WP-E1)", () => {
  it("reload após 409 com GET atrasado adota a revisão NOVA e o save seguinte envia ela; save bloqueado durante a recarga", async () => {
    const flowId = "conc-reload-409";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    let resolverGet2: (value: unknown) => void = () => {};
    let getCalls = 0;
    let putCallsCount = 0;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        getCalls += 1;
        if (getCalls === 1) {
          return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: 5, atualizado_em: null } });
        }
        return new Promise((resolve) => { resolverGet2 = resolve; }); // GET #2 atrasado
      }
      if (path === flowPath && init?.method === "PUT") {
        putCallsCount += 1;
        if (putCallsCount === 1) return Promise.reject(CONFLICT_REVISAO(9));
        return Promise.resolve({ flow: { revisao: 10 } });
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("flow-save")); // revisao_base 5 → 409
    await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });

    fireEvent.click(screen.getByTestId("flow-conflict-reload")); // onReload → mutate (GET #2 pendente)
    await waitFor(() => expect(getFlowCalls(flowPath)).toHaveLength(2));
    await act(async () => { await Promise.resolve(); }); // flush de renders
    expect(saveButton().disabled).toBe(true); // save DESABILITADO enquanto a recarga está pendente

    await act(async () => { resolverGet2({ flow: { id: flowId, nome: "Fluxo no servidor", ativo: true, definition: FIXTURE, revisao: 9, atualizado_em: null } }); });
    await waitFor(() => expect(inputNome()).toHaveValue("Fluxo no servidor")); // documento+revisão adotados JUNTOS
    expect(saveButton().disabled).toBe(false); // recarga concluída: save volta
    expect(screen.queryByRole("dialog", { name: "Fluxo alterado por outro salvamento" })).toBeNull();

    fireEvent.click(screen.getByTestId("flow-save"));
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(2));
    expect(putBody(flowPath, 1).revisao_base).toBe(9); // revisão NOVA, não a antiga (5)
    mocks.flowId = "conc-base";
  });

  it("falha da recarga preserva o rascunho e a proteção dirty (beforeunload segue bloqueando) e reabilita o save", async () => {
    const flowId = "conc-reload-falha";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    let getCalls = 0;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        getCalls += 1;
        if (getCalls === 1) {
          return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: 5, atualizado_em: null } });
        }
        return Promise.reject(new ApiError("Falha do servidor", 500)); // recarga FALHA
      }
      if (path === flowPath && init?.method === "PUT") return Promise.reject(CONFLICT_REVISAO(9));
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.change(inputNome(), { target: { value: "Rascunho sujo" } }); // rascunho real antes do 409
    fireEvent.click(screen.getByTestId("flow-save"));
    await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });

    fireEvent.click(screen.getByTestId("flow-conflict-reload"));
    await waitFor(() => expect(getFlowCalls(flowPath)).toHaveLength(2)); // recarga falhou
    await waitFor(() => expect(screen.getByText("Não foi possível recarregar o fluxo — tente novamente.")).toBeInTheDocument());
    await waitFor(() => expect(inputNome()).toHaveValue("Rascunho sujo")); // rascunho NÃO descartado
    expect(saveButton().disabled).toBe(false); // save reabilitado
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true); // proteção dirty preservada
    mocks.flowId = "conc-base";
  });

  it("edição durante o save: resposta não marca o rascunho editado como salvo nem limpa dirty; re-save envia a edição com a revisão nova", async () => {
    const flowId = "conc-edit-during-save";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    let resolverPut: (value: unknown) => void = () => {};
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: 5, atualizado_em: null } });
      }
      if (path === flowPath && init?.method === "PUT") {
        return new Promise((resolve) => { resolverPut = resolve; }); // PUT #1 em voo
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("flow-save"));
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(1));
    expect(putBody(flowPath, 0).nome).toBe("Fluxo de teste"); // A em voo

    fireEvent.change(inputNome(), { target: { value: "Nome B" } }); // edição durante o PUT
    await act(async () => { resolverPut({ flow: { revisao: 6 } }); }); // resposta do A

    await waitFor(() => expect(inputNome()).toHaveValue("Nome B")); // B não perdido
    expect(screen.queryByText("Salvo")).toBeNull(); // NÃO mentir sucesso sobre B
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true); // dirty NÃO limpo (B é rascunho real)

    fireEvent.click(screen.getByTestId("flow-save")); // salvar B
    await waitFor(() => expect(putCalls(flowPath)).toHaveLength(2));
    expect(putBody(flowPath, 1).nome).toBe("Nome B");
    expect(putBody(flowPath, 1).revisao_base).toBe(6); // revisão adotada da resposta do A
    mocks.flowId = "conc-base";
  });

  it("resposta tardia da simulação (sucesso) não contamina o fluxo novo da tela", async () => {
    const origem = "conc-sim-origem";
    const destino = "conc-sim-destino";
    mocks.flowId = origem;
    let resolverSim: (value: unknown) => void = () => {};
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${origem}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: origem, nome: "Origem", ativo: false, definition: FIXTURE, revisao: 3, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${destino}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: destino, nome: "Destino", ativo: false, definition: FIXTURE, revisao: 10, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${origem}/simulate` && init?.method === "POST") {
        return new Promise((resolve) => { resolverSim = resolve; });
      }
      return Promise.resolve({});
    });
    const { rerender } = render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(mocks.api.mock.calls.some(([path, init]) => path === `/qualification/flows/${origem}/simulate` && init?.method === "POST")).toBe(true));

    mocks.flowId = destino; // troca de fluxo
    rerender(<FluxoEditorPage />);
    await waitFor(() => expect(inputNome()).toHaveValue("Destino"));

    await act(async () => { resolverSim({ trace: [{ node_id: "P1", kind: "message", result: "Olá!", next: "P2" }] }); }); // resposta tardia do fluxo antigo
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("region", { name: "Resultado da simulação" })).toBeNull(); // sem contaminação
    mocks.flowId = "conc-base";
  });

  it("resposta tardia da simulação (erro) também não contamina o fluxo novo da tela", async () => {
    const origem = "conc-sim-erro-origem";
    const destino = "conc-sim-erro-destino";
    mocks.flowId = origem;
    let rejectSim: (cause: unknown) => void = () => {};
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${origem}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: origem, nome: "Origem", ativo: false, definition: FIXTURE, revisao: 3, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${destino}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: destino, nome: "Destino", ativo: false, definition: FIXTURE, revisao: 10, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${origem}/simulate` && init?.method === "POST") {
        return new Promise((_, reject) => { rejectSim = reject; });
      }
      return Promise.resolve({});
    });
    const { rerender } = render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(mocks.api.mock.calls.some(([path, init]) => path === `/qualification/flows/${origem}/simulate` && init?.method === "POST")).toBe(true));

    mocks.flowId = destino;
    rerender(<FluxoEditorPage />);
    await waitFor(() => expect(inputNome()).toHaveValue("Destino"));

    await act(async () => { rejectSim(new ApiError("Boom", 500)); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("region", { name: "Resultado da simulação" })).toBeNull();
    mocks.flowId = "conc-base";
  });

  it("revisão ausente em fluxo EXISTENTE: save bloqueado com erro recuperável, NENHUM revisao_base 0; recupera após recarregar", async () => {
    const flowId = "conc-revisao-ausente";
    const flowPath = `/qualification/flows/${flowId}`;
    // recuperação = reload da página: SWR cache novo (flowId DIFERENTE evita o
    // dedupe do remount dentro de dedupingInterval — um reload real não tem cache)
    const recoveryId = "conc-revisao-recupera";
    const recoveryPath = `/qualification/flows/${recoveryId}`;
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, atualizado_em: null } }); // SEM revisão
      }
      if (path === recoveryPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: recoveryId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: 4, atualizado_em: null } });
      }
      if ((path === flowPath || path === recoveryPath) && init?.method === "PUT") return Promise.resolve({ flow: { revisao: 5 } });
      return Promise.resolve({});
    });
    const { unmount } = render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("flow-save"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Revisão do fluxo indisponível"));
    expect(putCalls(flowPath)).toHaveLength(0); // nunca enviar 0 (0 = criação na política backend)

    // recuperação: reload da página (remonta com GET válido)
    unmount();
    mocks.flowId = recoveryId;
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("flow-save"));
    await waitFor(() => expect(putCalls(recoveryPath)).toHaveLength(1));
    expect(putBody(recoveryPath, 0).revisao_base).toBe(4);
    mocks.flowId = "conc-base";
  });

  it("revisão inválida (não numérica) também bloqueia o save sem PUT", async () => {
    const flowId = "conc-revisao-invalida";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: "9", atualizado_em: null } });
      }
      if (path === flowPath && init?.method === "PUT") return Promise.resolve({ flow: { revisao: 10 } });
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("flow-save"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Revisão do fluxo indisponível"));
    expect(putCalls(flowPath)).toHaveLength(0);
    mocks.flowId = "conc-base";
  });
});

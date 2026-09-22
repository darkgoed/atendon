// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem) —
   stub mínimo antes de qualquer render. */
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
  flowId: "fluxo-hist-base",
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

/* Phosphor é pesado demais para os testes. Mock explícito por ícone —
   NÃO usar Proxy com get: () => stub (o namespace vira thenable e trava
   a coleta do vitest — pitfall já registrado no flow-editor.test.tsx). */
vi.mock("@phosphor-icons/react", () => ({
  ArrowsDownUp: () => null,
  ChatText: () => null,
  Clock: () => null,
  CursorClick: () => null,
  Eye: () => null,
  Flag: () => null,
  GitBranch: () => null,
  GitFork: () => null,
  Hourglass: () => null,
  Kanban: () => null,
  Keyboard: () => null,
  ListBullets: () => null,
  Plug: () => null,
  Power: () => null,
  Tag: () => null,
  UserFocus: () => null,
  WebhooksLogo: () => null,
  X: () => null,
}));

import { ApiError } from "@/lib/api";
import { FlowHistory } from "@/components/flow-editor/flow-history";
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

/* Shape REAL da listagem (routes.ts:268-280): id/version/flow_name/created_by/
   created_at — SEM definition. Keyset version DESC: a 1ª linha é a mais nova. */
const UUID_V1 = "11111111-1111-4111-8111-111111111111";
const UUID_V2 = "22222222-2222-4222-8222-222222222222";
const UUID_V3 = "33333333-3333-4333-8333-333333333333";
const VERSOES = [
  { id: UUID_V3, version: 3, flow_name: "Fluxo de teste", created_by: "aaaa1111-1111-4111-8111-111111111111", created_at: "2026-09-22T03:10:00Z" },
  { id: UUID_V2, version: 2, flow_name: "Fluxo de teste", created_by: null, created_at: "2026-09-22T02:00:00Z" },
  { id: UUID_V1, version: 1, flow_name: "Fluxo de teste", created_by: null, created_at: "2026-09-21T23:00:00Z" },
];

function historyHarness(flowId: string, overrides: Record<string, unknown> = {}) {
  const onRestored = vi.fn();
  const onConflict = vi.fn();
  const onClose = vi.fn();
  render(<FlowHistory flowId={flowId} revisao={7} canManage onRestored={onRestored} onConflict={onConflict} onClose={onClose} {...overrides} />);
  return { onRestored, onConflict, onClose };
}

describe("FlowHistory (WP-C)", () => {
  it("lista as versões (versão/data/autor/nome) com UMA chamada ao endpoint de listagem — definition nunca é buscada", async () => {
    const flowId = "fluxo-hist-lista";
    const versionsPath = `/qualification/flows/${flowId}/versions`;
    mocks.api.mockImplementation((path: string) => {
      if (path === versionsPath) return Promise.resolve({ versions: VERSOES, next_cursor: null });
      return Promise.resolve({});
    });
    historyHarness(flowId);
    expect(await screen.findByText(/Versão 3 ·/)).toBeInTheDocument();
    expect(screen.getByText(/Versão 2 ·/)).toBeInTheDocument();
    expect(screen.getByText(/Versão 1 ·/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Histórico de versões" })).toBeInTheDocument();
    // listagem NÃO depende de definition: exatamente 1 chamada, só ao /versions
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][0]).toBe(versionsPath);
    expect(mocks.api.mock.calls.every(([path]) => !String(path).includes("diff"))).toBe(true);
  });

  it("confirmação do restore mostra contagens de etapas/arestas via /versions/diff (adicionadas/removidas/modificadas)", async () => {
    const flowId = "fluxo-hist-diff";
    mocks.api.mockImplementation((path: string) => {
      if (path === `/qualification/flows/${flowId}/versions`) return Promise.resolve({ versions: VERSOES, next_cursor: null });
      // from = versão mais recente (3), to = alvo (2): added = etapas que VOLTAM
      if (path === `/qualification/flows/${flowId}/versions/diff?from=3&to=2`) {
        return Promise.resolve({
          from: { version: 3, created_at: "2026-09-22T03:10:00Z" },
          to: { version: 2, created_at: "2026-09-22T02:00:00Z" },
          diff: {
            added: ["N1"],
            removed: ["E9", "E8"],
            modified: ["P1"],
            edges: {
              added: [{ from: "N1", to: "P1", label: "next" }],
              removed: [{ from: "P2", to: "E2", label: "next" }],
            },
          },
        });
      }
      return Promise.resolve({});
    });
    historyHarness(flowId);
    fireEvent.click(await screen.findByTestId("flow-history-restore-2"));
    const dialog = await screen.findByRole("dialog", { name: "Restaurar versão 2?" });
    expect(dialog.textContent).toContain("será substituída");
    const box = screen.getByTestId("flow-history-diff");
    expect(box.textContent).toContain("Etapas: 1 voltam, 2 saem, 1 modificada(s)");
    expect(box.textContent).toContain("Conexões: 1 criada(s), 1 removida(s)");
    // diff é opcional e leve: só endpoints de versions foram consultados
    expect(mocks.api.mock.calls.every(([path]) => String(path).includes("/versions"))).toBe(true);
    // cancelar devolve a lista
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByRole("dialog", { name: "Histórico de versões" })).toBeInTheDocument();
  });

  it("restaura via POST /versions/:versionId/restore (versionId = UUID) com revisao_base e chama onRestored", async () => {
    const flowId = "fluxo-hist-restore";
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${flowId}/versions` && (!init || !init.method)) {
        return Promise.resolve({ versions: VERSOES, next_cursor: null });
      }
      if (path === `/qualification/flows/${flowId}/versions/${UUID_V2}/restore` && init?.method === "POST") {
        return Promise.resolve({ flow: { revisao: 8 }, restored_from: 2, version: 4 });
      }
      return Promise.resolve({}); // diff falha → confirmação segue SEM contagens (diff é opcional)
    });
    const { onRestored } = historyHarness(flowId);
    fireEvent.click(await screen.findByTestId("flow-history-restore-2"));
    expect(await screen.findByRole("dialog", { name: "Restaurar versão 2?" })).toBeInTheDocument();
    expect(screen.queryByTestId("flow-history-diff")).toBeNull();
    fireEvent.click(screen.getByTestId("flow-history-confirm"));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    const post = mocks.api.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`/qualification/flows/${flowId}/versions/${UUID_V2}/restore`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ revisao_base: 7 });
  });

  it("restore com 409 FLOW_VERSION_CONFLICT sobe onConflict (mesmo tratamento do save) e NÃO chama onRestored", async () => {
    const flowId = "fluxo-hist-409";
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${flowId}/versions` && (!init || !init.method)) {
        return Promise.resolve({ versions: VERSOES, next_cursor: null });
      }
      if (path === `/qualification/flows/${flowId}/versions/${UUID_V3}/restore` && init?.method === "POST") {
        return Promise.reject(
          new ApiError("Conflito de versão do fluxo — recarregue a revisão atual e tente novamente", 409, {
            error: "Conflito de versão do fluxo — recarregue a revisão atual e tente novamente",
            code: "FLOW_VERSION_CONFLICT",
            revisao: 9,
          }),
        );
      }
      return Promise.resolve({});
    });
    const { onRestored, onConflict } = historyHarness(flowId);
    // alvo = versão mais recente (3) → confirmação abre sem diff
    fireEvent.click(await screen.findByTestId("flow-history-restore-3"));
    expect(await screen.findByRole("dialog", { name: "Restaurar versão 3?" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("flow-history-confirm"));
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith({ revisao: 9 }));
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("página do editor — wiring M3/M4 (/fluxos/:id)", () => {
  function mockGet(flowId: string, revisao: number | null) {
    return (path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${flowId}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao, atualizado_em: null } });
      }
      return Promise.resolve({});
    };
  }

  it("botão Histórico presente na página e abre o painel de versões (WP-C)", async () => {
    mocks.flowId = "fluxo-botao-historico";
    mocks.api.mockImplementation(mockGet(mocks.flowId, 5));
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("flow-history-open"));
    expect(await screen.findByRole("dialog", { name: "Histórico de versões" })).toBeInTheDocument();
    mocks.flowId = "fluxo-hist-base";
  });

  it("save envia revisao_base do GET e adota a revisão nova da resposta (CAS R2)", async () => {
    const flowId = "fluxo-cas-revisao";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: 5, atualizado_em: null } });
      }
      if (path === flowPath && init?.method === "PUT") return Promise.resolve({ flow: { revisao: 6 } });
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    const putCalls = () => mocks.api.mock.calls.filter(([path, init]) => path === flowPath && init?.method === "PUT");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String(putCalls()[0]?.[1]?.body)).revisao_base).toBe(5);

    await screen.findByText("Salvo."); // resposta do PUT já aplicada (revisão nova no estado)
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(putCalls()).toHaveLength(2));
    expect(JSON.parse(String(putCalls()[1]?.[1]?.body)).revisao_base).toBe(6);
  });

  it("409 FLOW_VERSION_CONFLICT do save abre o modal com a revisão do servidor; Recarregar revalida e limpa", async () => {
    const flowId = "fluxo-conflito-409";
    const flowPath = `/qualification/flows/${flowId}`;
    mocks.flowId = flowId;
    let getCalls = 0;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        getCalls += 1;
        return Promise.resolve({ flow: { id: flowId, nome: "Fluxo de teste", ativo: true, definition: FIXTURE, revisao: getCalls === 1 ? 5 : 9, atualizado_em: null } });
      }
      if (path === flowPath && init?.method === "PUT") {
        return Promise.reject(
          new ApiError("Conflito de versão do fluxo — recarregue a revisão atual e tente novamente", 409, {
            error: "Conflito de versão do fluxo — recarregue a revisão atual e tente novamente",
            code: "FLOW_VERSION_CONFLICT",
            revisao: 9,
          }),
        );
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    const dialog = await screen.findByRole("dialog", { name: "Fluxo alterado por outro salvamento" });
    expect(dialog.textContent).toContain("9");

    fireEvent.click(screen.getByTestId("flow-conflict-reload")); // onReload = SWR mutate
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fluxo alterado por outro salvamento" })).toBeNull());
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2)); // revalidação real do GET
  });

  it("dirty: beforeunload é cancelado e navegação interna exige descarte explícito (confirm); limpo não bloqueia", async () => {
    const flowId = "fluxo-dirty-guard";
    mocks.flowId = flowId;
    mocks.api.mockImplementation(mockGet(flowId, 2));
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    // limpo: saída livre
    let event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    // edita o nome → dirty real
    fireEvent.change(screen.getByLabelText("Nome do fluxo"), { target: { value: "Nome sujo" } });

    event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "/fluxos");
    document.body.appendChild(anchor);
    try {
      fireEvent.click(anchor);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(String(confirmSpy.mock.calls[0]?.[0])).toContain("descartá-las");
      // confirm=false ⇒ descarte recusado: preventDefault bloqueou a navegação
      expect(mocks.api.mock.calls.every(([path]) => String(path).includes(`/qualification/flows/${flowId}`))).toBe(true);
    } finally {
      anchor.remove();
      confirmSpy.mockRestore();
    }
  });

  it("save tardio após trocar de rota: PUT vai ao fluxo original e a resposta não vaza no outro (R5)", async () => {
    const origem = "fluxo-origem-tardia";
    const destino = "fluxo-destino-tardia";
    mocks.flowId = origem;
    let resolverPut: (value: unknown) => void = () => {};
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/qualification/flows/${origem}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: origem, nome: "Origem", ativo: false, definition: FIXTURE, revisao: 3, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${destino}` && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: destino, nome: "Destino", ativo: false, definition: FIXTURE, revisao: 10, atualizado_em: null } });
      }
      if (path === `/qualification/flows/${origem}` && init?.method === "PUT") {
        return new Promise((resolve) => { resolverPut = resolve; });
      }
      return Promise.resolve({});
    });
    const { rerender } = render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());
    expect(screen.getByLabelText("Nome do fluxo")).toHaveValue("Origem");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" })); // PUT pendente
    await waitFor(() => expect(mocks.api.mock.calls.some(([path, init]) => path === `/qualification/flows/${origem}` && init?.method === "PUT")).toBe(true));

    mocks.flowId = destino; // troca de fluxo: mesma página, params mudam
    rerender(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByLabelText("Nome do fluxo")).toHaveValue("Destino"));

    await act(async () => { resolverPut({ flow: { revisao: 4 } }); }); // resposta tardia do save antigo

    // nada vazou para o fluxo destino: sem "Salvo.", sem "Salvando…", zero PUT ao destino
    expect(screen.queryByText("Salvo.")).toBeNull();
    expect(screen.queryByText("Salvando…")).toBeNull();
    expect(mocks.api.mock.calls.some(([path, init]) => path === `/qualification/flows/${destino}` && init?.method === "PUT")).toBe(false);
    mocks.flowId = "fluxo-hist-base";
  });
});

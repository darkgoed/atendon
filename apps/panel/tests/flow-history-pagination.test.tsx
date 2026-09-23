// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

/* Teste COMPORTAMENTAL da paginação do FlowHistory: SWR REAL (swr/infinite não
   é mockado) sobre cache isolado via SWRConfig. Mocks reproduzem o padrão de
   tests/flow-history.test.tsx (api + ApiError; Shell não é importado pelo
   FlowHistory, mas o mock fica por paridade com aquele arquivo). */

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
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

import { ApiError } from "@/lib/api";
import { FlowHistory } from "@/components/flow-editor/flow-history";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* Keyset version DESC: página 1 = mais recentes, next_cursor para a página 2. */
const CURSOR = "cursor-pagina-2";
const PAGE1 = {
  versions: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", version: 5, flow_name: "Fluxo paginado", created_by: null, created_at: "2026-09-22T10:00:00Z" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 4, flow_name: "Fluxo paginado", created_by: null, created_at: "2026-09-22T09:00:00Z" },
  ],
  next_cursor: CURSOR,
};
const PAGE2 = {
  versions: [
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", version: 3, flow_name: "Fluxo paginado", created_by: null, created_at: "2026-09-22T08:00:00Z" },
  ],
  next_cursor: null,
};

/* Cache novo por render (isolamento entre testes) + retry automático da SWR
   desligado: o clique em "Tentar novamente" (mutate) é quem revalida. */
function historyHarness(flowId: string) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), onErrorRetry: () => {} }}>
      <FlowHistory
        flowId={flowId}
        revisao={7}
        canManage
        onRestored={vi.fn()}
        onConflict={vi.fn()}
        onClose={vi.fn()}
      />
    </SWRConfig>,
  );
}

describe("FlowHistory — paginação (botão carregar mais, SWR real)", () => {
  it("isLoading cobre a 1ª fetch; clique em Carregar mais busca a página 2 com o cursor e o botão some ao esgotar", async () => {
    const flowId = "fluxo-hist-paginacao";
    const base = `/qualification/flows/${flowId}/versions`;
    mocks.api.mockImplementation((path: string) => {
      if (path === base) return Promise.resolve(PAGE1);
      if (path === `${base}?cursor=${encodeURIComponent(CURSOR)}`) return Promise.resolve(PAGE2);
      return Promise.resolve({});
    });
    historyHarness(flowId);
    expect(screen.getByText("Carregando…")).toBeInTheDocument(); // isLoading da 1ª fetch

    expect(await screen.findByText(/Versão 5 ·/)).toBeInTheDocument();
    expect(screen.getByText(/Versão 4 ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Versão 3 ·/)).toBeNull(); // página 2 ainda não veio
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith(base);

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    expect(await screen.findByText(/Versão 3 ·/)).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith(`${base}?cursor=${encodeURIComponent(CURSOR)}`);
    // esgotado (next_cursor null, sem erro): botão desaparece
    await waitFor(() => expect(screen.queryByTestId("flow-history-more")).toBeNull());
  });

  it("falha na página 2: página 1 preservada, botão vira Tentar novamente e mutate revalida com sucesso", async () => {
    const flowId = "fluxo-hist-retry";
    const base = `/qualification/flows/${flowId}/versions`;
    let page2Calls = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path === base) return Promise.resolve(PAGE1);
      if (path === `${base}?cursor=${encodeURIComponent(CURSOR)}`) {
        page2Calls += 1;
        return page2Calls === 1 ? Promise.reject(new ApiError("boom", 500)) : Promise.resolve(PAGE2);
      }
      return Promise.resolve({});
    });
    historyHarness(flowId);
    expect(await screen.findByText(/Versão 5 ·/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o histórico.");
    // página 1 intacta apesar do erro da página 2
    expect(screen.getByText(/Versão 5 ·/)).toBeInTheDocument();
    expect(screen.getByText(/Versão 4 ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Versão 3 ·/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); // mutate()
    expect(await screen.findByText(/Versão 3 ·/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("flow-history-more")).toBeNull());
    expect(page2Calls).toBe(2);
  });
});

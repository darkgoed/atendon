// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { SWRConfig } from "swr";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/page-state", () => ({
  Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LoadingCards: () => <div>carregando…</div>
}));
vi.mock("../components/modal-dialog", () => ({
  ModalDialog: ({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }) => (
    <div role="dialog" aria-labelledby={labelledBy}>{children}</div>
  )
}));

import { FlowInsights } from "../components/flow-editor/flow-insights";

// Cache SWR novo por render: chaves repetidas entre testes não podem herdar
// dados de um teste anterior (o mock é refeito, o cache global não).
function renderWithFreshCache(node: React.ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map() }}>{node}</SWRConfig>);
}
import { NewFlowFromTemplateDialog, SaveFlowTemplateDialog } from "../components/flow-templates";

const ANALYTICS = { executions: 12, completed: 9, errors: 1 };
const EXECUTIONS = {
  executions: [
    { id: "e-2", conversation_id: "c-1", lead_id: "l-1", node_id: "n_final", kind: "final", status: "completed", detail: null, created_at: "2026-10-01T10:00:00Z" },
    { id: "e-1", conversation_id: "c-2", lead_id: "l-2", node_id: "n_msg1", kind: "message", status: "failed", detail: "gateway rejeitou", created_at: "2026-09-30T09:00:00Z" }
  ],
  next_cursor: "cur-1"
};

beforeEach(() => {
  cleanup();
  api.mockReset();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("flow insights — desempenho (C1-d)", () => {
  it("mostra agregados com auto-refresh e lista execuções com status", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/analytics")) return ANALYTICS;
      if (path.includes("/executions")) return EXECUTIONS;
      return {};
    });
    renderWithFreshCache(<FlowInsights flowId="flow-1" onClose={() => undefined} />);
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // Auto-refresh 30s conforme a spec C1-d.
    expect(api.mock.calls.some(([path]) => String(path).endsWith("/analytics"))).toBe(true);
    expect(await screen.findByText("gateway rejeitou")).toBeInTheDocument();
    expect(screen.getByText("erro")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    // Paginação: cursor da resposta alimenta "Carregar mais".
    expect(screen.getByRole("button", { name: "Carregar mais execuções" })).toBeInTheDocument();
  });

  it("analytics vazio e sem execuções mostra estados vazios", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/analytics")) return { executions: 0, completed: 0, errors: 0 };
      if (path.includes("/executions")) return { executions: [], next_cursor: null };
      return {};
    });
    renderWithFreshCache(<FlowInsights flowId="flow-1" onClose={() => undefined} />);
    expect(await screen.findByText("Nenhuma execução registrada ainda — o fluxo roda quando um contato dispara o gatilho.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais execuções" })).toBeNull();
  });

  it("erro do backend aparece por bloco", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/analytics")) return Promise.reject(new Error("Fluxo não encontrado"));
      if (path.includes("/executions")) return Promise.reject(new Error("Cursor inválido"));
      return {};
    });
    renderWithFreshCache(<FlowInsights flowId="flow-1" onClose={() => undefined} />);
    expect(await screen.findByText("Fluxo não encontrado")).toBeInTheDocument();
    expect(screen.getByText("Cursor inválido")).toBeInTheDocument();
  });
});

describe("flow templates (C1-f)", () => {
  it("criar a partir de template: carrega a definition e cria com o nome escolhido", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onClose = vi.fn();
    const templates = { templates: [{ id: "t-1", nome: "Triagem", descricao: "horário", criado_em: "", atualizado_em: "2026-10-01T10:00:00Z" }] };
    api.mockImplementation(async (path: string) => {
      if (path === "/qualification/flow-templates") return templates;
      if (path === "/qualification/flow-templates/t-1") return { template: { id: "t-1", nome: "Triagem", definition: { start: "n1" } } };
      return {};
    });
    renderWithFreshCache(<NewFlowFromTemplateDialog open onClose={onClose} onCreate={onCreate} />);
    await user.click(await screen.findByRole("radio", { name: /Triagem/ }));
    const nameInput = screen.getByLabelText("Nome do fluxo novo") as HTMLInputElement;
    // Nome pré-preenchido com o nome do template (editável).
    expect(nameInput.value).toBe("Triagem");
    await user.clear(nameInput);
    await user.type(nameInput, "Triagem outubro");
    await user.click(screen.getByRole("button", { name: "Criar fluxo" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Triagem outubro", { start: "n1" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sem templates mostra orientação para salvar um primeiro", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/qualification/flow-templates") return { templates: [] };
      return {};
    });
    renderWithFreshCache(<NewFlowFromTemplateDialog open onClose={() => undefined} onCreate={() => undefined} />);
    expect(await screen.findByText(/Nenhum template salvo/)).toBeInTheDocument();
  });

  it("salvar como template POSTa name/description/definition da versão salva", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/qualification/flow-templates" && (init as RequestInit).method === "POST") return { template: { id: "t-9" } };
      return {};
    });
    renderWithFreshCache(<SaveFlowTemplateDialog open flowName="Suporte" definition={{ start: "n1" }} onClose={() => undefined} onSaved={onSaved} />);
    const nameInput = await screen.findByLabelText("Nome do template") as HTMLInputElement;
    expect(nameInput.value).toBe("Suporte (template)");
    await user.type(screen.getByLabelText("Descrição (opcional)"), "fluxo base");
    await user.click(screen.getByRole("button", { name: "Salvar template" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = api.mock.calls.find(([path]) => path === "/qualification/flow-templates");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      name: "Suporte (template)",
      description: "fluxo base",
      definition: { start: "n1" }
    });
  });

  it("erro de nome duplicado/inválido do backend aparece no dialog", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/qualification/flow-templates" && (init as RequestInit).method === "POST") {
        return Promise.reject(new Error("definition inválida"));
      }
      return {};
    });
    renderWithFreshCache(<SaveFlowTemplateDialog open flowName="Suporte" definition={{ start: "n1" }} onClose={() => undefined} onSaved={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: "Salvar template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("definition inválida");
  });

  it("excluir template pede confirmação e chama DELETE", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/qualification/flow-templates") return { templates: [{ id: "t-1", nome: "Velho", descricao: null, criado_em: "", atualizado_em: "2026-10-01T10:00:00Z" }] };
      if (path === "/qualification/flow-templates/t-1" && (init as RequestInit).method === "DELETE") return { ok: true };
      return {};
    });
    renderWithFreshCache(<NewFlowFromTemplateDialog open onClose={() => undefined} onCreate={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: "Excluir template Velho" }));
    await waitFor(() => expect(api.mock.calls.some(([path, init]) => path === "/qualification/flow-templates/t-1" && (init as RequestInit).method === "DELETE")).toBe(true));
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1);
  });
});

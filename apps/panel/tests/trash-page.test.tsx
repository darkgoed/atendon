// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import TrashPage from "../app/contatos/lixeira/page";

type Recorded = { path: string; method: string; body?: Record<string, unknown> };

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["trash.manage"],
  actorScope: "workspace"
};

function makeLead(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "lead-1",
    name: "Aurora Nogueira",
    phone: "+5511988881200",
    status: "novo",
    deleted_at: "2026-09-15T10:00:00.000Z",
    deleted_by: { id: "user-2", name: "Bruno Tavares" },
    created_at: "2026-08-01T10:00:00.000Z",
    ...overrides
  };
}

let trashDb: ReturnType<typeof makeLead>[];
const calls: Recorded[] = [];

function jsonResponse(payload: unknown) {
  return Promise.resolve(payload);
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TrashPage />
    </SWRConfig>
  );
}

beforeEach(() => {
  calls.length = 0;
  trashDb = [
    makeLead(),
    makeLead({ id: "lead-2", name: "Diego Salgado", phone: "+5511977773400", status: "qualificado", deleted_at: "2026-09-16T15:30:00.000Z", deleted_by: null })
  ];
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (path === "/me") return jsonResponse(SESSION);
    if (path === "/trash?limit=30") {
      return jsonResponse({ items: [...trashDb], page: { limit: 30, has_more: false, next_cursor: null } });
    }
    const restore = /^\/trash\/leads\/([^/]+)\/restore$/.exec(path);
    if (restore && method === "POST") {
      trashDb = trashDb.filter((item) => item.id !== restore[1]);
      return jsonResponse({ id: restore[1] });
    }
    const destroy = /^\/trash\/leads\/([^/]+)$/.exec(path);
    if (destroy && method === "DELETE") {
      trashDb = trashDb.filter((item) => item.id !== destroy[1]);
      return jsonResponse({ id: destroy[1] });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("lixeira de contatos (R19)", () => {
  it("lista contatos excluídos com telefone, status e quem excluiu", async () => {
    const { container } = renderPage();
    expect(await screen.findByText("Aurora Nogueira")).toBeInTheDocument();
    expect(screen.getByText("Diego Salgado")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/trash?limit=30");

    const first = container.querySelector('[data-trash-id="lead-1"]') as HTMLElement;
    expect(within(first).getByText("+5511988881200")).toBeInTheDocument();
    expect(within(first).getByText("Novo")).toBeInTheDocument();
    expect(within(first).getByText("por Bruno Tavares")).toBeInTheDocument();

    const second = container.querySelector('[data-trash-id="lead-2"]') as HTMLElement;
    expect(within(second).getByText("Qualificado")).toBeInTheDocument();
    expect(within(second).queryByText(/por /)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais" })).not.toBeInTheDocument();
  });

  it("restaura contato via POST /trash/leads/:id/restore e a linha sai da lista", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Aurora Nogueira");
    await user.click(screen.getByRole("button", { name: "Restaurar contato: Aurora Nogueira" }));
    await waitFor(() => expect(screen.queryByText("Aurora Nogueira")).not.toBeInTheDocument());
    expect(calls.some((call) => call.path === "/trash/leads/lead-1/restore" && call.method === "POST")).toBe(true);
    expect(screen.getByText("Diego Salgado")).toBeInTheDocument();
  });

  it("excluir definitivamente pede confirmação e chama DELETE", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Diego Salgado");
    await user.click(screen.getByRole("button", { name: "Excluir definitivamente: Diego Salgado" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Diego Salgado"));
    await waitFor(() => expect(screen.queryByText("Diego Salgado")).not.toBeInTheDocument());
    expect(calls.some((call) => call.path === "/trash/leads/lead-2" && call.method === "DELETE")).toBe(true);
  });

  it("cancelar a confirmação não chama DELETE", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Diego Salgado");
    await user.click(screen.getByRole("button", { name: "Excluir definitivamente: Diego Salgado" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByText("Diego Salgado")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("mostra estado vazio quando a lixeira não tem itens", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return jsonResponse(SESSION);
      if (path === "/trash?limit=30") return jsonResponse({ items: [], page: { limit: 30, has_more: false, next_cursor: null } });
      return jsonResponse({});
    });
    renderPage();
    expect(await screen.findByText("A lixeira está vazia")).toBeInTheDocument();
    expect(screen.getByText(/Contatos excluídos pela equipe aparecem aqui/)).toBeInTheDocument();
  });

  it("sem trash.manage não renderiza nada e não busca a lixeira", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return jsonResponse({ ...SESSION, permissions: ["contacts.read"] });
      return jsonResponse({});
    });
    const { container } = renderPage();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/me"));
    expect(container).toBeEmptyDOMElement();
    expect(apiMock).not.toHaveBeenCalledWith("/trash?limit=30", undefined);
  });
});

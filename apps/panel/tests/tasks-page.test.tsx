// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import TasksPage from "../app/tarefas/page";

type Recorded = { path: string; method: string; body?: Record<string, unknown> };

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["tasks.read", "tasks.assign", "members.read"],
  actorScope: "workspace"
};

const MEMBERS = {
  members: [
    { user_id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", status: "active" },
    { user_id: "user-2", name: "Bruno Tavares", email: "bruno@exemplo.com", status: "active" }
  ]
};

function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "task-a",
    title: "Enviar proposta revisada",
    description: "Ajustar preço e reenviar",
    status: "aberta",
    priority: "alta",
    due_at: "2026-12-01T12:00:00.000Z",
    assignee: { id: "user-1", name: "Marina Duarte" },
    author: { id: "user-1", name: "Marina Duarte" },
    lead: { id: "lead-1", name: "Aurora Nogueira", phone: "+5511988881200" },
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    completed_at: null,
    ...overrides
  };
}

let tasksDb: ReturnType<typeof makeTask>[];
const calls: Recorded[] = [];

function jsonResponse(payload: unknown) {
  return Promise.resolve(payload);
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TasksPage />
    </SWRConfig>
  );
}

beforeEach(() => {
  calls.length = 0;
  tasksDb = [makeTask(), makeTask({ id: "task-b", title: "Ligar para o cliente", status: "concluida", priority: "baixa", due_at: null })];
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method, body });
    if (path === "/me") return jsonResponse(SESSION);
    if (path === "/workspaces/current/members") return jsonResponse(MEMBERS);
    if (path.startsWith("/scheduling/leads")) return jsonResponse({ leads: [{ id: "lead-1", nome: "Aurora Nogueira", telefone: "+5511988881200" }] });
    if (path.startsWith("/tasks?")) {
      const url = new URL(`http://localhost${path}`);
      const cursor = url.searchParams.get("cursor");
      if (cursor) return jsonResponse({ items: [makeTask({ id: "task-c", title: "Tarefa antiga", status: "aberta", priority: "media", assignee: null })], page: { limit: 30, has_more: false, next_cursor: null } });
      const scope = url.searchParams.get("scope");
      const items = scope === "team"
        ? [makeTask({ id: "task-team", title: "Tarefa da equipe", assignee: { id: "user-2", name: "Bruno Tavares" } })]
        : tasksDb;
      return jsonResponse({ items, page: { limit: 30, has_more: !cursor, next_cursor: cursor ? null : "cursor-1" } });
    }
    if (path.startsWith("/tasks/")) {
      const taskId = path.slice("/tasks/".length);
      const index = tasksDb.findIndex((task) => task.id === taskId);
      if (method === "PATCH") {
        tasksDb[index] = { ...tasksDb[index], ...body, status: (body?.status as string | undefined) ?? tasksDb[index].status } as ReturnType<typeof makeTask>;
        return jsonResponse({ task: tasksDb[index] });
      }
      if (method === "DELETE") {
        tasksDb = tasksDb.filter((task) => task.id !== taskId);
        return jsonResponse({ id: taskId });
      }
    }
    if (path === "/tasks" && method === "POST") {
      const created = makeTask({ ...body, id: "task-new", assignee: body?.assignee_id ? { id: String(body.assignee_id), name: "Bruno Tavares" } : null, status: "aberta", completed_at: null }) as ReturnType<typeof makeTask>;
      tasksDb = [created, ...tasksDb];
      return jsonResponse({ task: created });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("página Tarefas (R6)", () => {
  it("lista tarefas com badges, responsável e contato relacionado; paginada por cursor", async () => {
    const { container } = renderPage();
    expect(await screen.findByText("Enviar proposta revisada")).toBeInTheDocument();
    expect(screen.getByText("Ligar para o cliente")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/tasks?scope=mine&limit=30");

    const firstRow = container.querySelector('[data-task-id="task-a"]');
    expect(within(firstRow as HTMLElement).getByText("Aberta")).toBeInTheDocument();
    expect(within(firstRow as HTMLElement).getByText("Prioridade Alta")).toBeInTheDocument();
    expect(within(firstRow as HTMLElement).getByText("Aurora Nogueira · +5511988881200")).toBeInTheDocument();
    expect(within(firstRow as HTMLElement).getByText(/Prazo:/)).toBeInTheDocument();

    // Keyset: "Carregar mais" busca a página seguinte pelo cursor.
    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    await waitFor(() => expect(screen.getByText("Tarefa antiga")).toBeInTheDocument());
    expect(calls.some((call) => call.path.includes("cursor=cursor-1"))).toBe(true);
  });

  it("filtra por escopo equipe (tasks.assign) refetchando com scope=team", async () => {
    renderPage();
    await screen.findByText("Enviar proposta revisada");
    await userEvent.selectOptions(screen.getByLabelText("Escopo"), "team");
    await waitFor(() => expect(screen.getByText("Tarefa da equipe")).toBeInTheDocument());
    expect(apiMock).toHaveBeenCalledWith("/tasks?scope=team&limit=30");
  });

  it("cria tarefa atribuída com prazo ISO e contato via POST /tasks", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Enviar proposta revisada");

    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const dialog = await screen.findByRole("dialog", { name: /Nova tarefa/ });
    await user.type(within(dialog).getByLabelText("Título"), "Preparar onboarding");
    await user.selectOptions(within(dialog).getByLabelText("Responsável"), "user-2");
    fireEvent.change(within(dialog).getByLabelText("Prazo"), { target: { value: "2026-09-20T14:30" } });
    await user.click(within(dialog).getByRole("button", { name: "Criar tarefa" }));

    await waitFor(() => {
      const created = calls.find((call) => call.path === "/tasks" && call.method === "POST");
      expect(created).toBeTruthy();
    });
    const created = calls.find((call) => call.path === "/tasks" && call.method === "POST");
    expect(created?.body).toMatchObject({ title: "Preparar onboarding", assignee_id: "user-2", priority: "media", lead_id: null });
    expect(String(created?.body?.due_at)).toMatch(/Z$/);
    await waitFor(() => expect(screen.getByText("Preparar onboarding")).toBeInTheDocument());
  });

  it("vincula contato relacionado buscando por /scheduling/leads", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Enviar proposta revisada");
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const dialog = await screen.findByRole("dialog", { name: /Nova tarefa/ });
    await user.type(within(dialog).getByLabelText("Buscar contato relacionado"), "Aurora");
    const option = await within(await screen.findByRole("listbox", { name: "Contatos encontrados" })).findByRole("option");
    await user.click(option);
    await user.type(within(dialog).getByLabelText("Título"), "Retomar orçamento");
    await user.click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await waitFor(() => {
      const created = calls.find((call) => call.path === "/tasks" && call.method === "POST");
      expect(created?.body).toMatchObject({ lead_id: "lead-1" });
    });
  });

  it("conclui e reabre tarefa via PATCH /tasks/:id", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const row = () => container.querySelector('[data-task-id="task-a"]') as HTMLElement;
    await screen.findByText("Enviar proposta revisada");

    await user.click(within(row()).getByRole("button", { name: "Concluir tarefa: Enviar proposta revisada" }));
    await waitFor(() => expect(within(row()).getByRole("button", { name: "Reabrir tarefa: Enviar proposta revisada" })).toBeInTheDocument());
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.path).toBe("/tasks/task-a");
    expect(patch?.body).toEqual({ status: "concluida" });
    expect(within(row()).getByText("Concluída")).toBeInTheDocument();
  });

  it("exclui tarefa com confirmação via DELETE /tasks/:id", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Enviar proposta revisada");
    await user.click(screen.getByRole("button", { name: "Excluir tarefa: Enviar proposta revisada" }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Enviar proposta revisada")).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/tasks/task-a")).toBe(true);
  });

  it("sem tasks.assign: escopo travado em Minhas e tarefa criada para si", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
      if (path === "/me") return jsonResponse({ ...SESSION, permissions: ["tasks.read"] });
      if (path.startsWith("/tasks?")) return jsonResponse({ items: [], page: { limit: 30, has_more: false, next_cursor: null } });
      if (path === "/tasks" && method === "POST") return jsonResponse({ task: makeTask() });
      return jsonResponse({});
    });
    renderPage();
    await screen.findByText("Nenhuma tarefa");
    expect(screen.getByLabelText("Escopo")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Criar tarefa" }));
    const dialog = await screen.findByRole("dialog", { name: /Nova tarefa/ });
    expect(within(dialog).getByLabelText("Responsável")).toHaveValue("Você");
    await user.type(within(dialog).getByLabelText("Título"), "Tarefa só minha");
    await user.click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await waitFor(() => {
      const created = calls.find((call) => call.path === "/tasks" && call.method === "POST");
      expect(created?.body).toMatchObject({ assignee_id: "user-1" });
    });
  });
});

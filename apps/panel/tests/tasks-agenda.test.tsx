// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { groupTasksByDay, type AgendaTask } from "../app/tarefas/tasks-agenda";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import TasksPage from "../app/tarefas/page";

//chai puro: asserções por truthiness/atributos, sem jest-dom.

const t = (id: string, status: string, due_at: string | null): AgendaTask => ({ id, status, due_at });

describe("groupTasksByDay (agrupador da agenda pessoal)", () => {
  // 2026-09-20 é domingo; 12:00Z = 09:00 em America/Sao_Paulo.
  const today = new Date("2026-09-20T12:00:00Z");
  const tz = "America/Sao_Paulo";

  it("separa atrasada, hoje, dias futuros em ordem crescente e sem prazo (due inválido cai em Sem prazo)", () => {
    const groups = groupTasksByDay([
      t("f", "aberta", "2026-09-22T12:00:00Z"),
      t("f2", "aberta", "2026-09-23T12:00:00Z"),
      t("a", "aberta", "2026-09-18T12:00:00Z"),
      t("h", "aberta", "2026-09-20T15:00:00Z"),
      t("s", "aberta", null),
      t("i", "aberta", "não-é-data")
    ], today, tz);

    expect(groups.map((group) => group.label)).toEqual(["Atrasadas", "Hoje", "ter, 22 set", "qua, 23 set", "Sem prazo"]);
    expect(groups[0]!.tasks.map((task) => task.id)).toEqual(["a"]);
    expect(groups[1]!.tasks.map((task) => task.id)).toEqual(["h"]);
    expect(groups[2]!.tasks.map((task) => task.id)).toEqual(["f"]);
    expect(groups[3]!.tasks.map((task) => task.id)).toEqual(["f2"]);
    expect(groups[4]!.tasks.map((task) => task.id)).toEqual(["s", "i"]);
  });

  it("agrupa por dia civil no fuso da sessão: 02:00Z de 21/09 é 22:00 de 20/09 em São Paulo (Hoje)", () => {
    const groups = groupTasksByDay([t("x", "aberta", "2026-09-21T02:00:00Z")], today, tz);
    expect(groups.map((group) => group.label)).toEqual(["Hoje"]);
  });

  it("concluída atrasada aparece no dia do due_at (não some); atrasada aberta vai para Atrasadas", () => {
    const groups = groupTasksByDay([
      t("d1", "concluida", "2026-09-17T12:00:00Z"),
      t("o1", "aberta", "2026-09-17T12:00:00Z")
    ], today, tz);

    expect(groups.map((group) => group.label)).toEqual(["Atrasadas", "qui, 17 set"]);
    expect(groups[0]!.tasks.map((task) => task.id)).toEqual(["o1"]);
    expect(groups[1]!.tasks.map((task) => task.id)).toEqual(["d1"]);
  });

  it("lista vazia não gera grupos fantasmas", () => {
    expect(groupTasksByDay([], today, tz)).toEqual([]);
  });
});

// ---------------------------------------------------------------- render ----

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["tasks.read", "tasks.assign"],
  actorScope: "workspace"
};

// Datas relativas ao relógio real, ancoradas ao MEIO-DIA local: ontem/hoje/+2
// dias não mudam de grupo se a suíte cruzar a meia-noite (janela de flake).
const now = new Date();
now.setHours(12, 0, 0, 0);
const baseMs = now.getTime();
const YESTERDAY = new Date(baseMs - 24 * 3_600_000).toISOString();
const TODAY = new Date(baseMs).toISOString();
const IN_TWO_DAYS = new Date(baseMs + 48 * 3_600_000).toISOString();

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-x",
    title: "Tarefa",
    description: null,
    status: "aberta",
    priority: "media",
    due_at: null,
    assignee: { id: "user-1", name: "Marina Duarte" },
    author: { id: "user-1", name: "Marina Duarte" },
    lead: null,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    completed_at: null,
    ...overrides
  };
}

const TASKS = [
  makeTask({ id: "task-overdue", title: "Cobrar retorno do cliente", priority: "alta", due_at: YESTERDAY }),
  makeTask({ id: "task-today", title: "Tarefa de hoje", due_at: TODAY }),
  makeTask({ id: "task-future", title: "Planejar sprint", priority: "baixa", due_at: IN_TWO_DAYS }),
  makeTask({ id: "task-nodue", title: "Ligar para o fornecedor", due_at: null }),
  makeTask({ id: "task-done", title: "Arquivar lead antigo", status: "concluida", priority: "baixa", due_at: YESTERDAY, completed_at: YESTERDAY })
];

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TasksPage />
    </SWRConfig>
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === "/me") return Promise.resolve(SESSION);
    if (path.startsWith("/tasks?")) return Promise.resolve({ items: TASKS, page: { limit: 30, has_more: false, next_cursor: null } });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("página /tarefas — toggle Lista | Agenda", () => {
  it("começa em Lista, alterna com aria-pressed e persiste em localStorage", async () => {
    renderPage();
    await screen.findByText("Cobrar retorno do cliente");

    const listaBtn = screen.getByRole("button", { name: "Lista" });
    const agendaBtn = screen.getByRole("button", { name: "Agenda" });
    expect(listaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(agendaBtn.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Atrasadas")).toBeNull();

    fireEvent.click(agendaBtn);
    expect(agendaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(listaBtn.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("atendon-tasks-view")).toBe("agenda");
    expect(await screen.findByText("Atrasadas")).toBeTruthy();

    fireEvent.click(listaBtn);
    expect(screen.queryByText("Atrasadas")).toBeNull();
    expect(window.localStorage.getItem("atendon-tasks-view")).toBe("lista");
  });

  it("preferência pré-persistida abre direto na Agenda", async () => {
    window.localStorage.setItem("atendon-tasks-view", "agenda");
    renderPage();
    expect(await screen.findByText("Sem prazo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agenda" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("agenda agrupa a MESMA lista carregada sem refetch; visão Lista mantém o mesmo render", async () => {
    const { container } = renderPage();
    await screen.findByText("Cobrar retorno do cliente");
    const taskFetches = () => apiMock.mock.calls.filter((call) => String(call[0]).startsWith("/tasks?")).length;
    const before = taskFetches();

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(await screen.findByText("Atrasadas")).toBeTruthy();

    // Nenhuma tarefa some; cada uma vive dentro de uma seção de dia.
    expect(container.querySelectorAll("[data-task-id]").length).toBe(TASKS.length);
    expect(screen.getByText("Atrasadas").closest("section")?.textContent).toContain("Cobrar retorno do cliente");
    expect(screen.getByText("Hoje").closest("section")?.textContent).toContain("Tarefa de hoje");
    // Concluída atrasada aparece com o dia do due_at, não em Atrasadas.
    expect(container.textContent).toContain("Arquivar lead antigo");
    expect(screen.getByText("Atrasadas").closest("section")?.textContent).not.toContain("Arquivar lead antigo");

    expect(taskFetches()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Lista" }));
    expect(screen.queryByText("Atrasadas")).toBeNull();
    expect(container.querySelectorAll("[data-task-id]").length).toBe(TASKS.length);
    const row = container.querySelector('[data-task-id="task-overdue"]');
    expect(row?.textContent).toContain("Aberta");
    expect(row?.textContent).toContain("Prioridade Alta");
  });
});

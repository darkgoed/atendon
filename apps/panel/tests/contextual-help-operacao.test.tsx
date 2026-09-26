// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

// Radix Popover (HelpHint) mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

import TasksPage from "../app/tarefas/page";
import FollowUpsPage from "../app/follow-ups/page";
import { AgendaTimeBlockDialog } from "../app/agenda/agenda-time-blocks";

const baseTask = {
  id: "t1",
  title: "Revisar proposta",
  description: null,
  status: "aberta",
  priority: "media",
  due_at: null,
  assignee: null,
  author: { id: "u1", name: "Eu" },
  lead: null,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z",
  completed_at: null
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ajuda contextual do pacote operacao", () => {
  it("Tarefas: HelpHint do escopo aparece na barra de filtros", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return Promise.resolve({ user: { id: "u1", isRoot: false }, permissions: [], actorScope: "workspace", rootWorkspaceAccess: false });
      if (path.startsWith("/tasks?")) return Promise.resolve({ items: [baseTask], page: { limit: 30, has_more: false, next_cursor: null } });
      return Promise.resolve({});
    });
    render(<TasksPage />);
    expect(await screen.findByText("Revisar proposta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Escopo" })).toBeInTheDocument();
  });

  it("Tarefas: concluir mostra a resposta imediata; falha não mostra nada", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/me") return Promise.resolve({ user: { id: "u1", isRoot: false }, permissions: [], actorScope: "workspace", rootWorkspaceAccess: false });
      if (path.startsWith("/tasks?")) return Promise.resolve({ items: [baseTask], page: { limit: 30, has_more: false, next_cursor: null } });
      if (init?.method === "PATCH") return Promise.reject(new Error("boom"));
      return Promise.resolve({});
    });
    const { rerender } = render(<TasksPage />);
    await user.click(await screen.findByRole("button", { name: "Concluir tarefa: Revisar proposta" }));
    await waitFor(() => { expect(apiMock).toHaveBeenCalledWith("/tasks/t1", expect.objectContaining({ method: "PATCH" })); });
    expect(screen.queryByText("Tarefa concluída")).toBeNull();

    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/me") return Promise.resolve({ user: { id: "u1", isRoot: false }, permissions: [], actorScope: "workspace", rootWorkspaceAccess: false });
      if (path.startsWith("/tasks?")) return Promise.resolve({ items: [baseTask], page: { limit: 30, has_more: false, next_cursor: null } });
      if (init?.method === "PATCH") return Promise.resolve({ task: { ...baseTask, status: "concluida", completed_at: "2026-09-24T10:00:00.000Z" } });
      return Promise.resolve({});
    });
    rerender(<TasksPage />);
    await user.click(await screen.findByRole("button", { name: "Concluir tarefa: Revisar proposta" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Tarefa concluída");
  });

  it("Follow-ups: HelpHint explica a automação ao lado do título", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/ai-follow-ups/settings") return Promise.resolve({ settings: { enabled: false, delaysMinutes: [120, 1440, 4320], delivery: [{ type: "text" }, { type: "text" }, { type: "text" }] } });
      if (path === "/ai-follow-ups/media") return Promise.resolve({ media: [] });
      if (path === "/ai-stickers") return Promise.resolve({ stickers: [] });
      return Promise.resolve({});
    });
    render(<FollowUpsPage />);
    expect(await screen.findByText("Cadência automática")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Follow-ups" })).toBeInTheDocument();
  });

  it("Bloqueio de horário: HelpHint explica o bloqueio recorrente", () => {
    render(
      <AgendaTimeBlockDialog
        open
        anchor="2026-09-24T10:00:00.000Z"
        timezone="UTC"
        initialRange={{ start: "2026-09-24T10:00:00.000Z", end: "2026-09-24T11:00:00.000Z" }}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Ajuda: Tipo de bloqueio" })).toBeInTheDocument();
  });
});

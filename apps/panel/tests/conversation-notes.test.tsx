// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { ConversationNotes } from "../components/conversation-notes";

type Recorded = { path: string; method: string; body?: Record<string, unknown> };

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["conversations.read", "conversations.reply"],
  actorScope: "workspace"
};

const MEMBERS = {
  members: [
    { user_id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", status: "active" },
    { user_id: "user-2", name: "Bruno Tavares", email: "bruno@exemplo.com", status: "active" },
    { user_id: "user-3", name: "Inativa Souza", email: "inativa@exemplo.com", status: "inactive" }
  ]
};

const NOTE = {
  id: "note-1",
  body: "Cliente pediu retorno amanhã.",
  author_id: "user-2",
  author_name: "Bruno Tavares",
  mentions: [{ id: "user-1", name: "Marina Duarte" }],
  created_at: "2026-09-18T12:00:00.000Z"
};

const calls: Recorded[] = [];

function jsonResponse(payload: unknown) {
  return Promise.resolve(payload);
}

function renderComponent() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ConversationNotes conversationId="conv-1" />
    </SWRConfig>
  );
}

beforeEach(() => {
  calls.length = 0;
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (path === "/me") return jsonResponse(SESSION);
    if (path === "/workspaces/current/members") return jsonResponse(MEMBERS);
    if (path === "/conversations/conv-1/notes" && method === "GET") return jsonResponse({ items: [NOTE] });
    if (path === "/conversations/conv-1/notes" && method === "POST") return jsonResponse({ id: "note-2" });
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("nota interna da conversa (R3)", () => {
  it("por padrão renderiza só o botão e não busca nada — estático (renderToStaticMarkup) é seguro", () => {
    const markup = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map() }}>
        <ConversationNotes conversationId="conv-1" />
      </SWRConfig>
    );
    expect(markup).toContain("Nota interna");
    expect(markup).not.toContain("Salvar nota");
    expect(apiMock).not.toHaveBeenCalled();

    renderComponent();
    const trigger = screen.getByRole("button", { name: "Nota interna" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Nova nota")).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("abrir busca as notas via GET e lista corpo, autor, menção e data", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(await screen.findByText("Cliente pediu retorno amanhã.")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/conversations/conv-1/notes");
    expect(screen.getByText("Bruno Tavares")).toBeInTheDocument();
    expect(screen.getByText("@Marina Duarte")).toBeInTheDocument();
    expect(screen.getByText(/18\/09\/2026/)).toBeInTheDocument();
    await screen.findByRole("button", { name: "Salvar nota" });
  });

  it("composer com @menção insere o id do membro em mentions[] no POST", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Nota interna" }));
    const editor = await screen.findByLabelText("Nova nota");
    await user.type(editor, "Alinhar com ");
    await user.type(editor, "@");
    const listbox = await screen.findByRole("listbox", { name: "Menções da equipe" });
    expect(editor).toHaveAttribute("aria-controls", "conversation-note-editor-mentions");
    await user.click(within(listbox).getByRole("option", { name: /Bruno Tavares/ }));
    expect(editor).toHaveValue("Alinhar com @Bruno Tavares ");
    await user.click(screen.getByRole("button", { name: "Salvar nota" }));
    await waitFor(() => {
      const posted = calls.find((call) => call.path === "/conversations/conv-1/notes" && call.method === "POST");
      expect(posted).toBeTruthy();
      expect(posted?.body).toEqual({ body: "Alinhar com @Bruno Tavares", mentions: ["user-2"] });
    });
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("sem conversations.reply não oferece composer, mas mantém a lista", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return jsonResponse({ ...SESSION, permissions: ["conversations.read"] });
      if (path === "/conversations/conv-1/notes") return jsonResponse({ items: [NOTE] });
      return jsonResponse({});
    });
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(await screen.findByText("Cliente pediu retorno amanhã.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nova nota")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar nota" })).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/workspaces/current/members");
  });

  it("sem notas mostra o estado vazio", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return jsonResponse(SESSION);
      if (path === "/workspaces/current/members") return jsonResponse(MEMBERS);
      if (path === "/conversations/conv-1/notes") return jsonResponse({ items: [] });
      return jsonResponse({});
    });
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(await screen.findByText("Nenhuma nota interna nesta conversa.")).toBeInTheDocument();
  });
});

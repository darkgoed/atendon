// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "@/components/conversation-composer";

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

const QUICK_REPLIES = [
  { shortcut: "proposta", body: "Envio a proposta {{nome}}" },
  { shortcut: "cumprimento", body: "Olá! Tudo bem?" },
  { shortcut: "hoje", body: "Hoje é {{data}}, falou {{atendente}}" }
];

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["conversations.reply"],
  actorScope: "workspace"
};

function renderComposer(contactName = "Aurora Nogueira") {
  const onError = vi.fn();
  const onSent = vi.fn();
  render(
    <ConversationComposer
      conversationId="conversation-quick"
      channel="whatsapp"
      contactName={contactName}
      onError={onError}
      onSent={onSent}
    />
  );
  return {
    onError,
    onSent,
    textarea: screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement
  };
}

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/quick-replies")) return jsonResponse({ items: QUICK_REPLIES });
    if (url.endsWith("/me")) return jsonResponse(SESSION);
    return jsonResponse({ ok: true });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("respostas rápidas do composer ('/')", () => {
  it("abre o autocomplete com '/' no início do texto e lista as respostas", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "/");
    const listbox = await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(listbox).toHaveTextContent("/proposta"));
    expect(listbox).toHaveTextContent("/cumprimento");
    expect(listbox).toHaveTextContent("/hoje");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("filtra pelo atalho e pelo conteúdo ao digitar", async () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
    const user = userEvent.setup();

    await user.type(textarea, "/prop");
    let listbox = await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(listbox).toHaveTextContent("/proposta"));
    expect(listbox).not.toHaveTextContent("/cumprimento");

    // O corpo também casa: "Tudo" só existe no corpo de /cumprimento.
    await user.clear(textarea);
    await user.type(textarea, "/tudo");
    listbox = await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(listbox).toHaveTextContent("/cumprimento"));
    expect(listbox).not.toHaveTextContent("/proposta");
  });

  it("navega com setas e Enter insere a resposta SEM enviar a mensagem", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "/");
    await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    // Primeira opção selecionada por padrão; ↓ avança, ↑ volta.
    expect(screen.getByRole("option", { name: /\/proposta/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /\/cumprimento/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /\/hoje/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    // A resolução das variáveis acontece na inserção (texto editável depois).
    expect(textarea.value).toMatch(/^Hoje é \d{2}\/\d{2}\/\d{4}, falou Marina Duarte $/);
    expect(textarea.value).not.toContain("{{");
    // Nenhuma mensagem foi disparada: a seleção intercepta antes do submit-guard.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSent).not.toHaveBeenCalled();
  });

  it("Tab seleciona a opção ativa e substitui o token '/...'", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "/prop");
    await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(screen.getByRole("option", { name: /\/proposta/ })).toBeInTheDocument());

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("Envio a proposta Aurora Nogueira ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSent).not.toHaveBeenCalled();
  });

  it("resolve as variáveis {{nome}}, {{atendente}} e {{data}} na inserção", async () => {
    const { textarea } = renderComposer("Aurora Nogueira");
    const user = userEvent.setup();

    await user.type(textarea, "/proposta");
    await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(screen.getByRole("option", { name: /\/proposta/ })).toBeInTheDocument());

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("Envio a proposta Aurora Nogueira ");
  });

  it("Esc fecha o popup e Enter depois disso volta a submeter normalmente", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "/");
    await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it("não envia o Enter enquanto o popup está aberto mesmo sem resultados", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "/xyz");
    await screen.findByRole("listbox", { name: "Sugestões de respostas rápidas" });
    await waitFor(() => expect(screen.getByText(/nenhuma resposta|↑/i).textContent).toBeTruthy());
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSent).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/xyz");
  });
});

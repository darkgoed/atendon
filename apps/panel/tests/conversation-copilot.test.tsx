// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConversationComposer, type ConversationComposerCapabilities } from "@/components/conversation-composer";

// SPEC comments-20260924-ai-conversas R3: copiloto sob demanda no composer.
// Contrato: POST /conversations/:id/copilot-suggestion {previous_suggestion?}
// → {suggestion, context_complete, messages_used, messages_total}.

type Suggestion = { suggestion: string; context_complete: boolean; messages_used: number; messages_total: number };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function suggestion(text: string, extra: Partial<Suggestion> = {}): Suggestion {
  return { suggestion: text, context_complete: true, messages_used: 4, messages_total: 4, ...extra };
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

let fetchMock: MockInstance<typeof fetch>;
let copilotQueue: Array<Response | Promise<Response>>;

const urlOf = (input: unknown) => typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
const copilotCalls = () => fetchMock.mock.calls.filter(([input]) => urlOf(input).includes("/copilot-suggestion"));
const copilotBody = (index: number) => JSON.parse(String(copilotCalls()[index][1]?.body ?? "null"));
const messagePosts = () => fetchMock.mock.calls.filter(([input, init]) => urlOf(input).includes("/messages") && init?.method === "POST");

// Commit lento (>5 ms): o Scheduler do React cede antes dos efeitos passivos,
// abrindo a janela real entre o commit de uma troca e a limpeza passiva.
function SlowCommit({ onCommit }: { onCommit: () => void }) {
  useLayoutEffect(() => {
    const until = performance.now() + 20;
    while (performance.now() < until) { /* espera ativa proposital */ }
    onCommit();
  }, [onCommit]);
  return null;
}

function composer(conversationId: string, overrides: Partial<React.ComponentProps<typeof ConversationComposer>> = {}) {
  return (
    <ConversationComposer
      conversationId={conversationId}
      channel="whatsapp"
      onError={overrides.onError ?? vi.fn()}
      onSent={overrides.onSent ?? vi.fn()}
      {...overrides}
    />
  );
}

function renderComposer(conversationId = "conv-1", overrides: Partial<React.ComponentProps<typeof ConversationComposer>> = {}) {
  const onError = vi.fn();
  const onSent = vi.fn();
  const props = { onError, onSent, ...overrides };
  const result = render(composer(conversationId, props));
  return {
    ...result,
    onError,
    onSent,
    switchTo: (id: string) => result.rerender(composer(id, props)),
    textarea: () => screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement
  };
}

beforeEach(() => {
  copilotQueue = [];
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url.includes("/copilot-suggestion")) {
      const next = copilotQueue.shift();
      if (!next) throw new Error("copiloto chamado sem resposta programada");
      return next;
    }
    if (url.includes("/quick-replies")) return jsonResponse({ items: [] });
    return jsonResponse({ ok: true });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("copiloto de IA no composer (R3)", () => {
  it("não chama a IA no mount, na digitação nem na troca de conversa", async () => {
    const user = userEvent.setup();
    const view = renderComposer("conv-1");
    await user.type(view.textarea(), "Olá, tudo bem?");
    view.switchTo("conv-2");
    await user.type(view.textarea(), "Outro texto");
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("button", { name: "Gerar sugestão da IA" })).toBeEnabled();
    expect(copilotCalls()).toHaveLength(0);
  });

  it("faz uma geração por clique, mesmo com clique duplo no mesmo tick", async () => {
    const pending = deferred();
    copilotQueue.push(pending.promise);
    renderComposer("conv-1");
    const button = screen.getByRole("button", { name: "Gerar sugestão da IA" });

    act(() => {
      button.click();
      button.click();
    });
    expect(copilotCalls()).toHaveLength(1);
    expect(urlOf(copilotCalls()[0][0])).toContain("/conversations/conv-1/copilot-suggestion");
    expect(copilotCalls()[0][1]?.method).toBe("POST");
    expect(copilotBody(0)).toEqual({});
    expect(screen.getByRole("button", { name: "Gerando sugestão da IA" })).toBeDisabled();

    await act(async () => { pending.resolve(jsonResponse(suggestion("Posso te enviar a proposta hoje?"))); });
    expect(await screen.findByText("Posso te enviar a proposta hoje?")).toBeInTheDocument();
    expect(copilotCalls()).toHaveLength(1);
  });

  it("regenerar envia a sugestão anterior mais recente e troca pela nova", async () => {
    copilotQueue.push(
      jsonResponse(suggestion("Primeira sugestão")),
      jsonResponse(suggestion("Segunda sugestão")),
      jsonResponse(suggestion("Terceira sugestão"))
    );
    renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    expect(await screen.findByText("Primeira sugestão")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gerar outra sugestão da IA" }));
    expect(await screen.findByText("Segunda sugestão")).toBeInTheDocument();
    expect(screen.queryByText("Primeira sugestão")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Gerar outra sugestão da IA" }));
    expect(await screen.findByText("Terceira sugestão")).toBeInTheDocument();

    expect(copilotBody(0)).toEqual({});
    expect(copilotBody(1)).toEqual({ previous_suggestion: "Primeira sugestão" });
    expect(copilotBody(2)).toEqual({ previous_suggestion: "Segunda sugestão" });
  });

  it("falha do provedor e quota viram erro acionável, sem sugestão falsa e com nova tentativa liberada", async () => {
    copilotQueue.push(
      jsonResponse({ error: "Falha ao gerar a sugestão de IA" }, 502),
      jsonResponse(suggestion("Sugestão válida")),
      jsonResponse({ error: "Limite de interações de IA do plano atingido", code: "ai_quota_exceeded" }, 402)
    );
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Falha ao gerar a sugestão de IA"));
    expect(screen.queryByRole("group", { name: "Sugestão da IA" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Gerar sugestão da IA" }));
    expect(await screen.findByText("Sugestão válida")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gerar outra sugestão da IA" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Limite de interações de IA do plano atingido"));
    expect(screen.getByText("Sugestão válida")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar outra sugestão da IA" })).toBeEnabled();
    expect(copilotBody(2)).toEqual({ previous_suggestion: "Sugestão válida" });
    expect(copilotCalls()).toHaveLength(3);
    expect(messagePosts()).toHaveLength(0);
  });

  it("resposta atrasada da conversa anterior não altera o composer atual", async () => {
    const stale = deferred();
    const current = deferred();
    copilotQueue.push(stale.promise, current.promise);
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    view.switchTo("conv-2");
    const button = screen.getByRole("button", { name: "Gerar sugestão da IA" });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(urlOf(copilotCalls()[1][0])).toContain("/conversations/conv-2/copilot-suggestion");
    expect(copilotBody(1)).toEqual({});

    await act(async () => { stale.resolve(jsonResponse(suggestion("Resposta da conversa antiga"))); });
    expect(screen.queryByText("Resposta da conversa antiga")).toBeNull();
    expect(screen.getByRole("button", { name: "Gerando sugestão da IA" })).toBeDisabled();

    await act(async () => { current.resolve(jsonResponse(suggestion("Resposta da conversa atual"))); });
    expect(await screen.findByText("Resposta da conversa atual")).toBeInTheDocument();
    expect(view.textarea().value).toBe("");
  });

  it("erro atrasado da conversa anterior não é exibido na atual", async () => {
    const stale = deferred();
    copilotQueue.push(stale.promise);
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    view.switchTo("conv-2");
    await act(async () => { stale.resolve(jsonResponse({ error: "Falha ao gerar a sugestão de IA" }, 502)); });

    expect(view.onError).not.toHaveBeenCalledWith("Falha ao gerar a sugestão de IA");
    expect(screen.getByRole("button", { name: "Gerar sugestão da IA" })).toBeEnabled();
  });

  it("sugestão só vira rascunho editável no clique do operador, com confirmação se já houver texto, e nunca é enviada", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    copilotQueue.push(pending.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await user.type(view.textarea(), "Texto do operador");
    await act(async () => { pending.resolve(jsonResponse(suggestion("Sugestão da IA pronta"))); });
    await screen.findByText("Sugestão da IA pronta");
    expect(view.textarea().value).toBe("Texto do operador");

    await user.click(screen.getByRole("button", { name: "Usar sugestão" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(view.textarea().value).toBe("Texto do operador");

    await user.click(screen.getByRole("button", { name: "Usar sugestão" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(view.textarea().value).toBe("Sugestão da IA pronta");

    await user.type(view.textarea(), " Editado.");
    expect(view.textarea().value).toBe("Sugestão da IA pronta Editado.");
    expect(messagePosts()).toHaveLength(0);
    expect(view.onSent).not.toHaveBeenCalled();
  });

  it("com rascunho vazio usa a sugestão sem confirmação e descartar não toca o rascunho", async () => {
    const user = userEvent.setup();
    copilotQueue.push(jsonResponse(suggestion("Olá! Posso ajudar?")));
    const confirm = vi.spyOn(window, "confirm");
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await screen.findByText("Olá! Posso ajudar?");
    await user.click(screen.getByRole("button", { name: "Usar sugestão" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(view.textarea().value).toBe("Olá! Posso ajudar?");

    await user.click(screen.getByRole("button", { name: "Descartar sugestão" }));
    expect(screen.queryByRole("group", { name: "Sugestão da IA" })).toBeNull();
    expect(view.textarea().value).toBe("Olá! Posso ajudar?");
    expect(messagePosts()).toHaveLength(0);
  });

  it("avisa explicitamente quando o histórico não coube inteiro", async () => {
    copilotQueue.push(
      jsonResponse(suggestion("Sugestão parcial", { context_complete: false, messages_used: 30, messages_total: 120 })),
      jsonResponse(suggestion("Sugestão completa"))
    );
    renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await screen.findByText("Sugestão parcial");
    expect(screen.getByText(/considerou as 30 mensagens mais recentes de 120/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gerar outra sugestão da IA" }));
    await screen.findByText("Sugestão completa");
    expect(screen.queryByText(/mensagens mais recentes de/)).toBeNull();
  });

  it("janela do Instagram fechada: gera sugestão, mas o envio segue bloqueado pelo canal", async () => {
    const closed: ConversationComposerCapabilities = {
      channel: "instagram",
      can_send: true,
      reason: null,
      window_expires_at: "2020-01-01T00:00:00.000Z",
      text: true,
      image: true,
      audio: true,
      video: true,
      document: false
    };
    copilotQueue.push(jsonResponse(suggestion("Sugestão para janela fechada")));
    renderComposer("conv-ig", { channel: "instagram", capabilities: closed });

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await screen.findByText("Sugestão para janela fechada");

    expect(screen.getByRole("button", { name: "Usar sugestão" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Mensagem" })).toBeDisabled();
    expect(messagePosts()).toHaveLength(0);
  });

  it("resposta vazia ou malformada do servidor vira erro acionável, sem chip falso e sem perder a sugestão válida", async () => {
    const invalid = "A IA não retornou uma sugestão válida. Tente novamente.";
    copilotQueue.push(
      new Response(null, { status: 204 }),
      jsonResponse(suggestion("Sugestão válida")),
      jsonResponse({}),
      jsonResponse(suggestion("   ")),
      jsonResponse({ suggestion: "Sem metadados de contexto" })
    );
    const view = renderComposer("conv-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão da IA" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith(invalid));
    expect(screen.queryByRole("group", { name: "Sugestão da IA" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Gerar sugestão da IA" }));
    await screen.findByText("Sugestão válida");

    for (const calls of [3, 4, 5]) {
      view.onError.mockClear();
      fireEvent.click(await screen.findByRole("button", { name: "Gerar outra sugestão da IA" }));
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith(invalid));
      expect(copilotCalls()).toHaveLength(calls);
      expect(screen.getByRole("group", { name: "Sugestão da IA" })).toHaveTextContent("Sugestão válida");
    }
    expect(screen.queryByText(/undefined/)).toBeNull();
    expect(view.textarea().value).toBe("");
    expect(messagePosts()).toHaveLength(0);
  });

  it("erro que chega entre o commit da troca e a limpeza passiva não vaza para a conversa atual", async () => {
    // Sem act(): agenda real do React, como numa troca não discreta (navegação/transição).
    // Espelha app/conversas/page.tsx, que remonta o composer com key={selected}.
    const stale = deferred();
    copilotQueue.push(stale.promise);
    const onError = vi.fn();
    const staleError = {
      ok: false,
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "Falha ao gerar a sugestão de IA" })
    } as unknown as Response;
    const tree = (id: string, onCommit?: () => void) => (
      <>
        <ConversationComposer key={id} conversationId={id} channel="whatsapp" onError={onError} onSent={vi.fn()} />
        {onCommit ? <SlowCommit onCommit={onCommit} /> : null}
      </>
    );
    const env = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const generateButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Gerar sugestão da IA"]');
    try {
      root.render(tree("conv-1"));
      await vi.waitFor(() => expect(generateButton()).not.toBeNull());
      generateButton()?.click();
      await vi.waitFor(() => expect(host.querySelector('button[aria-label="Gerando sugestão da IA"]')).not.toBeNull());
      expect(copilotCalls()).toHaveLength(1);

      // O erro da conversa antiga chega no commit da troca, antes da limpeza passiva.
      root.render(tree("conv-2", () => stale.resolve(staleError)));
      await vi.waitFor(() => expect(generateButton()).not.toBeNull());
      await new Promise((done) => setTimeout(done, 30));

      expect(onError.mock.calls.filter(([message]) => message)).toEqual([]);
    } finally {
      root.unmount();
      host.remove();
      env.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});

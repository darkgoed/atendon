// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "@/components/conversation-composer";

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function renderComposer() {
  const onError = vi.fn();
  const onSent = vi.fn();
  render(
    <ConversationComposer
      conversationId="conversation-compat"
      channel="whatsapp"
      onError={onError}
      onSent={onSent}
    />
  );
  return { onError, onSent, textarea: screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement };
}

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationComposer teclado e compatibilidade de submit", () => {
  it("Enter envia; Shift+Enter continua quebrando linha", async () => {
    const { onSent, textarea } = renderComposer();
    const user = userEvent.setup();

    await user.type(textarea, "primeira{Shift>}{Enter}{/Shift}segunda");
    expect(textarea.value).toBe("primeira\nsegunda");
    expect(onSent).not.toHaveBeenCalled();

    await user.type(textarea, "{Enter}");
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it("não envia o Enter que confirma a composição do IME na ordem do Safari", async () => {
    const { onSent, textarea } = renderComposer();

    // Ordem observada no Safari: compositionstart → edição → compositionend →
    // keydown do Enter que confirma (com isComposing já false).
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "texto do IME" } });
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    expect(onSent).not.toHaveBeenCalled();

    // O Enter seguinte, fora de composição, envia.
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it("não envia o keydown do IME marcado como Process (keyCode 229, ordem do Chrome)", async () => {
    const { onSent, textarea } = renderComposer();

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSent).not.toHaveBeenCalled();
  });

  it("envia pelo fallback nativo quando requestSubmit não existe (Safari < 16)", async () => {
    const formPrototype = HTMLFormElement.prototype as unknown as Record<string, unknown>;
    const nativeDescriptor = Object.getOwnPropertyDescriptor(formPrototype, "requestSubmit");
    // Simula Safari antigo: requestSubmit ausente — antes gerava
    // "a.requestSubmit is not a function" e impedia o envio pelo Enter.
    Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", { configurable: true, value: undefined });
    try {
      const { onError, onSent, textarea } = renderComposer();
      const user = userEvent.setup();

      await user.type(textarea, "mensagem no Safari antigo");
      await user.type(textarea, "{Enter}");

      await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
      // send() limpa erros com onError("") — nenhum erro real pode ter sido
      // reportado no fluxo do fallback.
      expect(onError.mock.calls.every((call) => call[0] === "")).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/backend/conversations/conversation-compat/messages",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      if (nativeDescriptor) {
        Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", nativeDescriptor);
      } else {
        delete formPrototype.requestSubmit;
      }
    }
  });

  it("Enter sem conteúdo não dispara envio nem erro", async () => {
    const { onError, onSent, textarea } = renderComposer();
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    expect(onSent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

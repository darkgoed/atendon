// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "@/components/conversation-composer";

// PAINEL C13: o composer é remontado ao trocar de conversa (key={selected}),
// ao reativar a IA ou ao resolver; o texto meio digitado se perdia.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function composer(conversationId: string, onSent = vi.fn()) {
  return <ConversationComposer key={conversationId} conversationId={conversationId} channel="whatsapp" onError={vi.fn()} onSent={onSent} />;
}

const textarea = () => screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("/quick-replies")) return jsonResponse({ items: [] });
    return jsonResponse({ ok: true, message_id: "m-1" });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("rascunho do composer por conversa (PAINEL C13)", () => {
  it("volta ao reabrir a conversa e não vaza para outra", () => {
    const view = render(composer("conv-1"));
    fireEvent.change(textarea(), { target: { value: "Oi Ana, sobre a proposta" } });

    view.rerender(composer("conv-2"));
    expect(textarea().value).toBe("");

    view.rerender(composer("conv-1"));
    expect(textarea().value).toBe("Oi Ana, sobre a proposta");
  });

  it("some depois do envio bem-sucedido", async () => {
    const onSent = vi.fn();
    const view = render(composer("conv-1", onSent));
    fireEvent.change(textarea(), { target: { value: "Mensagem enviada" } });
    fireEvent.submit(textarea().closest("form")!);
    await waitFor(() => expect(onSent).toHaveBeenCalled());

    view.unmount();
    render(composer("conv-1"));
    expect(textarea().value).toBe("");
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer, type ConversationComposerCapabilities } from "@/components/conversation-composer";

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function whatsappCapabilities(overrides: Partial<ConversationComposerCapabilities> = {}): ConversationComposerCapabilities {
  return {
    channel: "whatsapp",
    can_send: true,
    reason: null,
    window_expires_at: null,
    text: true,
    image: true,
    audio: true,
    video: false,
    document: true,
    ...overrides
  };
}

function instagramCapabilities(overrides: Partial<ConversationComposerCapabilities> = {}): ConversationComposerCapabilities {
  return whatsappCapabilities({ channel: "instagram", document: false, video: false, ...overrides });
}

function imageFile(size = 1024): globalThis.File {
  const file = new globalThis.File([new Uint8Array(8)], "colada.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function pasteEvent(data: { files?: globalThis.File[]; text?: string }): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  const files = data.files ?? [];
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      types: [...(data.text !== undefined ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
      getData: (type: string) => (type === "text/plain" ? data.text ?? "" : "")
    }
  });
  return event;
}

function renderComposer(options: { channel?: "whatsapp" | "instagram"; capabilities?: ConversationComposerCapabilities } = {}) {
  const onError = vi.fn();
  const onSent = vi.fn();
  render(
    <ConversationComposer
      conversationId="conversation-paste"
      channel={options.channel ?? "whatsapp"}
      capabilities={options.capabilities}
      onError={onError}
      onSent={onSent}
    />
  );
  return { onError, onSent, textarea: screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement };
}

beforeEach(() => {
  // jsdom não implementa blob URLs — o composer usa createObjectURL para a prévia.
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationComposer colar imagem (CTRL+V)", () => {
  it("paste de imagem vira anexo com prévia e só envia após submit", async () => {
    const { onSent, textarea } = renderComposer();
    const file = imageFile();

    fireEvent(textarea, pasteEvent({ files: [file] }));

    const preview = await screen.findByAltText("Prévia do anexo");
    expect(preview).toBeVisible();
    expect(textarea.value).toBe("");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.type(textarea, "legenda");
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/backend/conversations/conversation-paste/messages",
      expect.objectContaining({ method: "POST" })
    );
    expect(screen.queryByAltText("Prévia do anexo")).not.toBeInTheDocument();
  });

  it("paste de texto puro não é interceptado e o draft muda", () => {
    const { onError, textarea } = renderComposer();

    const event = pasteEvent({ text: "texto colado" });
    fireEvent(textarea, event);
    expect(event.defaultPrevented).toBe(false);

    // jsdom não insere texto no paste: o navegador o faria; simulamos o
    // resultado no onChange para verificar o draft.
    fireEvent.change(textarea, { target: { value: "texto colado" } });
    expect(textarea.value).toBe("texto colado");
    expect(onError).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("paste com texto e arquivo: o arquivo vence e o draft não recebe o texto", async () => {
    const { textarea } = renderComposer();
    const file = imageFile();

    const event = pasteEvent({ text: "texto junto", files: [file] });
    fireEvent(textarea, event);

    expect(event.defaultPrevented).toBe(true);
    await screen.findByAltText("Prévia do anexo");
    expect(textarea.value).toBe("");
  });

  it("paste de imagem em canal sem capability image reporta erro e não anexa", async () => {
    const { onError, textarea } = renderComposer({
      channel: "instagram",
      capabilities: instagramCapabilities({ image: false })
    });

    const event = pasteEvent({ files: [imageFile()] });
    fireEvent(textarea, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onError).toHaveBeenCalledWith("Imagem não é suportada por este canal");
    expect(screen.queryByAltText("Prévia do anexo")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("paste de imagem acima do limite reporta erro de limite e não anexa", async () => {
    const { onError, textarea } = renderComposer();

    fireEvent(textarea, pasteEvent({ files: [imageFile(17 * 1024 * 1024)] }));

    expect(onError).toHaveBeenCalledWith("O limite para este anexo é 16 MB");
    expect(screen.queryByAltText("Prévia do anexo")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

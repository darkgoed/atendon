// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer, type ConversationComposerCapabilities } from "@/components/conversation-composer";

const openCapabilities: ConversationComposerCapabilities = {
  channel: "instagram",
  can_send: true,
  reason: null,
  window_expires_at: "2030-05-07T14:30:00.000Z",
  text: true,
  image: true,
  audio: true,
  video: true,
  document: false
};

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function renderComposer(overrides: Partial<React.ComponentProps<typeof ConversationComposer>> = {}) {
  const onError = vi.fn();
  const onSent = vi.fn();
  const result = render(
    <ConversationComposer
      conversationId="conversation-ig"
      channel="instagram"
      capabilities={openCapabilities}
      onError={onError}
      onSent={onSent}
      {...overrides}
    />
  );
  return { ...result, onError, onSent };
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ConversationComposer Instagram interactions", () => {
  it("fails closed while Instagram capabilities are pending or failed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    const { rerender } = render(
      <ConversationComposer
        conversationId="conversation-ig"
        channel="instagram"
        onError={vi.fn()}
        onSent={vi.fn()}
      />
    );

    expect(screen.getByRole("textbox", { name: "Mensagem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Anexar arquivo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Verificando as permissões de envio do Instagram");

    rerender(
      <ConversationComposer
        conversationId="conversation-ig"
        channel="instagram"
        capabilities={openCapabilities}
        capabilitiesError={new Error("offline")}
        onError={vi.fn()}
        onSent={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Não foi possível verificar as permissões de envio do Instagram");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires the 24-hour window while the thread remains open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-05-06T14:29:59.000Z"));
    renderComposer({ capabilities: { ...openCapabilities, window_expires_at: "2030-05-06T14:30:00.000Z" } });

    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Ainda dentro da janela" } });
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeEnabled();

    act(() => vi.advanceTimersByTime(1_001));

    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Mensagem" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("janela de 24 horas");
  });

  it("rejects unsupported media on selection without calling the API", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    const { onError } = renderComposer({ capabilities: { ...openCapabilities, video: false } });
    const video = new File(["video-real"], "demo.mp4", { type: "video/mp4" });

    fireEvent.change(screen.getByLabelText("Selecionar arquivo para anexar"), { target: { files: [video] } });

    expect(onError).toHaveBeenCalledWith("Vídeo não é suportado por este canal");
    expect(screen.queryByText("demo.mp4")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["image", "foto.png", "image/png", "imagem-real"],
    ["audio", "audio.ogg", "audio/ogg", "audio-real"],
    ["video", "video.mp4", "video/mp4", "video-real"]
  ] as const)("sends a real %s file only when the capability allows it", async (mediaType, fileName, mimeType, contents) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ ok: true });
    });
    const { onSent } = renderComposer({
      replyTo: mediaType === "image" ? { id: "message-parent", content: "original", sender: "contact" } : null
    });
    const file = new File([contents], fileName, { type: mimeType, lastModified: 123 });

    fireEvent.change(screen.getByLabelText("Selecionar arquivo para anexar"), { target: { files: [file] } });
    expect(await screen.findByText(mediaType === "audio" ? "audio" : fileName)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/backend/conversations/conversation-ig/messages");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("Idempotency-Key")).toBe("00000000-0000-4000-8000-000000000001");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body).toMatchObject({ mediaType, mimeType, fileName });
    expect(body.dataBase64).toBe(btoa(contents));
    if (mediaType === "image") expect(body.replyToMessageId).toBe("message-parent");
  });

  it("keeps video unavailable for WhatsApp until its capability explicitly enables it", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    const { onError } = renderComposer({ channel: "whatsapp", capabilities: undefined });
    const video = new File(["video-real"], "whatsapp.mp4", { type: "video/mp4" });

    fireEvent.change(screen.getByLabelText("Selecionar arquivo para anexar"), { target: { files: [video] } });

    expect(onError).toHaveBeenCalledWith("Vídeo não é suportado por este canal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves WhatsApp fail-open behavior when the capability endpoint is absent", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ ok: true });
    });
    renderComposer({ channel: "whatsapp", capabilities: undefined });

    await userEvent.setup().type(screen.getByRole("textbox", { name: "Mensagem" }), "Resposta WhatsApp");
    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ text: "Resposta WhatsApp" });
  });
});

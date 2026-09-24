// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationContactPanel } from "../components/conversation-contact-panel";
import { ConversationMessageMedia } from "../components/conversation-message-media";

// Notas internas buscam na API ao montar; fora do escopo deste teste.
vi.mock("../components/conversation-notes", () => ({ ConversationNotes: () => null }));

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// SPEC R2: o modal mostra a MESMA src autenticada da miniatura (rota de mídia da
// conversa), preserva o alt, tem nome acessível e nenhum link de nova aba.
async function expectModalWith(thumb: HTMLElement, messageId: string) {
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveAccessibleName();
  const full = within(dialog).getByRole("img", { name: thumb.getAttribute("alt") ?? "" });
  expect(full).toHaveAttribute("src", thumb.getAttribute("src"));
  expect(full.getAttribute("src")).toMatch(new RegExp(`/conversations/conversation-1/messages/${messageId}/media$`));
  expect(dialog.querySelector('a[target="_blank"]')).toBeNull();
  return dialog;
}

async function expectClosedWithFocusOn(trigger: RegExp) {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: trigger })).toHaveFocus());
}

describe("SPEC R2 — imagens da conversa em modal", () => {
  it("imagem do chat abre no modal; X e Escape fecham e devolvem o foco; teclado reabre; sem nova aba", async () => {
    const user = userEvent.setup();
    render(
      <ConversationMessageMedia
        conversationId="conversation-1"
        message={{ id: "image-1", content: "Pôr do sol na serra", media_type: "image", media_file_name: "serra.jpg" }}
      />
    );
    expect(screen.getByText("Pôr do sol na serra")).toBeInTheDocument(); // legenda preservada
    const thumb = screen.getByRole("img", { name: "Pôr do sol na serra" });

    await user.click(thumb);
    const dialog = await expectModalWith(thumb, "image-1");
    await user.click(within(dialog).getByRole("button", { name: "Fechar" }));
    await expectClosedWithFocusOn(/abrir imagem/i);

    await user.keyboard("{Enter}");
    await expectModalWith(thumb, "image-1");
    await user.keyboard("{Escape}");
    await expectClosedWithFocusOn(/abrir imagem/i);

    expect(document.querySelector('a[target="_blank"]')).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("figurinha abre no modal com a mesma src e o backdrop fecha devolvendo o foco", async () => {
    const user = userEvent.setup();
    render(
      <ConversationMessageMedia
        conversationId="conversation-1"
        message={{ id: "sticker-1", content: "", media_type: "image", media_is_sticker: true }}
      />
    );
    const thumb = screen.getByRole("img", { name: "Figurinha" });

    await user.click(thumb);
    await expectModalWith(thumb, "sticker-1");
    await user.click(document.querySelector<HTMLElement>(".overlay-backdrop")!);
    await expectClosedWithFocusOn(/abrir figurinha/i);

    expect(document.querySelector('a[target="_blank"]')).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("documento continua download direto, sem modal", () => {
    const { container } = render(
      <ConversationMessageMedia
        conversationId="conversation-1"
        message={{ id: "doc-1", content: "", media_type: "document", media_file_name: "contrato.pdf" }}
      />
    );
    expect(container.querySelector("a[download]")).toHaveAttribute(
      "href",
      expect.stringMatching(/\/conversations\/conversation-1\/messages\/doc-1\/media$/)
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("miniatura da aba Mídia abre o modal e Escape fecha só o modal, não o painel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <ConversationContactPanel
        conversation={{ id: "conversation-1", contact_name: "Aurora Nogueira", contact_phone: "+55 11 98888-1200" }}
        messages={[{ id: "image-1", content: "", media_type: "image", media_file_name: "roteiro.jpg" }]}
        onClose={onClose}
        onClearConversation={vi.fn()}
        onSaveContactName={async () => undefined}
      />
    );
    // O painel refoca o próprio botão de fechar num rAF ao montar; deixa assentar.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const media = container.querySelector<HTMLElement>("#contact-panel-media")!;
    const thumb = within(media).getByRole("img", { name: "roteiro.jpg" });

    await user.click(thumb);
    await expectModalWith(thumb, "image-1");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled(); // bug atual: listener do painel no document fecha tudo
    await expectClosedWithFocusOn(/abrir roteiro\.jpg/i);

    await user.keyboard("{Escape}"); // sem modal aberto, Escape continua fechando o painel
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(media.querySelector('a[target="_blank"]')).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });
});

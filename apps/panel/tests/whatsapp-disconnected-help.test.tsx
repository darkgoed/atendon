import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppDisconnectedHelp } from "../components/whatsapp-disconnected-help";
import { friendlyPanelError, isWhatsAppDisconnectedError } from "../lib/whatsapp-support";

describe("WhatsApp disconnected help", () => {
  it("replaces the Evolution socket error with reconnection guidance", () => {
    const raw = "Evolution API recusou a operação (HTTP 400): Error: Connection Closed";

    expect(isWhatsAppDisconnectedError(raw)).toBe(true);
    expect(friendlyPanelError(raw)).toBe("O WhatsApp foi desconectado. Reconecte a sessão para voltar a enviar mensagens.");
  });

  it("renders a support button with a prefilled message to the configured number", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(<WhatsAppDisconnectedHelp />);

    expect(html).toContain("Enviar mensagem para suporte");
    expect(html).toContain("https://wa.me/5512996062155?text=");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("preciso%20de%20ajuda%20para%20reconectar");
  });

  it("does not rewrite unrelated errors", () => {
    expect(friendlyPanelError("Falha na requisição (503)")).toBe("Falha na requisição (503)");
  });
});

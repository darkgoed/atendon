import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationContactPanel } from "../components/conversation-contact-panel";

describe("ConversationContactPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders contact identity, destructive action, and media tabs", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <ConversationContactPanel
        conversation={{
          id: "conversation-1",
          contact_name: "Aurora Nogueira",
          contact_phone: "+55 11 98888-1200",
          avatar_url: null
        }}
        messages={[
          { id: "image-1", content: "", media_type: "image", media_file_name: "roteiro.jpg" },
          { id: "doc-1", content: "", media_type: "document", media_file_name: "contrato.pdf", media_mime_type: "application/pdf" },
          { id: "link-1", content: "Veja https://tripz.example/oferta", media_type: null }
        ]}
        onClose={() => undefined}
        onClearConversation={() => undefined}
        onSaveContactName={async () => undefined}
      />
    );
    expect(markup).toContain("Aurora Nogueira");
    expect(markup).toContain("+55 11 98888-1200");
    expect(markup).toContain("Limpar conversa");
    expect(markup).toContain("Mídia");
    expect(markup).toContain("Links");
    expect(markup).toContain("Docs");
    expect(markup).toContain('aria-controls="contact-panel-media"');
    expect(markup).toContain('aria-labelledby="contact-panel-media-tab"');
  });

  it("keeps already loaded previews visible when a later page fails", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <ConversationContactPanel
        conversation={{ id: "conversation-1", contact_phone: "+55 11 98888-1200" }}
        messages={[{ id: "image-1", content: "", media_type: "image", media_file_name: "roteiro.jpg" }]}
        assetsError="A próxima página falhou"
        assetsHasMore
        onClose={() => undefined}
        onLoadMoreAssets={() => undefined}
        onRetryAssets={() => undefined}
        onClearConversation={() => undefined}
        onSaveContactName={async () => undefined}
      />
    );
    expect(markup).toContain("A próxima página falhou");
    expect(markup).toContain("roteiro.jpg");
    expect(markup).toContain("Tentar novamente");
    expect(markup).toContain("Carregar mais conteúdo");
  });

  it("does not offer mutations to a read-only operator", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <ConversationContactPanel
        conversation={{
          id: "conversation-1",
          contact_name: "Aurora Nogueira",
          contact_phone: "+55 11 98888-1200",
          avatar_url: null
        }}
        messages={[]}
        canEdit={false}
        onClose={() => undefined}
        onClearConversation={() => undefined}
        onSaveContactName={async () => undefined}
      />
    );
    expect(markup).not.toContain("Editar nome do contato");
    expect(markup).not.toContain("Limpar conversa");
  });
});

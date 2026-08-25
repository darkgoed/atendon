import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeTripzComposerFiles, TripzComposer } from "../components/tripz-ai/composer";
import { TripzConversationView } from "../components/tripz-ai/conversation-view";
import { TripzHistorySidebar } from "../components/tripz-ai/history-sidebar";
import { TripzProposalReview } from "../components/tripz-ai/proposal-review";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("Tripz composer accessibility", () => {
  it("removes completed but unlinked uploads when the composer is abandoned", async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined);
    const revokePreview = vi.fn();
    disposeTripzComposerFiles("conversation-1", [{
      previewUrl: "blob:hotel",
      attachment: { id: "attachment-orphan" }
    }], removeAttachment, revokePreview);
    await vi.waitFor(() => expect(removeAttachment).toHaveBeenCalledWith("conversation-1", "attachment-orphan"));
    expect(revokePreview).toHaveBeenCalledWith("blob:hotel");
  });

  it("renders one labeled composer with multiple upload, keyboard help and disabled send", () => {
    const html = renderToStaticMarkup(
      <TripzComposer conversationId="conversation-1" onSent={() => undefined} />
    );
    expect(html).toContain('id="tripz-message"');
    expect(html).toContain('for="tripz-message"');
    expect(html).toContain('placeholder="Envie informações da viagem…"');
    expect(html).toContain("multiple");
    expect(html).toContain("image/jpeg,image/png,image/webp,application/pdf");
    expect(html).toContain("Enter envia");
    expect(html).toContain('aria-label="Enviar mensagem"');
    expect(html).toContain("disabled");
  });

  it("announces processing and blocks input while the active turn is running", () => {
    const html = renderToStaticMarkup(
      <TripzComposer conversationId="conversation-1" processing onSent={() => undefined} />
    );
    expect(html).toContain('placeholder="Aguarde a análise atual…"');
    expect(html).toContain("disabled");
  });
});

describe("Tripz proposal review", () => {
  it("isolates generated HTML in a scriptless sandbox and exposes the PDF download", () => {
    const html = renderToStaticMarkup(
      <TripzProposalReview
        conversationId="conversation-1"
        proposal={{
          id: "proposal-1",
          revision: 4,
          status: "ready_for_pdf",
          title: "Aruba · Marina e Caio",
          clientName: "Marina e Caio",
          destination: "Aruba",
          missingInformation: [],
          inconsistencies: [],
          state: { itinerary: [{ dayNumber: 1 }], flights: [], includedItems: [] }
        }}
        preview={{ id: "preview-1", kind: "preview", proposalRevision: 4, status: "ready", html: "<!doctype html><script>alert(1)</script><h1>Aruba</h1>" }}
        pdf={{ id: "pdf-1", kind: "pdf", proposalRevision: 4, status: "ready", filename: "aruba.pdf" }}
        generatingPreview={false}
        generatingPdf={false}
        processing={false}
        onClose={() => undefined}
        onGeneratePreview={() => undefined}
        onGeneratePdf={() => undefined}
        onRequestCorrection={() => undefined}
      />
    );
    expect(html).toContain('title="Prévia segura da proposta Tripz"');
    expect(html).toContain('sandbox=""');
    expect(html).toContain("srcDoc");
    expect(html).toContain("Baixar PDF");
    expect(html).toContain("/tripz-ai/conversations/conversation-1/documents/pdf-1/content");
  });
});

describe("Tripz conversation states", () => {
  it("exposes the mobile history as a modal with discoverable touch actions", () => {
    const html = renderToStaticMarkup(
      <TripzHistorySidebar
        conversations={[{
          id: "conversation-mobile",
          title: "Aruba",
          status: "collecting",
          processingStatus: "idle",
          createdAt: "2026-08-14T10:00:00.000Z",
          updatedAt: "2026-08-14T10:00:00.000Z"
        }]}
        selectedId="conversation-mobile"
        loading={false}
        creating={false}
        loadingMore={false}
        hasMore={false}
        mobileOpen
        onCloseMobile={() => undefined}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onDelete={() => undefined}
        onRename={async () => undefined}
        onLoadMore={() => undefined}
      />
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("data-autofocus");
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("opacity-100");
  });

  it("renders persisted attachments, proposal summary and the processing state together", () => {
    const html = renderToStaticMarkup(
      <TripzConversationView
        conversation={{
          id: "conversation-4",
          title: "Fernando de Noronha",
          status: "ready_for_review",
          processingStatus: "processing",
          createdAt: "2026-08-14T10:00:00.000Z",
          updatedAt: "2026-08-14T10:05:00.000Z"
        }}
        messages={[{
          id: "message-4",
          role: "user",
          content: "Seguem os voos",
          createdAt: "2026-08-14T10:01:00.000Z",
          metadata: {},
          processingStatus: "completed",
          attachments: [{
            id: "attachment-4",
            filename: "voos.pdf",
            mimeType: "application/pdf",
            size: 2048,
            processingStatus: "processed"
          }]
        }]}
        proposal={{
          id: "proposal-4",
          revision: 2,
          status: "ready_for_review",
          destination: "Fernando de Noronha",
          missingInformation: ["Valor total"],
          inconsistencies: [],
          state: {}
        }}
        loading={false}
        onOpenHistory={() => undefined}
        onOpenReview={() => undefined}
        onRetry={() => undefined}
        onRetryTurn={async () => undefined}
        onSent={() => undefined}
      />
    );
    expect(html).toContain("Seguem os voos");
    expect(html).toContain("voos.pdf");
    expect(html).toContain("Resumo da proposta atualizado");
    expect(html).toContain("Analisando dados");
    expect(html).toContain('placeholder="Aguarde a análise atual…"');
  });
});

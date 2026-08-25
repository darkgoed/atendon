import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { TripzAccessScope, TripzProposal } from "../src/modules/tripz-ai/domain.js";
import type { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import { createTripzBrandConfig } from "../src/modules/tripz-ai/document/brand.js";
import { TripzDocumentService } from "../src/modules/tripz-ai/document/service.js";
import { createTripzPdf, createTripzPreview } from "../src/modules/tripz-ai/document/renderer.js";

describe("Tripz deterministic document renderer", () => {
  it("uses the public Tripz Turismo identity by default", () => {
    expect(createTripzBrandConfig()).toMatchObject({
      agencyName: "Tripz Turismo",
      primaryColor: "#041f3b",
      secondaryColor: "#1a6eb5",
      backgroundColor: "#f6f9fd",
      textColor: "#041f3b",
      mutedColor: "#54677a"
    });
  });

  it("escapes untrusted proposal text and blocks network content", () => {
    const preview = createTripzPreview({
      proposal: {
        revision: 3,
        destination: `<img src=x onerror="alert(1)">`,
        hotel: { name: "Hotel <script>bad()</script>", description: "Praia & descanso" }
      }
    });

    expect(preview.html).not.toContain("<script>bad()" );
    expect(preview.html).not.toContain("<img src=x");
    expect(preview.html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(preview.html).toContain("default-src 'none'");
    expect(preview.model.proposalRevision).toBe(3);
  });

  it("uses conditional pages for itinerary and pricing without empty flight sections", () => {
    const preview = createTripzPreview({
      proposal: {
        destination: "Aruba",
        itinerary: [{ dayNumber: 1, title: "Chegada", evening: "Descanso" }],
        pricing: { pricePerPerson: 8328.29, boardingTax: 662, currency: "BRL" }
      },
      brand: { agentName: "Lucas", phone: "+55 11 4000-2026" }
    });

    expect(preview.model.pages.map((page) => page.kind)).toEqual(["cover", "intro", "itinerary", "pricing", "contact"]);
    expect(preview.html).toContain("R$ 8.328,29");
    expect(preview.html).toContain("Chegada");
  });

  it("produces a valid PDF from the exact preview model and a stable revision hash", async () => {
    const first = createTripzPreview({ proposal: { revision: 7, destination: "Patagônia", flights: [{ origin: "GRU", destination: "AUA" }], notes: ["Valores sujeitos a confirmação. ✈"] } });
    const second = createTripzPreview({ proposal: { revision: 7, destination: "Patagônia", flights: [{ origin: "GRU", destination: "AUA" }], notes: ["Valores sujeitos a confirmação. ✈"] } });
    const rendered = await createTripzPdf(first);

    expect(first.contentHash).toBe(second.contentHash);
    expect(rendered.contentHash).toBe(first.contentHash);
    expect(Buffer.from(rendered.data).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(rendered.data.byteLength).toBeGreaterThan(1_000);
  });

  it("normalizes selected media into a bounded preview payload", async () => {
    const conversationId = randomUUID();
    const scope: TripzAccessScope = { tenantId: randomUUID(), userId: randomUUID(), canManage: false };
    const source = await sharp({
      create: { width: 1_400, height: 1_000, channels: 3, background: "#327b70" }
    }).png().toBuffer();
    const ids: string[] = Array.from({ length: 6 }, () => randomUUID());
    const now = new Date().toISOString();
    const repository = {
      async getAttachmentContent(_scope: TripzAccessScope, _conversationId: string, attachmentId: string) {
        if (!ids.includes(attachmentId)) return null;
        return {
          attachment: {
            id: attachmentId,
            conversationId,
            messageId: null,
            fileName: `${attachmentId}.png`,
            mimeType: "image/png" as const,
            extension: "png",
            sizeBytes: source.length,
            contentHash: "a".repeat(64),
            processingStatus: "processed" as const,
            metadata: {},
            createdAt: now,
            updatedAt: now
          },
          data: source
        };
      }
    } as Pick<TripzAiRepository, "getAttachmentContent"> as TripzAiRepository;
    const proposal: TripzProposal = {
      id: randomUUID(),
      conversationId,
      schemaVersion: 1,
      revision: 4,
      state: {
        schemaVersion: 1,
        destination: "Aruba",
        flights: [],
        media: ids.map((attachmentId, sortOrder) => ({
          attachmentId,
          category: sortOrder === 0 ? "cover" : "hotel_room",
          sortOrder,
          selectedForPdf: true
        })),
        includedItems: [],
      itinerary: [{ dayNumber: 1, title: "Chegada" }],
      notes: [],
      generationRequirements: [],
      issueAcknowledgements: [],
      missingInformation: [],
        inconsistencies: [],
        status: "ready_for_pdf"
      },
      createdAt: now,
      updatedAt: now
    };
    const service = new TripzDocumentService(repository);
    const preview = await service.renderPreview(scope, proposal);
    expect(preview.html.match(/data:image\/jpeg;base64/g)).toHaveLength(6);
    expect(Buffer.byteLength(preview.html, "utf8")).toBeLessThan(5 * 1024 * 1024);

    await expect(service.renderPreview(scope, {
      ...proposal,
      state: {
        ...proposal.state,
        media: Array.from({ length: 13 }, (_, sortOrder) => ({
          attachmentId: randomUUID(),
          category: "other",
          sortOrder,
          selectedForPdf: true
        }))
      }
    })).rejects.toMatchObject({ statusCode: 413, code: "TRIPZ_RENDER_MEDIA_LIMIT" });
  });

  it("paginates long deterministic content without dropping the final itinerary or included item", async () => {
    const preview = createTripzPreview({
      proposal: {
        revision: 9,
        destination: "Aruba",
        flights: Array.from({ length: 10 }, (_, index) => ({
          origin: `Origem ${index + 1}`,
          destination: `Destino ${index + 1}`,
          flightNumber: `TZ${1000 + index}`,
          baggage: "Bagagem despachada e bagagem de mão conforme material confirmado"
        })),
        itinerary: [{
          dayNumber: 1,
          title: "Dia completo",
          morning: "Atividade da manhã confirmada",
          notes: Array.from({ length: 20 }, (_, index) => index === 19
            ? "Última nota obrigatória do roteiro"
            : `Nota de roteiro ${index + 1}`)
        }],
        includedItems: Array.from({ length: 25 }, (_, index) => index === 24
          ? "Último item obrigatório incluído"
          : `Item incluído ${index + 1}`),
        pricing: { totalPrice: 12_345, currency: "BRL", notes: "Condição comercial confirmada. ".repeat(80) },
        notes: Array.from({ length: 20 }, (_, index) => index === 19
          ? "Última observação obrigatória da proposta"
          : `Observação ${index + 1}`)
      }
    });
    const serializedModel = JSON.stringify(preview.model.pages);
    expect(serializedModel).toContain("Última nota obrigatória do roteiro");
    expect(serializedModel).toContain("Último item obrigatório incluído");
    expect(serializedModel).toContain("Última observação obrigatória da proposta");
    expect(preview.html).toContain("Último item obrigatório incluído");
    expect(preview.model.pages.some((page) => page.title.includes("continuação"))).toBe(true);

    const rendered = await createTripzPdf(preview);
    const pdf = await PDFDocument.load(rendered.data);
    expect(pdf.getPageCount()).toBe(preview.model.pages.length);
  });
});

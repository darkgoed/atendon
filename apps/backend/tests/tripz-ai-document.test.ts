import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  NEUTRAL_PROPOSAL_BRAND,
  PROPOSAL_RENDERER_VERSION,
  TRIPZ_PROPOSAL_BRAND,
  proposalSpecSchema,
  type ProposalSpec
} from "@atendon/proposal-renderer";
import type { TripzAccessScope, TripzProposal, TripzProposalState } from "../src/modules/tripz-ai/domain.js";
import type { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import {
  clearBrandSettingsCache,
  getBrandSettings,
  upsertTripzBrandSettings
} from "../src/modules/tripz-ai/document/brand-settings.js";
import { APP_PANEL_URL, TRIPZ_PDF_DISABLE_CHROMIUM } from "../src/modules/tripz-ai/document/env.js";
import { stateToSpec } from "../src/modules/tripz-ai/document/editorial.js";
import type { TripzBrandDatabase } from "../src/modules/tripz-ai/document/brand-settings.js";
import { TripzDocumentService } from "../src/modules/tripz-ai/document/service.js";

function scope(tenantId: string): TripzAccessScope {
  return { tenantId, userId: randomUUID(), canManage: false };
}

/** Fake do pool: tenants + brand settings (queries do brand-settings). */
function databaseMock(tenantName: string | null, brandConfig: unknown): TripzBrandDatabase {
  return {
    query: (async (sql: string, params?: unknown[]) => {
      const tenantId = params?.[0];
      if (typeof sql === "string" && sql.includes("FROM tenants")) return { rows: tenantName === null ? [] : [{ name: tenantName }] };
      if (typeof sql === "string" && sql.includes("tripz_ai_brand_settings")) {
        return { rows: brandConfig ? [{ config: brandConfig }] : [] };
      }
      void tenantId;
      return { rows: [] };
    }) as unknown as TripzBrandDatabase["query"]
  };
}

function proposalFromState(state: Partial<TripzProposalState>): TripzProposal {
  const now = "2026-09-26T00:00:00Z";
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    schemaVersion: state.schemaVersion ?? 1,
    revision: 3,
    state: {
      schemaVersion: state.schemaVersion ?? 1,
      flights: [],
      media: [],
      includedItems: [],
      itinerary: [],
      notes: [],
      generationRequirements: [],
      issueAcknowledgements: [],
      missingInformation: [],
      inconsistencies: [],
      status: "ready_for_review",
      ...state
    } as TripzProposalState,
    createdAt: now,
    updatedAt: now
  };
}

const editorialState: Partial<TripzProposalState> = {
  schemaVersion: 2,
  title: "O Porto",
  destination: "Porto",
  startDate: "2027-04-22",
  endDate: "2027-04-24",
  client: { name: "Jhonny & Shayene" },
  passengers: { adults: 2 },
  flights: [{
    id: "f1", airline: "Royal Air Maroc", flightNumber: "AT 214", date: "2027-04-22",
    departureTime: "18:20", arrivalTime: "08:15", origin: "GRU", destination: "OPO",
    duration: "11h55", cabin: "Econômica", arrivesNextDay: true
  }],
  hotel: { name: "HF Fénix Porto", roomType: "Quarto Comfort", mealPlan: "Café da manhã", checkIn: "2027-04-22", checkOut: "2027-04-24" },
  includedItems: [{ id: "i1", type: "hotel", title: "2 noites no HF Fénix Porto", included: true }],
  pricing: { totalPrice: 6656.56, currency: "BRL" },
  itinerary: [{ dayNumber: 1, date: "2027-04-22", title: "Chegada ao Porto", morning: undefined, afternoon: undefined, evening: undefined }],
  editorial: {
    tripTitle: "O Porto",
    narrative: {
      concept: { eyebrow: "UMA ESCAPADA ÀS MARGENS DO DOURO", headline: "Dois dias no Porto", body: ["Parágrafo um."], quote: "O Porto em dois dias." },
      destinationCopy: {}
    },
    destinations: [{ id: "porto", name: "Porto", nights: 2 }],
    hotels: [{ id: "hf-fenix", destinationId: "porto", name: "HF Fénix Porto", pending: false, roomCategory: "Quarto Comfort", mealPlan: "Café da manhã", nights: 2 }],
    commercial: { currency: "BRL", total: 6656.56, priceNotes: [], paymentEntries: [{ label: "Sinal", value: "30% no ato" }], differentials: [] }
  }
};

function mediaRow(attachmentId: string, category: string, sortOrder = 0, selected = true) {
  return { attachmentId, category, label: undefined, confidence: 0.9, selectedForPdf: selected, sortOrder };
}

function fakeRepository(attachments: Map<string, { mimeType: string; data: Buffer }>): TripzAiRepository {
  return {
    database: databaseMock("Tripz Turismo", null),
    getAttachmentContent: async (_scope: TripzAccessScope, _conversationId: string, attachmentId: string) => {
      const hit = attachments.get(attachmentId);
      if (!hit) return null;
      return {
        attachment: {
          id: attachmentId,
          conversationId: randomUUID(),
          messageId: null,
          fileName: `${attachmentId}.bin`,
          mimeType: hit.mimeType,
          extension: "bin",
          sizeBytes: hit.data.length,
          contentHash: "a".repeat(64),
          processingStatus: "processed",
          metadata: {},
          createdAt: "2026-09-26T00:00:00Z",
          updatedAt: "2026-09-26T00:00:00Z"
        },
        data: hit.data
      };
    }
  } as unknown as TripzAiRepository;
}

describe("Tripz editorial document pipeline", () => {
  it("stateToSpec normaliza o estado operacional em ProposalSpec válido", () => {
    const result = stateToSpec(proposalFromState(editorialState).state, { tenantId: "t-tripz" });
    expect(result.issues).toEqual([]);
    const spec: ProposalSpec = proposalSpecSchema.parse(result.spec!);
    expect(spec.tripTitle).toBe("O Porto");
    expect(spec.travellers).toHaveLength(2);
    expect(spec.destinations[0]).toMatchObject({ id: "porto", nights: 2 });
    expect(spec.hotels[0]).toMatchObject({ name: "HF Fénix Porto" });
    expect(spec.flights).toHaveLength(1);
    expect(spec.commercial.total).toBe(6656.56);
    expect(spec.narrative.concept?.headline).toBe("Dois dias no Porto");
  });

  it("brand: tenant Tripz recebe a identidade aprovada; outro tenant recebe neutro", async () => {
    clearBrandSettingsCache();
    const tripz = await getBrandSettings(databaseMock("Tripz Turismo", null), "tenant-tripz");
    expect(tripz.tokens.primary).toBe(TRIPZ_PROPOSAL_BRAND.tokens.primary);
    expect(tripz.tokens.primary).toBe("#123047");

    const other = await getBrandSettings(databaseMock("Outra Turismo", null), "tenant-other");
    expect(other.tokens.primary).toBe(NEUTRAL_PROPOSAL_BRAND.tokens.primary);
    expect(other.tokens.primary).not.toBe("#123047");
  });

  it("brand salvo no banco vence o fallback e o leak guard bloqueia identidade Tripz fora do grupo", async () => {
    clearBrandSettingsCache();
    const custom = { ...NEUTRAL_PROPOSAL_BRAND, tokens: { ...NEUTRAL_PROPOSAL_BRAND.tokens, primary: "#333333" } };
    const saved = await getBrandSettings(databaseMock("Outra Turismo", custom), "tenant-other");
    expect(saved.tokens.primary).toBe("#333333");

    await expect(upsertTripzBrandSettings(databaseMock("Outra Turismo", null), "tenant-other", TRIPZ_PROPOSAL_BRAND))
      .rejects.toMatchObject({ code: "TRIPZ_IDENTITY_LEAK" });
  });

  it("renderPreview monta HTML A4 com fontes externas e mídia via URL", async () => {
    clearBrandSettingsCache();
    const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#327b70" } }).jpeg().toBuffer();
    const repository = fakeRepository(new Map([["att-1", { mimeType: "image/jpeg", data: image }]]));
    const service = new TripzDocumentService(repository);
    const proposal = proposalFromState({ ...editorialState, media: [mediaRow("att-1", "cover")] });
    const result = await service.renderPreview(scope("tenant-tripz"), proposal);
    expect(result.rendererVersion).toBe(PROPOSAL_RENDERER_VERSION);
    expect(result.html).toContain("tp-page");
    expect(result.html).toContain("proposal-fonts");
    expect(result.html).toContain("/attachments/att-1/content");
    expect(Buffer.byteLength(result.html, "utf8")).toBeLessThan(5 * 1024 * 1024);
  });

  it("APP_PANEL_URL e flag de chromium resolvem corretamente", () => {
    expect(APP_PANEL_URL({ APP_PANEL_URL: "https://painel.exemplo.br/" })).toBe("https://painel.exemplo.br");
    expect(APP_PANEL_URL({})).toBeUndefined();
    expect(TRIPZ_PDF_DISABLE_CHROMIUM({ TRIPZ_PDF_DISABLE_CHROMIUM: "1" })).toBe(true);
    expect(TRIPZ_PDF_DISABLE_CHROMIUM({})).toBe(false);
  });

  it("renderPdf sem chromium responde 503 TRIPZ_PDF_ENGINE_UNAVAILABLE", async () => {
    clearBrandSettingsCache();
    vi.stubEnv("TRIPZ_PDF_DISABLE_CHROMIUM", "1");
    try {
      const repository = fakeRepository(new Map());
      const service = new TripzDocumentService(repository);
      const proposal = proposalFromState(editorialState);
      await expect(service.renderPdf(scope("tenant-tripz"), proposal)).rejects.toMatchObject({
        code: "TRIPZ_PDF_ENGINE_UNAVAILABLE"
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("limite de mídia selecionada continua 413 e mídia não renderizável não quebra", async () => {
    clearBrandSettingsCache();
    const repository = fakeRepository(new Map([
      ["att-pdf", { mimeType: "application/pdf", data: Buffer.from("%PDF-1.4") }]
    ]));
    const service = new TripzDocumentService(repository);
    const proposal = proposalFromState({ ...editorialState, media: [mediaRow("att-pdf", "cover")] });
    const result = await service.renderPreview(scope("tenant-tripz"), proposal);
    expect(result.html).toContain("tp-page");

    const manyMedia = Array.from({ length: 13 }, (_, index) => mediaRow(`att-${index}`, "other", index));
    await expect(service.renderPreview(scope("tenant-tripz"), proposalFromState({ ...editorialState, media: manyMedia })))
      .rejects.toMatchObject({ statusCode: 413, code: "TRIPZ_RENDER_MEDIA_LIMIT" });
  });
});

describe("imagens da proposta: atribuição por slot", () => {
  const labelled = (attachmentId: string, category: string, label?: string, sortOrder = 0) => ({
    ...mediaRow(attachmentId, category, sortOrder), label
  });
  const roles = (state: Partial<TripzProposalState>) => {
    const result = stateToSpec(proposalFromState(state).state, { tenantId: "t" });
    expect(result.issues).toEqual([]);
    return result.spec!.imageAssignments.map((assignment) => `${assignment.role}:${assignment.targetId ?? ""}=${assignment.mediaId}`);
  };

  it("foto de quarto/piscina vai para o hotel em vez de quebrar o documento", () => {
    expect(roles({ ...editorialState, media: [labelled("room", "hotel_room"), labelled("pool", "hotel_pool", undefined, 1)] }))
      .toEqual(["hotel:hf-fenix=room", "gallery:hf-fenix=pool"]);
  });

  it("com vários hotéis, a legenda com o nome escolhe o hotel; sem match, não inventa alvo", () => {
    const state: Partial<TripzProposalState> = {
      ...editorialState,
      editorial: {
        ...editorialState.editorial,
        hotels: [
          { id: "kent", name: "Kent Hotel Roma", pending: false },
          { id: "villa-pandora", name: "Villa Pandora Hotel", pending: false }
        ]
      },
      media: [labelled("vp", "hotel_pool", "Piscina do Villa Pandora"), labelled("x", "hotel_room", "Quarto")]
    };
    expect(roles(state)).toEqual(["hotel:villa-pandora=vp", "gallery:=x"]);
  });

  it("atribuição explícita vence a inferida no mesmo slot e as demais fotos continuam", () => {
    const state: Partial<TripzProposalState> = {
      ...editorialState,
      media: [labelled("old-cover", "cover"), labelled("room", "hotel_room", undefined, 1), labelled("new", "destination", undefined, 2)],
      editorial: { ...editorialState.editorial, imageAssignments: [{ mediaId: "new", role: "cover" }] }
    };
    expect(roles(state)).toEqual(["cover:=new", "hotel:hf-fenix=room"]);
  });

  it("targetId pelo nome do hotel/destino é resolvido para o id; alvo inexistente é descartado", () => {
    const state: Partial<TripzProposalState> = {
      ...editorialState,
      media: [],
      editorial: {
        ...editorialState.editorial,
        imageAssignments: [
          { mediaId: "a", role: "hotel", targetId: "hf-fenix-porto" },
          { mediaId: "b", role: "destination", targetId: "porto" },
          { mediaId: "c", role: "hotel", targetId: "hotel-inexistente" }
        ]
      }
    };
    expect(roles(state)).toEqual(["hotel:hf-fenix=a", "destination:porto=b"]);
  });

  it("crédito da mídia vira source estruturado (não string)", () => {
    const state: Partial<TripzProposalState> = {
      ...editorialState,
      media: [{ ...mediaRow("cov", "cover"), metadata: { credit: "Foto: Visit Porto" } }]
    };
    const result = stateToSpec(proposalFromState(state).state, { tenantId: "t" });
    expect(result.issues).toEqual([]);
    expect(result.spec!.imageAssignments[0].source).toEqual({ credit: "Foto: Visit Porto" });
  });

  it("documento carrega a foto atribuída mesmo fora da seleção (ex.: enviada por URL)", async () => {
    clearBrandSettingsCache();
    const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#327b70" } }).jpeg().toBuffer();
    const repository = fakeRepository(new Map([["from-url", { mimeType: "image/jpeg", data: image }]]));
    const service = new TripzDocumentService(repository);
    const proposal = proposalFromState({
      ...editorialState,
      media: [],
      editorial: { ...editorialState.editorial, imageAssignments: [{ mediaId: "from-url", role: "cover" }] }
    });
    const result = await service.renderPreview(scope("tenant-tripz"), proposal);
    expect(result.html).toContain("/attachments/from-url/content");
    // Nome do cliente com dois adultos: sem "Adulto 2" na capa; IATA continua em caixa alta.
    expect(result.html).toContain('<p class="tp-cover__names">Jhonny &amp; Shayene</p>');
    expect(result.html).not.toContain("Adulto 2");
    expect(result.html).toContain("GRU → OPO");
  });
});

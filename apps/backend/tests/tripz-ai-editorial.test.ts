import { describe, expect, it } from "vitest";
import {
  applyAllowlistedTripzPatch,
  applyEditorialBlock
} from "../src/modules/tripz-ai/ai/orchestrator.js";
import { validateTripzProposal } from "../src/modules/tripz-ai/ai/proposal-validator.js";
import { tripzProposalPatchSchema, tripzExplicitCorrectionPathSchema } from "../src/modules/tripz-ai/ai/schemas.js";
import { createEmptyTripzProposalState, type TripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { TRIPZ_AI_SYSTEM_PROMPT } from "../src/modules/tripz-ai/ai/prompt.js";

function v1State(): TripzProposalState {
  return {
    ...createEmptyTripzProposalState(),
    destination: "Porto",
    startDate: "2027-04-22",
    endDate: "2027-04-24",
    client: { name: "Jhonny & Shayene" },
    flights: [{ id: "f1", airline: "Royal Air Maroc", flightNumber: "AT 214" }],
    hotel: { name: "HF Fénix Porto" }
  };
}

describe("bloco editorial no patch", () => {
  it("aceita patch com editorial e valida o schema", () => {
    const parsed = tripzProposalPatchSchema.parse({
      editorial: {
        tripTitle: "O Porto",
        narrative: { concept: { eyebrow: "UMA ESCAPADA", headline: "Às margens do Douro" } },
        commercial: { total: 6656.56, currency: "BRL", paymentEntries: [{ label: "Sinal", value: "30%" }] }
      }
    });
    expect(parsed.editorial?.tripTitle).toBe("O Porto");
  });

  it("rejeita editorial com campo desconhecido", () => {
    expect(() => tripzProposalPatchSchema.parse({ editorial: { foo: "bar" } })).toThrow();
  });

  it("faz upsert por id em destinations e preserva não enviados", () => {
    const current = applyEditorialBlock(createEmptyTripzProposalState(), {
      destinations: [{ id: "roma", name: "Roma", nights: 4 }]
    });
    expect(current.schemaVersion).toBe(2);
    const next = applyEditorialBlock(current, { destinations: [{ id: "roma", summary: "A cidade eterna." }, { id: "sorrento", name: "Sorrento" }] });
    expect(next.editorial?.destinations).toHaveLength(2);
    expect(next.editorial?.destinations?.[0]).toMatchObject({ name: "Roma", nights: 4, summary: "A cidade eterna." });
  });

  it("imageAssignments fazem upsert por slot: troca só a foto citada e preserva as demais", () => {
    const first = applyEditorialBlock(createEmptyTripzProposalState(), {
      imageAssignments: [
        { mediaId: "a1", role: "cover", placement: { x: 50, y: 30, zoom: 120 } },
        { mediaId: "h1", role: "hotel", targetId: "villa-pandora" },
        { mediaId: "d1", role: "destination", targetId: "roma" }
      ]
    });
    const second = applyEditorialBlock(first, {
      imageAssignments: [{ mediaId: "a2", role: "cover" }, { mediaId: "h2", role: "hotel", targetId: "villa-pandora" }]
    });
    expect(second.editorial?.imageAssignments).toEqual([
      { mediaId: "a2", role: "cover" },
      { mediaId: "h2", role: "hotel", targetId: "villa-pandora" },
      { mediaId: "d1", role: "destination", targetId: "roma" }
    ]);
    // Mesmo mediaId: enquadramento novo substitui; sem mediaId remove o slot; galeria acumula.
    const third = applyEditorialBlock(second, {
      imageAssignments: [
        { mediaId: "a2", role: "cover", placement: { x: 50, y: 70, zoom: 100 } },
        { role: "destination", targetId: "roma" },
        { mediaId: "g1", role: "gallery", targetId: "villa-pandora" },
        { mediaId: "g2", role: "gallery", targetId: "villa-pandora" }
      ]
    });
    expect(third.editorial?.imageAssignments).toEqual([
      { mediaId: "a2", role: "cover", placement: { x: 50, y: 70, zoom: 100 } },
      { mediaId: "h2", role: "hotel", targetId: "villa-pandora" },
      { mediaId: "g1", role: "gallery", targetId: "villa-pandora" },
      { mediaId: "g2", role: "gallery", targetId: "villa-pandora" }
    ]);
    expect(applyEditorialBlock(third, { imageAssignments: [] }).editorial?.imageAssignments).toEqual([]);
  });

  it("inclusions fazem upsert por section", () => {
    const first = applyEditorialBlock(createEmptyTripzProposalState(), {
      inclusions: [{ section: "Aéreo & bagagens", items: [{ title: "Voos Iberia" }] }]
    });
    const next = applyEditorialBlock(first, {
      inclusions: [{ section: "Aéreo & bagagens", items: [{ title: "Voos Iberia" }, { title: "1 mala 23kg" }] }]
    });
    expect(next.editorial?.inclusions?.[0].items).toHaveLength(2);
  });

  it("merge raso do commercial preserva paymentEntries não enviadas e apaga com null", () => {
    const first = applyEditorialBlock(createEmptyTripzProposalState(), {
      commercial: { total: 1000, paymentEntries: [{ label: "Sinal", value: "30%" }] }
    });
    const next = applyEditorialBlock(first, { commercial: { boardingTax: null } });
    expect(next.editorial?.commercial?.total).toBe(1000);
    expect(next.editorial?.commercial?.paymentEntries).toHaveLength(1);
    expect(next.editorial?.commercial?.boardingTax).toBeUndefined();
  });

  it("v1 sem editorial permanece schemaVersion 1", () => {
    const next = applyAllowlistedTripzPatch(v1State(), { title: "Escapada ao Porto" });
    expect(next.schemaVersion).toBe(1);
    expect(next.editorial).toBeUndefined();
  });
});

describe("validação editorial", () => {
  it("estado v1 sem editorial valida como antes", () => {
    const result = validateTripzProposal(v1State());
    expect(result.canGenerate).toBe(true);
  });

  it("placeholder de template em copy é crítico", () => {
    const current = applyEditorialBlock(v1State(), {
      narrative: { concept: { headline: "[TEMPLATE] preencher" } }
    });
    const result = validateTripzProposal(current);
    expect(result.issues.some((issue) => issue.code === "EDITORIAL_TEMPLATE_PLACEHOLDER" && issue.severity === "critical")).toBe(true);
    expect(result.canGenerate).toBe(false);
  });

  it("investimento sem condições de pagamento exige campo", () => {
    const current = applyEditorialBlock(v1State(), { commercial: { total: 6656.56 } });
    const result = validateTripzProposal(current);
    expect(result.missingInformation.some((field) => field.code === "EDITORIAL_PAYMENT_REQUIRED" && field.required)).toBe(true);
    expect(result.canGenerate).toBe(false);
  });

  it("noites por destino incoerentes com o período são críticas", () => {
    const current = applyEditorialBlock(v1State(), {
      destinations: [{ id: "porto", name: "Porto", nights: 5 }]
    });
    const result = validateTripzProposal(current);
    expect(result.issues.some((issue) => issue.code === "EDITORIAL_NIGHTS_CONFLICT")).toBe(true);
  });

  it("conflito entre investment editorial e preço do estado é crítico", () => {
    const current = applyEditorialBlock(v1State(), { commercial: { total: 9999.99, paymentEntries: [{ label: "Sinal", value: "30%" }] } });
    const withPricing = { ...current, pricing: { totalPrice: 6656.56, currency: "BRL" } };
    const result = validateTripzProposal(withPricing as TripzProposalState);
    expect(result.issues.some((issue) => issue.code === "EDITORIAL_PRICING_CONFLICT")).toBe(true);
  });

  it("destinos sem nome dos viajantes exigem client.name", () => {
    const base = v1State();
    const current = applyEditorialBlock({ ...base, client: undefined }, { destinations: [{ id: "porto", name: "Porto" }] });
    const result = validateTripzProposal(current);
    expect(result.missingInformation.some((field) => field.code === "TRAVELLER_NAME_REQUIRED" && field.required)).toBe(true);
  });
});

describe("prompt editorial", () => {
  it("contém as regras de voz e proibição de inventar comercial", () => {
    expect(TRIPZ_AI_SYSTEM_PROMPT).toContain("BLOCO EDITORIAL DA PROPOSTA");
    expect(TRIPZ_AI_SYSTEM_PROMPT).toContain("renderer fixo");
    expect(TRIPZ_AI_SYSTEM_PROMPT).toContain("NUNCA invente dado comercial");
    expect(TRIPZ_AI_SYSTEM_PROMPT).toContain("inesquecível");
  });

  it("tem paths de correção editorial", () => {
    expect(tripzExplicitCorrectionPathSchema.safeParse("editorial.commercial.total").success).toBe(true);
    expect(tripzExplicitCorrectionPathSchema.safeParse("editorial.imageAssignments").success).toBe(true);
  });
});

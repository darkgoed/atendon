import { describe, expect, it } from "vitest";
import { createEmptyTripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { validateTripzProposal } from "../src/modules/tripz-ai/ai/proposal-validator.js";
import { tripzProposalPatchSchema as tripzAiProposalPatchSchema } from "../src/modules/tripz-ai/ai/schemas.js";

describe("validateTripzProposal", () => {
  it("detects date, flight sequence and pricing conflicts deterministically", () => {
    const result = validateTripzProposal({
      ...createEmptyTripzProposalState(),
      destination: "Aruba",
      startDate: "2026-09-20",
      endDate: "2026-09-10",
      passengers: { adults: 2 },
      flights: [
        { date: "2026-09-20", departureTime: "22:00", arrivalTime: "04:00", arrivesNextDay: false, origin: "GRU", destination: "AUA" },
        { date: "2026-09-19", origin: "MIA", destination: "GRU" }
      ],
      hotel: { name: "Hotel", checkIn: "2026-09-20", checkOut: "2026-09-18" },
      pricing: { pricePerPerson: 1_000, boardingTax: 100, totalPrice: 5_000, currency: "BRL" }
    });
    expect(result.canGenerate).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "TRAVEL_DATE_ORDER_CONFLICT",
      "HOTEL_DATE_ORDER_CONFLICT",
      "FLIGHT_OVERNIGHT_UNCONFIRMED",
      "FLIGHT_DATE_SEQUENCE_CONFLICT",
      "FLIGHT_ROUTE_SEQUENCE_CONFLICT",
      "PRICING_TOTAL_CONFLICT"
    ]));
  });

  it("does not require a price and does not let low-confidence media block readiness", () => {
    const result = validateTripzProposal({
      ...createEmptyTripzProposalState(),
      destination: "Aruba",
      itinerary: [{ dayNumber: 1, title: "Chegada e descanso" }],
      media: [{
        attachmentId: "00000000-0000-4000-8000-000000000001",
        category: "hotel_lobby",
        confidence: 0.4,
        sortOrder: 0,
        selectedForPdf: true
      }]
    });
    expect(result.canGenerate).toBe(true);
    expect(result.proposal.status).toBe("ready_for_review");
    expect(result.missingInformation.some((missing) => missing.path.startsWith("pricing"))).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "MEDIA_CLASSIFICATION_LOW_CONFIDENCE",
      severity: "warning"
    }));
  });

  it("flags an airport transfer or open-jaw route for review without blocking a valid proposal", () => {
    const result = validateTripzProposal({
      ...createEmptyTripzProposalState(),
      destination: "Nova York",
      flights: [
        { date: "2026-10-01", origin: "GRU", destination: "JFK" },
        { date: "2026-10-05", origin: "LGA", destination: "MIA" }
      ]
    });
    expect(result.canGenerate).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "FLIGHT_ROUTE_SEQUENCE_CONFLICT",
      severity: "warning",
      requiresConfirmation: false
    }));
  });

  it("supports proposal-specific required fields without changing global defaults", () => {
    const proposal = {
      ...createEmptyTripzProposalState(),
      destination: "Aruba",
      itinerary: [{ dayNumber: 1, title: "Chegada" }]
    };
    expect(validateTripzProposal(proposal).canGenerate).toBe(true);
    const required = validateTripzProposal(proposal, {
      requiredFields: [{ path: "client.name", label: "nome do cliente", reason: "Solicitado pelo agente" }]
    });
    expect(required.canGenerate).toBe(false);
    expect(required.missingInformation).toContainEqual(expect.objectContaining({
      path: "client.name",
      required: true,
      label: "nome do cliente"
    }));
  });

  it("does not treat empty model objects as primary proposal content", () => {
    const result = validateTripzProposal({
      ...createEmptyTripzProposalState(),
      destination: "Aruba",
      flights: [{}],
      hotel: {}
    });
    expect(result.canGenerate).toBe(false);
    expect(result.missingInformation).toContainEqual(expect.objectContaining({
      code: "PRIMARY_CONTENT_REQUIRED",
      required: true
    }));
  });

  it("ignores auxiliary-only flight/hotel values for readiness", () => {
    for (const proposal of [
      { flights: [{ arrivesNextDay: false }], hotel: undefined },
      { flights: [{ confidence: 0 }], hotel: undefined },
      { flights: [], hotel: { nightlyRate: 0 } },
      { flights: [], hotel: undefined, itinerary: [{ dayNumber: 1 }] }
    ]) {
      const result = validateTripzProposal({
        ...createEmptyTripzProposalState(),
        destination: "Aruba",
        ...proposal
      });
      expect(result.canGenerate).toBe(false);
      expect(result.missingInformation.some((item) => item.code === "PRIMARY_CONTENT_REQUIRED")).toBe(true);
    }
  });

  it("keeps AI proposal patches within the canonical persisted-state limits", () => {
    expect(tripzAiProposalPatchSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(tripzAiProposalPatchSchema.safeParse({ destination: "x".repeat(301) }).success).toBe(false);
    expect(tripzAiProposalPatchSchema.safeParse({ flights: [{
      id: "not-a-uuid",
      flightNumber: "x".repeat(41),
      departureTime: "25:90"
    }] }).success).toBe(false);
    expect(tripzAiProposalPatchSchema.safeParse({ pricing: { currency: "reais" } }).success).toBe(false);
    expect(tripzAiProposalPatchSchema.safeParse({ includedItems: [{ title: "Traslado", type: "fora do slug", included: true }] }).success).toBe(false);
    expect(tripzAiProposalPatchSchema.safeParse({
      title: "Aruba",
      flights: [{ flightNumber: "AD1234", departureTime: "22:10", origin: "GRU", destination: "AUA" }],
      pricing: { currency: "BRL" }
    }).success).toBe(true);
  });

  it("coerces provider-supplied string includedItems into the object shape", () => {
    const result = tripzAiProposalPatchSchema.safeParse({
      includedItems: ["Hospedagem em Toronto de 05 a 06/09 — Holiday Inn Express"]
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includedItems).toEqual([
        { title: "Hospedagem em Toronto de 05 a 06/09 — Holiday Inn Express", included: true }
      ]);
    }
  });
});

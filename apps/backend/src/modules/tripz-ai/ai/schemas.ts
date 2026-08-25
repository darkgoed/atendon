import { z } from "zod";
import { TRIPZ_MEDIA_CATEGORIES } from "../domain.js";

const shortText = z.string().trim().min(1).max(500);
const nullableShortText = shortText.nullable();
const nullableTitle = z.string().trim().min(1).max(200).nullable();
const nullableDestination = z.string().trim().min(1).max(300).nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable();
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable();
const nonNegativeMoney = z.number().finite().nonnegative().max(1_000_000_000).nullable();

export const tripzFlightPatchSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  airline: nullableShortText.optional(),
  flightNumber: z.string().trim().min(1).max(40).nullable().optional(),
  date: isoDate.optional(),
  departureTime: clockTime.optional(),
  arrivalTime: clockTime.optional(),
  origin: z.string().trim().min(1).max(160).nullable().optional(),
  destination: z.string().trim().min(1).max(160).nullable().optional(),
  duration: z.string().trim().min(1).max(100).nullable().optional(),
  stopover: z.string().trim().min(1).max(300).nullable().optional(),
  aircraft: z.string().trim().min(1).max(100).nullable().optional(),
  cabin: z.string().trim().min(1).max(100).nullable().optional(),
  baggage: z.string().trim().min(1).max(300).nullable().optional(),
  arrivesNextDay: z.boolean().nullable().optional(),
  notes: z.array(shortText).max(20).optional(),
  confidence: z.number().finite().min(0).max(1).nullable().optional()
}).strict();

export const tripzProposalPatchSchema = z.object({
  title: nullableTitle.optional(),
  client: z.union([
    z.object({ name: nullableShortText.optional() }).strict(),
    // Providers sometimes summarize the client as a bare name string instead
    // of the {name} object despite the prompt. Coerce rather than fail the
    // whole turn.
    shortText.transform((name) => ({ name }))
  ]).nullable().optional(),
  destination: nullableDestination.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  passengers: z.union([
    z.object({
      adults: z.number().int().min(0).max(100).nullable().optional(),
      children: z.number().int().min(0).max(100).nullable().optional(),
      infants: z.number().int().min(0).max(100).nullable().optional()
    }).strict(),
    // Providers sometimes summarize passengers as a bare headcount instead
    // of the {adults, children, infants} object despite the prompt. Coerce
    // rather than fail the whole turn.
    z.number().int().min(0).max(100).transform((adults) => ({ adults, children: 0, infants: 0 }))
  ]).nullable().optional(),
  flights: z.array(tripzFlightPatchSchema).max(30).optional(),
  hotel: z.object({
    name: nullableShortText.optional(),
    roomType: nullableShortText.optional(),
    mealPlan: nullableShortText.optional(),
    description: z.string().trim().min(1).max(4_000).nullable().optional(),
    checkIn: isoDate.optional(),
    checkOut: isoDate.optional(),
    nightlyRate: nonNegativeMoney.optional(),
    totalRate: nonNegativeMoney.optional(),
    currency: currency.optional()
  }).strict().nullable().optional(),
  includedItems: z.array(z.union([
    z.object({
      id: z.string().uuid().nullable().optional(),
      type: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().optional(),
      title: shortText,
      description: z.string().trim().min(1).max(2_000).nullable().optional(),
      included: z.boolean()
    }).strict(),
    // Providers sometimes summarize items as plain strings instead of the
    // object shape despite the prompt. Coerce rather than fail the whole turn.
    shortText.transform((title) => ({ title, included: true }))
  ])).max(50).optional(),
  pricing: z.object({
    pricePerPerson: nonNegativeMoney.optional(),
    boardingTax: nonNegativeMoney.optional(),
    totalPrice: nonNegativeMoney.optional(),
    currency: currency.optional(),
    notes: z.string().trim().min(1).max(2_000).nullable().optional()
  }).strict().nullable().optional(),
  itinerary: z.array(z.object({
    dayNumber: z.number().int().min(1).max(365),
    date: isoDate.optional(),
    title: nullableShortText.optional(),
    morning: z.string().trim().min(1).max(2_000).nullable().optional(),
    afternoon: z.string().trim().min(1).max(2_000).nullable().optional(),
    evening: z.string().trim().min(1).max(2_000).nullable().optional(),
    notes: z.array(shortText).max(20).optional()
  }).strict()).max(365).optional(),
  notes: z.array(z.string().trim().min(1).max(2_000)).max(100).optional()
}).strict();

export const tripzExplicitCorrectionPathSchema = z.enum([
  "destination",
  "startDate",
  "endDate",
  "passengers",
  "flights",
  "hotel.name",
  "hotel.roomType",
  "hotel.mealPlan",
  "hotel.checkIn",
  "hotel.checkOut",
  "includedItems",
  "pricing.pricePerPerson",
  "pricing.boardingTax",
  "pricing.totalPrice",
  "pricing.currency",
  "itinerary",
  "notes"
]);

export const tripzAiStructuredOutputSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(4_000),
  summary: z.string().trim().max(8_000),
  proposalPatch: tripzProposalPatchSchema,
  mediaUpdates: z.array(z.object({
    attachmentId: z.string().uuid(),
    category: z.enum(TRIPZ_MEDIA_CATEGORIES),
    label: z.string().trim().min(1).max(300).nullable().optional(),
    confidence: z.number().finite().min(0).max(1),
    selectedForPdf: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional()
  }).strict()).max(50),
  explicitCorrections: z.array(tripzExplicitCorrectionPathSchema).max(30),
  requestedAction: z.enum(["none", "show_summary", "preview", "pdf"]),
  missingInformation: z.array(z.string().trim().min(1).max(200)).max(50),
  issues: z.array(z.object({
    code: z.string().trim().min(1).max(100),
    path: z.string().trim().min(1).max(200).nullable(),
    message: z.string().trim().min(1).max(500),
    severity: z.enum(["info", "warning", "critical"])
  }).strict()).max(50)
}).strict();

const serializedProposalPatchSchema = z.string().max(100_000).transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "proposalPatch não contém JSON válido" });
    return z.NEVER;
  }
}).pipe(tripzProposalPatchSchema);

export const tripzAiProviderOutputSchema = tripzAiStructuredOutputSchema.extend({
  // Keep the provider grammar small while preserving the complete allowlisted
  // patch validation before any state is changed. Object input remains
  // accepted for compatibility with deterministic tests and stored fixtures.
  proposalPatch: z.union([tripzProposalPatchSchema, serializedProposalPatchSchema])
});

export type TripzAiStructuredOutput = z.infer<typeof tripzAiStructuredOutputSchema>;
export type TripzAiProposalPatch = z.infer<typeof tripzProposalPatchSchema>;
export type TripzExplicitCorrectionPath = z.infer<typeof tripzExplicitCorrectionPathSchema>;

const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
  anyOf: [schema, { type: "null" }]
});

const stringSchema = (maxLength: number): Record<string, unknown> => ({ type: "string", minLength: 1, maxLength });

export const tripzAiStructuredOutputJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "assistantMessage",
    "summary",
    "proposalPatch",
    "mediaUpdates",
    "explicitCorrections",
    "requestedAction",
    "missingInformation",
    "issues"
  ],
  properties: {
    assistantMessage: stringSchema(4_000),
    summary: { type: "string", maxLength: 8_000 },
    proposalPatch: {
      type: "string",
      minLength: 2,
      maxLength: 100_000,
      description: "Objeto JSON serializado contendo somente os campos alterados da proposta; use {} quando não houver alteração."
    },
    mediaUpdates: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "category", "label", "confidence", "selectedForPdf", "sortOrder"],
        properties: {
          attachmentId: { type: "string", format: "uuid" },
          category: { type: "string", enum: [...TRIPZ_MEDIA_CATEGORIES] },
          label: nullable(stringSchema(300)),
          confidence: { type: "number", minimum: 0, maximum: 1 },
          selectedForPdf: { type: "boolean" },
          sortOrder: { type: "integer", minimum: 0, maximum: 10_000 }
        }
      }
    },
    explicitCorrections: {
      type: "array",
      maxItems: 30,
      items: { type: "string", enum: tripzExplicitCorrectionPathSchema.options }
    },
    requestedAction: { type: "string", enum: ["none", "show_summary", "preview", "pdf"] },
    missingInformation: { type: "array", maxItems: 50, items: stringSchema(200) },
    issues: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "path", "message", "severity"],
        properties: {
          code: stringSchema(100),
          path: nullable(stringSchema(200)),
          message: stringSchema(500),
          severity: { type: "string", enum: ["info", "warning", "critical"] }
        }
      }
    }
  }
};

export const tripzAiResponseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "tripz_ai_turn",
    strict: true,
    schema: tripzAiStructuredOutputJsonSchema
  }
};

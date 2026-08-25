import { z } from "zod";
import {
  TRIPZ_CONVERSATION_STATUSES,
  TRIPZ_MEDIA_CATEGORIES,
  type TripzProposalPatch,
  type TripzProposalState
} from "./domain.js";

export const tripzUuidSchema = z.string().uuid();
export const tripzConversationParamsSchema = z.object({ id: tripzUuidSchema }).strict();
export const tripzMessageParamsSchema = z.object({
  id: tripzUuidSchema,
  messageId: tripzUuidSchema
}).strict();
export const tripzAttachmentParamsSchema = z.object({
  id: tripzUuidSchema,
  attachmentId: tripzUuidSchema
}).strict();
export const tripzDocumentParamsSchema = z.object({
  id: tripzUuidSchema,
  documentId: tripzUuidSchema
}).strict();

const limitedMetadataSchema = z.record(z.string().max(100), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768, "Metadados excedem 32 KiB");
const shortText = z.string().trim().min(1).max(500);
const optionalShortText = z.string().trim().min(1).max(500).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const money = z.number().finite().nonnegative().max(1_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);

export const tripzFlightSegmentSchema = z.object({
  id: tripzUuidSchema.optional(),
  airline: optionalShortText,
  flightNumber: z.string().trim().min(1).max(40).optional(),
  date: isoDate.optional(),
  departureTime: clockTime.optional(),
  arrivalTime: clockTime.optional(),
  origin: z.string().trim().min(1).max(160).optional(),
  destination: z.string().trim().min(1).max(160).optional(),
  duration: z.string().trim().min(1).max(100).optional(),
  stopover: z.string().trim().min(1).max(300).optional(),
  aircraft: z.string().trim().min(1).max(100).optional(),
  cabin: z.string().trim().min(1).max(100).optional(),
  baggage: z.string().trim().min(1).max(300).optional(),
  arrivesNextDay: z.boolean().optional(),
  notes: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  confidence: z.number().finite().min(0).max(1).optional()
}).strict();

export const tripzHotelSchema = z.object({
  name: optionalShortText,
  roomType: optionalShortText,
  mealPlan: optionalShortText,
  description: z.string().trim().min(1).max(5_000).optional(),
  checkIn: isoDate.optional(),
  checkOut: isoDate.optional(),
  nightlyRate: money.optional(),
  totalRate: money.optional(),
  currency: currency.optional()
}).strict();

export const tripzProposalMediaSchema = z.object({
  id: tripzUuidSchema.optional(),
  attachmentId: tripzUuidSchema,
  category: z.union([
    z.enum(TRIPZ_MEDIA_CATEGORIES),
    z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/)
  ]),
  label: z.string().trim().min(1).max(300).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  sortOrder: z.number().int().min(0).max(10_000),
  selectedForPdf: z.boolean(),
  metadata: limitedMetadataSchema.optional()
}).strict();

export const tripzIncludedItemSchema = z.object({
  id: tripzUuidSchema.optional(),
  type: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  title: shortText,
  description: z.string().trim().min(1).max(2_000).optional(),
  included: z.boolean()
}).strict();

export const tripzPricingSchema = z.object({
  pricePerPerson: money.optional(),
  boardingTax: money.optional(),
  totalPrice: money.optional(),
  currency: currency.optional(),
  notes: z.string().trim().min(1).max(2_000).optional()
}).strict();

export const tripzItineraryDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(365),
  date: isoDate.optional(),
  title: optionalShortText,
  morning: z.string().trim().min(1).max(3_000).optional(),
  afternoon: z.string().trim().min(1).max(3_000).optional(),
  evening: z.string().trim().min(1).max(3_000).optional(),
  notes: z.array(z.string().trim().min(1).max(500)).max(20).optional()
}).strict();

export const tripzMissingFieldSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  path: z.string().trim().min(1).max(200),
  label: shortText,
  required: z.boolean(),
  reason: z.string().trim().min(1).max(1_000).optional()
}).strict();

export const tripzProposalIssueSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  path: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(1_000),
  severity: z.enum(["info", "warning", "critical"]),
  requiresConfirmation: z.boolean()
}).strict();

const tripzGenerationRequirementSchema = z.object({
  path: z.enum([
    "client.name", "startDate", "endDate", "flights", "hotel", "hotel.name", "hotel.mealPlan",
    "includedItems", "includedItems.insurance", "includedItems.transfer",
    "pricing.totalPrice", "pricing.pricePerPerson", "itinerary", "notes"
  ]),
  label: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500).optional()
}).strict();

const tripzIssueAcknowledgementSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  path: z.string().trim().min(1).max(200).optional(),
  proposalFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const proposalFields = {
  title: z.string().trim().min(1).max(200).optional(),
  client: z.object({ name: optionalShortText }).strict().optional(),
  destination: z.string().trim().min(1).max(300).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  passengers: z.object({
    adults: z.number().int().min(0).max(100).optional(),
    children: z.number().int().min(0).max(100).optional(),
    infants: z.number().int().min(0).max(100).optional()
  }).strict().optional(),
  flights: z.array(tripzFlightSegmentSchema).max(50),
  hotel: tripzHotelSchema.optional(),
  media: z.array(tripzProposalMediaSchema).max(100),
  includedItems: z.array(tripzIncludedItemSchema).max(100),
  pricing: tripzPricingSchema.optional(),
  itinerary: z.array(tripzItineraryDaySchema).max(365),
  notes: z.array(z.string().trim().min(1).max(2_000)).max(100),
  generationRequirements: z.array(tripzGenerationRequirementSchema).max(30),
  issueAcknowledgements: z.array(tripzIssueAcknowledgementSchema).max(100),
  missingInformation: z.array(tripzMissingFieldSchema).max(100),
  inconsistencies: z.array(tripzProposalIssueSchema).max(100),
  status: z.enum(TRIPZ_CONVERSATION_STATUSES)
};

export const tripzProposalStateSchema: z.ZodType<TripzProposalState> = z.object({
  schemaVersion: z.literal(1),
  ...proposalFields
}).strict();

export const tripzProposalPatchSchema: z.ZodType<TripzProposalPatch> = z.object({
  title: proposalFields.title,
  client: z.object({ name: optionalShortText }).strict().optional(),
  destination: proposalFields.destination,
  startDate: proposalFields.startDate,
  endDate: proposalFields.endDate,
  passengers: z.object({
    adults: z.number().int().min(0).max(100).optional(),
    children: z.number().int().min(0).max(100).optional(),
    infants: z.number().int().min(0).max(100).optional()
  }).strict().optional(),
  flights: proposalFields.flights.optional(),
  hotel: tripzHotelSchema.partial().strict().optional(),
  media: proposalFields.media.optional(),
  includedItems: proposalFields.includedItems.optional(),
  pricing: tripzPricingSchema.partial().strict().optional(),
  itinerary: proposalFields.itinerary.optional(),
  notes: proposalFields.notes.optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma alteração");

export const tripzConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional()
}).strict();

export const tripzConversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(200)
}).strict();

export const tripzConversationListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).strict();

export const tripzMessageListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export const tripzMessageCreateSchema = z.object({
  content: z.string().trim().max(20_000).default(""),
  attachmentIds: z.array(tripzUuidSchema).max(10).default([])
}).strict().superRefine((value, context) => {
  if (!value.content && value.attachmentIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Envie uma mensagem ou ao menos um anexo" });
  }
  if (new Set(value.attachmentIds).size !== value.attachmentIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Anexos duplicados" });
  }
});

export const tripzIdempotencyKeySchema = z.string().trim().min(8).max(200)
  .regex(/^[\x21-\x7E]+$/, "Idempotency-Key inválida");

const firstHeader = (value: unknown) => Array.isArray(value) ? value[0] : value;
const fileNameHeader = z.preprocess(firstHeader, z.string().trim().min(1).max(1024))
  .transform((value, context) => {
    try {
      return decodeURIComponent(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "X-Tripz-File-Name inválido" });
      return z.NEVER;
    }
  });
const mimeHeader = z.preprocess(
  firstHeader,
  z.string().trim().min(1)
    .transform((value) => value.split(";", 1)[0].trim().toLocaleLowerCase("en-US"))
    .pipe(z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]))
);
const contentLengthHeader = z.preprocess(
  firstHeader,
  z.string().regex(/^\d+$/).transform(Number)
);

export const tripzAttachmentUploadHeadersSchema = z.object({
  "content-type": mimeHeader,
  "x-tripz-file-name": fileNameHeader.optional(),
  "x-file-name": fileNameHeader.optional(),
  "content-length": contentLengthHeader.optional()
}).passthrough().superRefine((headers, context) => {
  if (!headers["x-tripz-file-name"] && !headers["x-file-name"]) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Informe X-Tripz-File-Name" });
  }
  if (headers["content-length"] !== undefined && headers["content-length"] > 20 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "O arquivo deve ter no máximo 20 MB" });
  }
});

export const tripzProposalPatchRequestSchema = z.object({
  expectedRevision: z.number().int().min(0),
  patch: tripzProposalPatchSchema
}).strict();

export const tripzGenerateDocumentSchema = z.object({
  expectedRevision: z.number().int().min(0)
}).strict();

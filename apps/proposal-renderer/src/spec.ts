import { z } from "zod";

/**
 * ProposalSpec — contrato editorial determinístico do AtendON.
 *
 * A IA nunca produz layout: ela preenche este spec. O renderer deriva as
 * páginas (buildProposalPages) e as desenha com o mesmo conjunto de
 * componentes no preview (panel) e no PDF (Chromium).
 *
 * Campos críticos (viajantes, datas, preço, hotel, voos) podem faltar em
 * rascunho; quem exige presença é o validador do backend, não este schema.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4000);
const money = z.number().finite().min(0).max(1_000_000_000);

/** Posição/corte de uma foto dentro do seu slot (percentuais 0-100). */
export const imagePlacementSchema = z.object({
  /** object-position X em % (0 = esquerda, 100 = direita). */
  x: z.number().min(0).max(100).default(50),
  /** object-position Y em % (0 = topo, 100 = base). */
  y: z.number().min(0).max(100).default(50),
  /** zoom do object-size (100 = cover normal, >100 aproxima). */
  zoom: z.number().min(100).max(300).default(100)
}).strict();

export type ImagePlacement = z.infer<typeof imagePlacementSchema>;

export const travellerRoleSchema = z.enum(["adult", "child", "infant"]);
export type TravellerRole = z.infer<typeof travellerRoleSchema>;

export const travellerSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: shortText,
  role: travellerRoleSchema
}).strict();
export type Traveller = z.infer<typeof travellerSchema>;

export const destinationSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
  name: shortText,
  /** Rótulo do ato editorial, ex.: "Ato I". Derivado se ausente. */
  actLabel: shortText.optional(),
  /** Ex.: "20 — 24 MAI · 4 NOITES". Derivado das datas se ausente. */
  dateRangeLabel: shortText.optional(),
  nights: z.number().int().min(0).max(365).optional(),
  summary: longText.optional(),
  highlights: z.array(shortText).max(12).optional()
}).strict();
export type Destination = z.infer<typeof destinationSchema>;

export const hotelSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
  destinationId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  name: shortText,
  /** true = "hotel a confirmar": o painel declara a pendência em vez de inventar. */
  pending: z.boolean().default(false),
  /** Ex.: "3 estrelas", "4 estrelas", "boutique". */
  category: shortText.optional(),
  roomCategory: shortText.optional(),
  mealPlan: shortText.optional(),
  checkIn: isoDate.optional(),
  checkOut: isoDate.optional(),
  nights: z.number().int().min(0).max(365).optional(),
  description: longText.optional(),
  highlightNote: shortText.optional()
}).strict();
export type Hotel = z.infer<typeof hotelSchema>;

export const flightDirectionSchema = z.enum(["outbound", "return", "internal", "other"]);

export const flightSegmentSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  airline: shortText.optional(),
  flightNumber: z.string().trim().min(1).max(40).optional(),
  direction: flightDirectionSchema.optional(),
  date: isoDate.optional(),
  departureTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  arrivalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  arrivesNextDay: z.boolean().optional(),
  origin: shortText.optional(),
  destination: shortText.optional(),
  duration: z.string().trim().min(1).max(100).optional(),
  stopover: z.string().trim().min(1).max(300).optional(),
  aircraft: shortText.optional(),
  cabin: shortText.optional(),
  baggage: z.string().trim().min(1).max(300).optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict();
export type FlightSegment = z.infer<typeof flightSegmentSchema>;

export const transferSchema = z.object({
  label: shortText.optional(),
  description: longText.optional(),
  direction: z.enum(["arrival", "departure", "between", "other"]).optional()
}).strict();
export type Transfer = z.infer<typeof transferSchema>;

export const experienceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
  title: shortText,
  description: longText.optional(),
  destinationId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  /** Sugestões NUNCA são apresentadas como incluídas. */
  suggested: z.boolean().default(true),
  dayNumber: z.number().int().min(1).max(365).optional()
}).strict();
export type Experience = z.infer<typeof experienceSchema>;

export const inclusionGroupSchema = z.object({
  /** Ex.: "Aéreo & bagagens", "Hospedagens", "Experiências", "Transportes". */
  section: shortText,
  items: z.array(z.object({
    title: shortText,
    detail: z.string().trim().min(1).max(600).optional()
  }).strict()).max(30)
}).strict();
export type InclusionGroup = z.infer<typeof inclusionGroupSchema>;

export const itineraryDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(365),
  date: isoDate.optional(),
  title: shortText.optional(),
  morning: z.string().trim().min(1).max(2000).optional(),
  afternoon: z.string().trim().min(1).max(2000).optional(),
  evening: z.string().trim().min(1).max(2000).optional(),
  destinationId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  /** Sugerido não entra no bloco de incluídos. */
  suggested: z.boolean().default(false)
}).strict();
export type ItineraryDay = z.infer<typeof itineraryDaySchema>;

export const cancellationPolicySchema = z.object({
  label: shortText,
  text: longText
}).strict();
export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;

export const paymentTermEntrySchema = z.object({
  label: shortText,
  value: z.string().trim().min(1).max(300)
}).strict();

export const commercialSchema = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("BRL"),
  total: money.optional(),
  perPerson: money.optional(),
  boardingTax: money.optional(),
  priceNotes: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
  paymentSummary: z.string().trim().min(1).max(600).optional(),
  paymentEntries: z.array(paymentTermEntrySchema).max(12).default([]),
  /** "Por que comprar conosco" + avisos padrão do tenant. */
  differentials: z.array(shortText).max(12).default([])
}).strict();
export type Commercial = z.infer<typeof commercialSchema>;

/** Papéis de página que o planner conhece; componentes opcionais por ausência de dados. */
export const pageKindSchema = z.enum([
  "cover", "concept", "overview", "destination", "hotel", "experiences",
  "services", "flights", "closing"
]);
export type PageKind = z.infer<typeof pageKindSchema>;

export const pageOverrideSchema = z.object({
  /** Identificador estável da página derivada, ex.: "destination:roma". */
  page: z.string().trim().min(1).max(120),
  hidden: z.boolean().optional(),
  /** Deslocamento relativo na sequência (ordem de empate estável por id). */
  order: z.number().int().min(-100).max(100).optional()
}).strict();
export type PageOverride = z.infer<typeof pageOverrideSchema>;

export const imageSourceSchema = z.object({
  url: z.string().trim().url().max(1000).optional(),
  credit: shortText.optional(),
  license: shortText.optional()
}).strict();
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const sourceReferenceSchema = z.object({
  label: shortText,
  url: z.string().trim().url().max(1000).optional(),
  credit: shortText.optional()
}).strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const consultantSchema = z.object({
  name: shortText.optional(),
  role: shortText.optional(),
  phone: z.string().trim().min(1).max(60).optional(),
  email: z.string().trim().email().max(200).optional()
}).strict();
export type Consultant = z.infer<typeof consultantSchema>;

const narrativeSectionSchema = z.object({
  eyebrow: shortText.optional(),
  headline: shortText.optional(),
  body: z.array(z.string().trim().min(1).max(2000)).max(6).optional(),
  quote: shortText.optional(),
  momentsLabel: shortText.optional(),
  moments: z.array(shortText).max(10).optional(),
  /** Blocos de eixo editorial (mini-cards), ex.: CAPITAL → Roma & Vaticano. */
  axes: z.array(z.object({ label: shortText, value: shortText }).strict()).max(6).optional()
}).strict();
export type NarrativeSection = z.infer<typeof narrativeSectionSchema>;

export const narrativeSchema = z.object({
  coverEyebrow: shortText.optional(),
  coverQuote: shortText.optional(),
  overview: narrativeSectionSchema.optional(),
  concept: narrativeSectionSchema.optional(),
  closing: narrativeSectionSchema.optional(),
  /** chave = destinationId. */
  destinationCopy: z.record(z.string().trim().regex(/^[a-z0-9-]{1,60}$/), narrativeSectionSchema).default({})
}).strict();
export type Narrative = z.infer<typeof narrativeSchema>;

export const proposalSpecSchema = z.object({
  schemaVersion: z.literal(2),
  tripTitle: shortText.optional(),
  origin: shortText.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  departureDate: isoDate.optional(),
  returnDate: isoDate.optional(),
  nights: z.number().int().min(0).max(365).optional(),
  travellers: z.array(travellerSchema).max(30).default([]),
  destinations: z.array(destinationSchema).max(20).default([]),
  hotels: z.array(hotelSchema).max(20).default([]),
  flights: z.array(flightSegmentSchema).max(50).default([]),
  transfers: z.array(transferSchema).max(30).default([]),
  experiences: z.array(experienceSchema).max(60).default([]),
  inclusions: z.array(inclusionGroupSchema).max(12).default([]),
  exclusions: z.array(shortText).max(30).default([]),
  baggage: z.array(shortText).max(20).default([]),
  cancellationPolicies: z.array(cancellationPolicySchema).max(10).default([]),
  itinerary: z.array(itineraryDaySchema).max(365).default([]),
  commercial: commercialSchema.default({ currency: "BRL", priceNotes: [], paymentEntries: [] }),
  consultant: consultantSchema.default({}),
  narrative: narrativeSchema.default({ destinationCopy: {} }),
  /** Referências de imagem por papel; mediaId resolve no render (assets map).
   * destination/hotel/experience exigem targetId = "<id>" do alvo. */
  imageAssignments: z.array(z.object({
    mediaId: z.string().trim().min(1).max(120),
    role: z.enum(["cover", "concept", "closing", "flights", "destination", "hotel", "experience", "gallery"]),
    targetId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
    placement: imagePlacementSchema.optional(),
    caption: shortText.optional(),
    source: imageSourceSchema.optional()
  }).strict()).max(120).default([]).superRefine((assignments, context) => {
    for (const [index, assignment] of assignments.entries()) {
      if ((assignment.role === "destination" || assignment.role === "hotel" || assignment.role === "experience") && !assignment.targetId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["imageAssignments", index, "targetId"],
          message: `Papel ${assignment.role} exige targetId`
        });
      }
    }
  }),
  sources: z.array(sourceReferenceSchema).max(40).default([]),
  pageOverrides: z.array(pageOverrideSchema).max(60).default([])
}).strict();

export type ProposalSpec = z.infer<typeof proposalSpecSchema>;
export type ProposalSpecInput = z.input<typeof proposalSpecSchema>;

export function createEmptyProposalSpec(): ProposalSpec {
  return proposalSpecSchema.parse({
    schemaVersion: 2
  });
}

/** Papéis de imagem deriváveis dos dados (usado pelo builder e pelo editor). */
export function deriveImageRoles(spec: ProposalSpec): Array<{ mediaId: string; role: string; targetId?: string }> {
  return spec.imageAssignments.map((assignment) => ({
    mediaId: assignment.mediaId,
    role: assignment.role,
    ...(assignment.targetId ? { targetId: assignment.targetId } : {})
  }));
}

export const EDITORIAL_SPEC_VERSION = 2;

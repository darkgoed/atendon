import { z } from "zod";
import { customSectionSchema, proposalThemeSchema } from "@atendon/proposal-renderer";
import { TRIPZ_MEDIA_CATEGORIES } from "../domain.js";

const shortText = z.string().trim().min(1).max(500);
const nullableShortText = shortText.nullable();
const nullableTitle = z.string().trim().min(1).max(200).nullable();
const nullableDestination = z.string().trim().min(1).max(300).nullable();
const isoDate = z.string().date().nullable();
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable();
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable();
const nonNegativeMoney = z.number().finite().nonnegative().max(1_000_000_000).nullable();

/**
 * Bloco editorial do patch — permissivo no formato, validado no destino:
 * elementos de lista com id fazem upsert; scalars substituem; imageAssignments
 * e sources substituem o array quando enviados.
 */
const editorialSectionSchema = z.object({
  eyebrow: shortText.optional(),
  headline: shortText.optional(),
  body: z.array(z.string().trim().min(1).max(2_000)).max(6).optional(),
  quote: shortText.optional(),
  momentsLabel: shortText.optional(),
  moments: z.array(z.string().trim().min(1).max(300)).max(10).optional()
}).strict().partial();

export const tripzEditorialPatchSchema = z.object({
  tripTitle: z.string().trim().min(1).max(200).nullable().optional(),
  origin: z.string().trim().min(1).max(200).nullable().optional(),
  consultant: z.object({
    name: shortText.optional(),
    role: shortText.optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(1).max(60).optional()
  }).strict().nullable().optional(),
  narrative: z.object({
    coverEyebrow: shortText.optional(),
    coverQuote: shortText.optional(),
    concept: editorialSectionSchema.optional(),
    closing: editorialSectionSchema.optional(),
    destinationCopy: z.record(z.string().trim().regex(/^[a-z0-9-]{1,60}$/), editorialSectionSchema).optional()
  }).strict().nullable().optional(),
  destinations: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
    name: shortText.optional(),
    actLabel: shortText.optional(),
    dateRangeLabel: shortText.optional(),
    nights: z.number().int().min(0).max(365).optional(),
    summary: z.string().trim().min(1).max(4_000).optional(),
    highlights: z.array(shortText).max(12).optional()
  }).strict()).max(20).optional(),
  hotels: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
    destinationId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
    name: shortText.optional(),
    pending: z.boolean().optional(),
    category: shortText.optional(),
    roomCategory: shortText.optional(),
    mealPlan: shortText.optional(),
    checkIn: isoDate.optional(),
    checkOut: isoDate.optional(),
    nights: z.number().int().min(0).max(365).optional(),
    description: z.string().trim().min(1).max(4_000).optional(),
    highlightNote: shortText.optional()
  }).strict()).max(20).optional(),
  experiences: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
    title: shortText.optional(),
    description: z.string().trim().min(1).max(4_000).optional(),
    destinationId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
    suggested: z.boolean().optional(),
    dayNumber: z.number().int().min(1).max(365).optional()
  }).strict()).max(60).optional(),
  inclusions: z.array(z.object({
    section: shortText,
    items: z.array(z.object({
      title: shortText,
      detail: z.string().trim().min(1).max(2_000).optional()
    }).strict()).max(30)
  }).strict()).max(12).optional(),
  exclusions: z.array(shortText).max(30).optional(),
  baggage: z.array(shortText).max(20).optional(),
  transfers: z.array(z.object({
    label: shortText.optional(),
    description: z.string().trim().min(1).max(4_000).optional(),
    direction: z.enum(["arrival", "departure", "between", "other"]).optional()
  }).strict()).max(30).optional(),
  cancellationPolicies: z.array(z.object({
    label: shortText,
    text: z.string().trim().min(1).max(2_000)
  }).strict()).max(10).optional(),
  commercial: z.object({
    currency: currency.optional(),
    total: nonNegativeMoney.nullable().optional(),
    perPerson: nonNegativeMoney.nullable().optional(),
    boardingTax: nonNegativeMoney.nullable().optional(),
    priceNotes: z.array(shortText).max(10).optional(),
    paymentSummary: z.string().trim().min(1).max(2_000).nullable().optional(),
    paymentEntries: z.array(z.object({
      label: shortText,
      value: z.string().trim().min(1).max(300)
    }).strict()).max(12).optional(),
    differentials: z.array(shortText).max(15).optional()
  }).strict().nullable().optional(),
  imageAssignments: z.array(z.object({
    mediaId: z.string().trim().min(1).max(120).optional(),
    role: z.enum(["cover", "concept", "closing", "flights", "destination", "hotel", "experience", "gallery"]).optional(),
    targetId: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
    /** Enquadramento: x/y = ponto focal em %, zoom 100-300. */
    placement: z.object({
      x: z.number().min(0).max(100).default(50),
      y: z.number().min(0).max(100).default(50),
      zoom: z.number().min(100).max(300).default(100)
    }).strict().optional(),
    caption: shortText.optional()
  }).strict()).max(40).optional(),
  pageOverrides: z.array(z.object({
    page: z.string().trim().regex(/^(?:cover|concept|overview|experiences|services|flights|closing|(?:destination|hotel|section):[a-z0-9-]{1,60})$/),
    hidden: z.boolean().optional(),
    order: z.number().int().min(-100).max(100).optional(),
    layout: z.enum(["hero", "side"]).optional()
  }).strict()).max(40).optional(),
  /** Seções livres (upsert por id; { id, remove: true } apaga). */
  customSections: z.array(z.union([
    customSectionSchema,
    z.object({ id: z.string().trim().regex(/^[a-z0-9-]{1,60}$/), remove: z.literal(true) }).strict()
  ])).max(12).optional(),
  /** Visual desta proposta; null volta à identidade padrão da marca. */
  theme: proposalThemeSchema.nullable().optional(),
  sources: z.array(z.object({
    label: shortText,
    url: z.string().trim().url().max(2_000).optional(),
    credit: shortText.optional()
  }).strict()).max(30).optional()
}).strict().nullable();

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
    z.number().int().min(0).max(100).transform((adults) => ({ adults, children: 0, infants: 0 })),
    // Providers sometimes summarize passengers as {count, description} (ex.:
    // "duas pessoas casal") instead of the headcount object. Coerce count and
    // drop the free-text description rather than fail the whole turn.
    z.object({ count: z.coerce.number().int().min(0).max(100) }).passthrough()
      .transform(({ count }) => ({ adults: count, children: 0, infants: 0 })),
    // Providers sometimes return a named passenger list instead of the
    // headcount object despite the prompt. Coerce to counts rather than fail
    // the whole turn.
    z.array(
      z.object({
        name: z.string().trim().min(1).max(500),
        type: z.enum(['adult', 'child', 'infant'])
      }).strict()
    ).min(1).max(100).transform((items) => ({
      adults: items.filter((p) => p.type === 'adult').length,
      children: items.filter((p) => p.type === 'child').length,
      infants: items.filter((p) => p.type === 'infant').length
    }))
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
  notes: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  editorial: tripzEditorialPatchSchema.nullable().optional()
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
  "notes",
  "editorial.tripTitle",
  "editorial.narrative",
  "editorial.destinations",
  "editorial.hotels",
  "editorial.experiences",
  "editorial.inclusions",
  "editorial.commercial.total",
  "editorial.commercial.paymentEntries",
  "editorial.imageAssignments",
  "editorial.sources"
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

type UnknownKeyRemoval = { path: (string | number)[]; keys: string[] };

function collectUnknownKeyRemovals(error: z.ZodError): UnknownKeyRemoval[] {
  const removals: UnknownKeyRemoval[] = [];
  const visit = (issues: z.ZodIssue[]): void => {
    for (const issue of issues) {
      if (issue.code === "unrecognized_keys") {
        removals.push({ path: [...issue.path], keys: [...issue.keys] });
      } else if (issue.code === "invalid_union") {
        for (const unionError of issue.unionErrors) visit(unionError.issues);
      }
    }
  };
  visit(error.issues);
  return removals;
}

function removeUnknownKeysAt(value: unknown, path: readonly (string | number)[], keys: readonly string[]): void {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
    for (const key of keys) delete (cursor as Record<string, unknown>)[key];
  }
}

const PROVIDER_PATCH_SALVAGE_ROUNDS = 3;

/** Partes opcionais do layout: um item inválido some sozinho em vez de derrubar o turno. */
const DECORATIVE_LISTS = new Set(["customSections", "pageOverrides", "imageAssignments", "sources"]);

function droppableDecorativeItems(error: z.ZodError): Array<(string | number)[]> {
  const found: Array<(string | number)[]> = [];
  const visit = (issues: z.ZodIssue[]): void => {
    for (const issue of issues) {
      const [root, key, index] = issue.path;
      if (root === "editorial" && key === "theme") found.push(["editorial", "theme"]);
      else if (root === "editorial" && typeof key === "string" && DECORATIVE_LISTS.has(key) && typeof index === "number") found.push(["editorial", key, index]);
      else if (issue.code === "invalid_union") for (const unionError of issue.unionErrors) visit(unionError.issues);
    }
  };
  visit(error.issues);
  // Só vale se TODO erro restante cair em partes decorativas.
  const decorative = error.issues.every((issue) => issue.path[0] === "editorial"
    && (issue.path[1] === "theme" || (typeof issue.path[1] === "string" && DECORATIVE_LISTS.has(issue.path[1]) && typeof issue.path[2] === "number")));
  return decorative ? found : [];
}

function dropDecorativeItems(value: unknown, paths: Array<(string | number)[]>): void {
  if (!value || typeof value !== "object") return;
  const editorial = (value as Record<string, unknown>).editorial as Record<string, unknown> | undefined;
  if (!editorial) return;
  const byList = new Map<string, Set<number>>();
  for (const path of paths) {
    if (path[1] === "theme") delete editorial.theme;
    else byList.set(String(path[1]), (byList.get(String(path[1])) ?? new Set()).add(Number(path[2])));
  }
  for (const [key, indexes] of byList) {
    const list = editorial[key];
    if (Array.isArray(list)) editorial[key] = list.filter((_item, index) => !indexes.has(index));
  }
}

const EDITORIAL_ONLY_KEYS = ["customSections", "theme", "pageOverrides", "narrative", "imageAssignments", "sources", "destinations", "hotels", "experiences", "inclusions", "commercial", "tripTitle"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inclusionGroup(section: unknown, items: unknown): { section: string; items: Array<{ title: string; detail?: string }> } | undefined {
  if (!Array.isArray(items)) return undefined;
  const normalized = items.flatMap((item) => typeof item === "string" && item.trim()
    ? [{ title: item.trim().slice(0, 500) }]
    : isPlainObject(item) && typeof item.title === "string" ? [item as { title: string; detail?: string }] : []);
  if (normalized.length === 0) return undefined;
  return { section: typeof section === "string" && section.trim() ? section.trim().slice(0, 500) : "Incluído", items: normalized.slice(0, 30) };
}

/**
 * Formas que o modelo produz de verdade e que têm leitura inequívoca:
 * campos editoriais no topo do patch (fora de "editorial") e inclusions como
 * objeto { eyebrow/section, items: [texto] } ou lista de textos.
 */
export function normalizeProviderPatchShape(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const patch: Record<string, unknown> = { ...value };
  const editorial: Record<string, unknown> = isPlainObject(patch.editorial) ? { ...patch.editorial } : {};
  let moved = false;
  for (const key of EDITORIAL_ONLY_KEYS) {
    if (key in patch && !["title"].includes(key)) {
      if (!(key in editorial)) editorial[key] = patch[key];
      delete patch[key];
      moved = true;
    }
  }
  // Texto editorial de destino escrito dentro de editorial.destinations
  // (eyebrow/headline/body) pertence a narrative.destinationCopy[id].
  if (Array.isArray(editorial.destinations)) {
    const copyKeys = ["eyebrow", "headline", "body", "quote", "momentsLabel", "moments"] as const;
    const narrative: Record<string, unknown> = isPlainObject(editorial.narrative) ? { ...editorial.narrative } : {};
    const destinationCopy: Record<string, unknown> = isPlainObject(narrative.destinationCopy) ? { ...narrative.destinationCopy } : {};
    let copied = false;
    editorial.destinations = editorial.destinations.map((item) => {
      if (!isPlainObject(item) || typeof item.id !== "string") return item;
      const destination: Record<string, unknown> = { ...item };
      const copy: Record<string, unknown> = {};
      for (const key of copyKeys) {
        if (key in destination) { copy[key] = destination[key]; delete destination[key]; }
      }
      if (typeof copy.body === "string") copy.body = [copy.body];
      if (Object.keys(copy).length > 0 && !(item.id in destinationCopy)) {
        destinationCopy[item.id] = copy;
        copied = true;
      }
      return destination;
    });
    if (copied) {
      narrative.destinationCopy = destinationCopy;
      editorial.narrative = narrative;
      moved = true;
    }
  }
  // Hotel: body/headline viram description/highlightNote.
  if (Array.isArray(editorial.hotels)) {
    editorial.hotels = editorial.hotels.map((item) => {
      if (!isPlainObject(item)) return item;
      const hotel: Record<string, unknown> = { ...item };
      const body = Array.isArray(hotel.body) ? hotel.body.filter((part) => typeof part === "string").join("\n\n") : hotel.body;
      if (typeof body === "string" && body.trim() && hotel.description === undefined) hotel.description = body.slice(0, 4_000);
      if (typeof hotel.headline === "string" && hotel.highlightNote === undefined) hotel.highlightNote = hotel.headline;
      delete hotel.body;
      delete hotel.headline;
      delete hotel.eyebrow;
      return hotel;
    });
  }
  const inclusions = editorial.inclusions;
  if (inclusions !== undefined && !(Array.isArray(inclusions) && inclusions.every((group) => isPlainObject(group) && typeof group.section === "string"))) {
    let groups: unknown[] = [];
    if (isPlainObject(inclusions)) {
      const group = inclusionGroup(inclusions.section ?? inclusions.eyebrow ?? inclusions.title, inclusions.items);
      groups = group ? [group] : [];
    } else if (Array.isArray(inclusions)) {
      if (inclusions.every((item) => typeof item === "string")) {
        const group = inclusionGroup("Incluído", inclusions);
        groups = group ? [group] : [];
      } else {
        groups = inclusions.flatMap((item) => isPlainObject(item)
          ? [inclusionGroup(item.section ?? item.eyebrow ?? item.title, item.items)].filter(Boolean)
          : []);
      }
    }
    editorial.inclusions = groups;
    moved = true;
  }
  if (moved || isPlainObject(patch.editorial)) patch.editorial = editorial;
  return patch;
}

/**
 * Patches grandes (seções inteiras) às vezes saem com chave sobrando no fim
 * ("Extra data") ou cortados antes de fechar. Varre respeitando strings:
 * fica com o primeiro objeto completo, ou fecha o que ficou aberto. O
 * resultado ainda passa pela validação completa do schema.
 */
export function repairJsonObjectText(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) { end = index; break; }
    }
  }
  const body = end >= 0
    ? text.slice(start, end + 1)
    : inString ? undefined : `${text.slice(start).replace(/,\s*$/, "")}${stack.reverse().join("")}`;
  if (body === undefined) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Providers invent fields outside the grammar despite the strict JSON schema
// (observed in production: unknown top-level keys and {count, description}
// passengers). Unknown keys are inert downstream — the allowlisted applier
// copies only known fields — so salvage the turn by stripping exactly the
// keys Zod reports instead of failing it. Invalid VALUES are never salvaged.
export const tripzProviderProposalPatchSchema = z.unknown().transform((value, context) => {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    if (candidate.length > 100_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "proposalPatch excede o tamanho máximo" });
      return z.NEVER;
    }
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      const repaired = repairJsonObjectText(candidate as string);
      if (repaired === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "proposalPatch não contém JSON válido" });
        return z.NEVER;
      }
      candidate = repaired;
    }
  }
  candidate = normalizeProviderPatchShape(candidate);
  for (let round = 0; round <= PROVIDER_PATCH_SALVAGE_ROUNDS; round += 1) {
    const parsed = tripzProposalPatchSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const removals = collectUnknownKeyRemovals(parsed.error);
    const droppable = droppableDecorativeItems(parsed.error);
    if (droppable.length > 0 && round < PROVIDER_PATCH_SALVAGE_ROUNDS) {
      candidate = structuredClone(candidate) as object;
      dropDecorativeItems(candidate, droppable);
      continue;
    }
    if (removals.length === 0 || round === PROVIDER_PATCH_SALVAGE_ROUNDS) {
      for (const issue of parsed.error.issues.slice(0, 20)) context.addIssue(issue);
      return z.NEVER;
    }
    candidate = structuredClone(candidate) as object;
    for (const removal of removals) removeUnknownKeysAt(candidate, removal.path, removal.keys);
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: "proposalPatch inválido" });
  return z.NEVER;
});

export const tripzAiProviderOutputSchema = tripzAiStructuredOutputSchema.extend({
  // Keep the provider grammar small while preserving the complete allowlisted
  // patch validation before any state is changed. Object input remains
  // accepted for compatibility with deterministic tests and stored fixtures,
  // and unknown provider-invented keys are stripped instead of failing the
  // turn (see tripzProviderProposalPatchSchema).
  proposalPatch: tripzProviderProposalPatchSchema
});

export type TripzAiStructuredOutput = z.infer<typeof tripzAiStructuredOutputSchema>;
export type TripzAiProposalPatch = z.infer<typeof tripzProposalPatchSchema>;
export type TripzEditorialPatch = NonNullable<z.infer<typeof tripzEditorialPatchSchema>>;
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

// Wave B — montagem do ProposalSpec editorial a partir do estado da proposta.
// Compila contra o estado v1 (domain.ts) e lê os campos v2 (destinations/hotels/
// services/commercial/travellers/editorial) via cast documentado até o Wave C
// aterrissar os tipos novos. TODO(wave-c): tipar via domain.
import {
  PROPOSAL_RENDERER_VERSION,
  proposalSpecSchema,
  type ProposalBrandConfig,
  type ProposalSpec
} from "@atendon/proposal-renderer";
import { TripzAiError, type TripzProposalState } from "../domain.js";

export const TRIPZ_STATE_TO_SPEC_VERSION = PROPOSAL_RENDERER_VERSION;

export interface TripzConsultantContext {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
}

export interface TripzStateToSpecContext {
  tenantId: string;
  consultant?: TripzConsultantContext;
  brand?: ProposalBrandConfig;
}

export interface TripzStateToSpecResult {
  spec: ProposalSpec | null;
  issues: string[];
  brand?: ProposalBrandConfig;
}

/** Campos v2 (Wave C): o bloco editorial vive em state.editorial. */
type EditorialStateV2 = {
  editorial?: {
    narrative?: Record<string, unknown>;
    destinations?: Array<Record<string, unknown>>;
    hotels?: Array<Record<string, unknown>>;
    experiences?: Array<Record<string, unknown>>;
    inclusions?: Array<Record<string, unknown>>;
    exclusions?: unknown;
    baggage?: unknown;
    cancellationPolicies?: Array<Record<string, unknown>>;
    transfers?: Array<Record<string, unknown>>;
    commercial?: Record<string, unknown>;
    imageAssignments?: Array<Record<string, unknown>>;
    sources?: Array<Record<string, unknown>>;
    pageOverrides?: unknown;
    travellers?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function romanAct(index: number): string {
  const place = index % ROMAN.length;
  const cycle = Math.floor(index / ROMAN.length);
  const base = ROMAN[place] ?? "I";
  return cycle > 0 ? `${base}·${cycle + 1}` : base;
}

function nightsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const a = Date.parse(`${start}T12:00:00Z`);
  const b = Date.parse(`${end}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return undefined;
  return Math.round((b - a) / 86_400_000);
}

function flightDirection(index: number, total: number, value: unknown): string {
  const explicit = str(value);
  if (explicit === "outbound" || explicit === "return" || explicit === "internal" || explicit === "other") return explicit;
  if (total <= 1) return "outbound";
  if (index === 0) return "outbound";
  if (index === total - 1) return "return";
  return "internal";
}

function cleanStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => str(item)).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

export function mapDestinations(state: TripzProposalState, extras: EditorialStateV2): Array<Record<string, unknown>> {
  if (Array.isArray(extras.editorial?.destinations) && extras.editorial?.destinations.length > 0) {
    return extras.editorial?.destinations.map((destination, index) => {
      const actNumber = num(destination.actNumber);
      const ownName = str(destination.name);
      const idName = str(destination.id)?.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
      // Com vários destinos, o destino geral ("Lisboa e Sintra") repetiria em todos.
      const name = ownName ?? (extras.editorial!.destinations!.length > 1 ? idName : str(state.destination) ?? idName) ?? "Destino";
      return {
        id: str(destination.id) ?? slugify(name),
        name,
        actLabel: str(destination.actLabel) ?? `Ato ${romanAct(actNumber !== undefined ? actNumber - 1 : index)}`,
        dateRangeLabel: str(destination.dateRangeLabel),
        nights: num(destination.nights),
        summary: str(destination.summary),
        highlights: cleanStrings(destination.highlights)
      };
    });
  }
  const destination = str(state.destination);
  if (!destination) return [];
  return [{ id: slugify(destination) || "destino", name: destination, actLabel: "Ato I" }];
}

function mapHotels(
  state: TripzProposalState,
  extras: EditorialStateV2,
  destinationIds: string[]
): Array<Record<string, unknown>> {
  if (Array.isArray(extras.editorial?.hotels) && extras.editorial?.hotels.length > 0) {
    return extras.editorial?.hotels.map((hotel, index) => {
      const name = str(hotel.name);
      return {
        id: str(hotel.id) ?? `hotel-${index + 1}`,
        destinationId: str(hotel.destinationId) ?? destinationIds[0],
        name: name ?? "Hotel a definir",
        pending: hotel.pending === true || name === undefined,
        category: str(hotel.category),
        roomCategory: str(hotel.roomCategory) ?? str((state.hotel as Record<string, unknown> | undefined)?.roomType),
        mealPlan: str(hotel.mealPlan),
        checkIn: str(hotel.checkIn),
        checkOut: str(hotel.checkOut),
        nights: num(hotel.nights),
        description: str(hotel.description),
        highlightNote: str(hotel.highlightNote)
      };
    });
  }
  const hotel = state.hotel;
  const name = str(hotel?.name);
  if (!hotel || !name) return [];
  return [{
    id: `hotel-${slugify(name)}`,
    destinationId: destinationIds[0],
    name,
    pending: false,
    roomCategory: str(hotel.roomType),
    mealPlan: str(hotel.mealPlan),
    checkIn: str(hotel.checkIn),
    checkOut: str(hotel.checkOut),
    nights: nightsBetween(str(hotel.checkIn), str(hotel.checkOut)),
    description: str(hotel.description)
  }];
}

function mapFlights(state: TripzProposalState): Array<Record<string, unknown>> {
  const total = state.flights.length;
  return state.flights.map((flight, index) => ({
    id: flight.id ?? `flight-${index + 1}`,
    airline: str(flight.airline),
    flightNumber: str(flight.flightNumber),
    direction: flightDirection(index, total, (flight as Record<string, unknown>).direction),
    date: str(flight.date),
    departureTime: str(flight.departureTime),
    arrivalTime: str(flight.arrivalTime),
    arrivesNextDay: flight.arrivesNextDay === true ? true : undefined,
    origin: str(flight.origin),
    destination: str(flight.destination),
    duration: str(flight.duration),
    stopover: str(flight.stopover) ?? cleanStrings(flight.notes)?.join(" · "),
    aircraft: str(flight.aircraft),
    cabin: str(flight.cabin),
    baggage: str(flight.baggage),
    confidence: num(flight.confidence)
  }));
}

function mapTravellers(state: TripzProposalState, extras: EditorialStateV2): Array<Record<string, unknown>> {
  if (Array.isArray(extras.travellers) && extras.travellers.length > 0) {
    return extras.travellers.map((traveller, index) => ({
      id: str(traveller.id) ?? `traveller-${index + 1}`,
      name: str(traveller.name) ?? `Viajante ${index + 1}`,
      role: traveller.role === "child" || traveller.role === "infant" ? traveller.role : "adult"
    }));
  }
  const passengers = state.passengers;
  if (!passengers || (!passengers.adults && !passengers.children && !passengers.infants)) {
    const name = str(state.client?.name);
    return [{ id: "traveller-1", name: name ?? "Viajante", role: "adult" }];
  }
  const travellers: Array<Record<string, unknown>> = [];
  const clientName = str(state.client?.name);
  // "Jhonny & Shayene" com 2 adultos = um nome por adulto, não "Jhonny & Shayene & Adulto 2".
  const parts = clientName?.split(/\s*(?:&|,|\s+e\s+)\s*/i).map((part) => part.trim()).filter(Boolean) ?? [];
  const adults = passengers.adults ?? 0;
  const names = parts.length > 1 && parts.length <= adults ? parts : clientName ? [clientName] : [];
  for (let adult = 0; adult < adults; adult += 1) {
    travellers.push({
      id: `traveller-${travellers.length + 1}`,
      name: names[adult] ?? `Adulto ${adult + 1}`,
      role: "adult"
    });
  }
  for (let child = 0; child < (passengers.children ?? 0); child += 1) {
    travellers.push({ id: `traveller-${travellers.length + 1}`, name: `Criança ${child + 1}`, role: "child" });
  }
  for (let infant = 0; infant < (passengers.infants ?? 0); infant += 1) {
    travellers.push({ id: `traveller-${travellers.length + 1}`, name: `Bebê ${infant + 1}`, role: "infant" });
  }
  return travellers;
}

const INCLUSION_SECTIONS: Record<string, string> = {
  transfer: "Traslados",
  insurance: "Seguro viagem",
  flight: "Voos",
  hotel: "Hospedagem",
  experience: "Experiências"
};

function mapInclusions(state: TripzProposalState, extras: EditorialStateV2): Array<{ section: string; items: Array<{ title: string; detail?: string }> }> {
  const groups = extras.editorial?.inclusions;
  if (Array.isArray(groups) && groups.length > 0) {
    return groups
      .map((group) => ({
        section: str(group.section) ?? "Inclusões",
        items: (Array.isArray(group.items) ? group.items : []).map((raw) => {
          const item = raw as { title?: unknown; detail?: unknown } | string;
          if (typeof item === "string") return { title: item };
          const title = str(item.title) ?? "";
          const detail = str(item.detail);
          return detail ? { title, detail } : { title };
        }).filter((item) => item.title)
      }))
      .filter((group) => group.items.length > 0);
  }
  const included = state.includedItems.filter((item) => item.included && str(item.title));
  if (included.length === 0) return [];
  const byType = new Map<string, Array<{ title: string; detail?: string }>>();
  for (const item of included) {
    const section = INCLUSION_SECTIONS[str(item.type)?.toLowerCase() ?? ""] ?? "Inclusões";
    const items = byType.get(section) ?? [];
    const title = str(item.title) as string;
    const detail = str(item.description);
    items.push(detail ? { title, detail } : { title });
    byType.set(section, items);
  }
  return [...byType.entries()].map(([section, items]) => ({ section, items }));
}

function mapExclusions(state: TripzProposalState): string[] {
  return state.includedItems
    .filter((item) => !item.included)
    .map((item) => str(item.title))
    .filter((title): title is string => Boolean(title));
}

function mapTransfers(state: TripzProposalState, extras: EditorialStateV2): Array<Record<string, unknown>> {
  const v2 = Array.isArray(extras.editorial?.transfers) && extras.editorial?.transfers.length > 0
    ? extras.editorial?.transfers
    : state.includedItems
      .filter((item) => item.included && str(item.type)?.toLowerCase() === "transfer" && str(item.title))
      .map((item) => ({ label: item.title, description: str(item.description) }));
  return v2.map((raw) => {
    const transfer = raw as { label?: unknown; description?: unknown; direction?: unknown };
    return {
      label: str(transfer.label),
      description: str(transfer.description),
      direction: str(transfer.direction)
    };
  });
}

function mapExperiences(extras: EditorialStateV2, destinationIds: string[]): Array<Record<string, unknown>> {
  const v2 = Array.isArray(extras.editorial?.experiences) ? extras.editorial?.experiences : [];
  return v2
    .map((experience, index) => ({
      id: str(experience.id) ?? `experience-${index + 1}`,
      title: str(experience.title),
      description: str(experience.description),
      destinationId: str(experience.destinationId) ?? destinationIds[0],
      suggested: experience.suggested === true ? true : undefined,
      dayNumber: num(experience.dayNumber)
    }))
    .filter((experience) => Boolean(experience.title));
}

function mapItinerary(state: TripzProposalState, destinationIds: string[], destinationNames: string[]): Array<Record<string, unknown>> {
  return state.itinerary.map((day) => {
    const haystack = [day.title, day.morning, day.afternoon, day.evening, ...(day.notes ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    let destinationId: string | undefined;
    if (destinationIds.length === 1) {
      destinationId = destinationIds[0];
    } else {
      const match = destinationNames.findIndex((name) => haystack.includes(name.toLowerCase()));
      if (match >= 0) destinationId = destinationIds[match];
    }
    return {
      dayNumber: day.dayNumber,
      date: str(day.date),
      title: str(day.title),
      morning: str(day.morning),
      afternoon: str(day.afternoon),
      evening: str(day.evening),
      destinationId,
      suggested: ((day as unknown as Record<string, unknown>).suggested === true ? true : undefined)
    };
  });
}

function mapCommercial(state: TripzProposalState, extras: EditorialStateV2): Record<string, unknown> {
  const v2 = extras.editorial?.commercial;
  if (v2 && Object.keys(v2).length > 0) {
    return {
      currency: str(v2.currency) ?? str(state.pricing?.currency),
      total: num(v2.total) ?? num(state.pricing?.totalPrice),
      perPerson: num(v2.perPerson) ?? num(state.pricing?.pricePerPerson),
      boardingTax: num(v2.boardingTax) ?? num(state.pricing?.boardingTax),
      priceNotes: cleanStrings(v2.priceNotes) ?? (state.pricing?.notes ? [state.pricing.notes] : undefined),
      paymentSummary: str(v2.paymentSummary),
      paymentEntries: Array.isArray(v2.paymentEntries)
        ? v2.paymentEntries.map((entry) => {
            const record = entry as Record<string, unknown>;
            return { label: str(record.label) ?? "", value: str(record.value) ?? "" };
          })
        : undefined,
      differentials: cleanStrings(v2.differentials)
    };
  }
  const pricing = state.pricing;
  if (!pricing) return {};
  return {
    currency: str(pricing.currency),
    total: num(pricing.totalPrice),
    perPerson: num(pricing.pricePerPerson),
    boardingTax: num(pricing.boardingTax),
    priceNotes: str(pricing.notes) ? [str(pricing.notes)] : undefined
  };
}

type ImageCandidate = { id: string; slug: string };

const SINGLE_IMAGE_ROLES = new Set(["cover", "concept", "closing", "flights", "destination", "hotel"]);
const TARGETED_IMAGE_ROLES = new Set(["destination", "hotel", "experience"]);
const IMAGE_ROLES = new Set(["cover", "concept", "closing", "flights", "destination", "hotel", "experience", "gallery"]);

function candidatesOf(items: Array<Record<string, unknown>>, nameKey = "name"): ImageCandidate[] {
  return items
    .map((item) => ({ id: String(item.id ?? ""), slug: slugify(String(item[nameKey] ?? "")) }))
    .filter((candidate) => candidate.id);
}

/** Alvo pelo id exato ou pelo nome ("hf-fenix-porto", "Villa Pandora") — a IA nem sempre vê os ids. */
function resolveImageTarget(targetId: string | undefined, candidates: ImageCandidate[]): string | undefined {
  if (!targetId) return undefined;
  if (candidates.some((candidate) => candidate.id === targetId)) return targetId;
  const slug = slugify(targetId).replace(/^hotel-/, "");
  if (slug.length < 3) return undefined;
  return candidates.find((candidate) => candidate.slug === slug || candidate.id === `hotel-${slug}`)?.id
    ?? candidates.find((candidate) => candidate.slug.length >= 3 && (candidate.slug.includes(slug) || slug.includes(candidate.slug)))?.id;
}

/** Nome do hotel/destino citado na legenda da foto ("Piscina do Villa Pandora"). */
function targetFromLabel(label: string | undefined, candidates: ImageCandidate[]): string | undefined {
  const slug = label ? slugify(label) : "";
  if (!slug) return undefined;
  const significant = (value: string) => value.split("-").filter((word) => word.length >= 4 && !["hotel", "pousada", "resort"].includes(word));
  return candidates.find((candidate) => candidate.slug.length >= 3 && slug.includes(candidate.slug))?.id
    ?? candidates.find((candidate) => significant(candidate.slug).some((word) => slug.split("-").includes(word)))?.id;
}

function imageSource(value: unknown): Record<string, string> | undefined {
  if (typeof value === "string") return str(value) ? { credit: str(value)! } : undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const source = Object.fromEntries((["url", "credit", "license"] as const)
    .map((key) => [key, str(record[key])])
    .filter((entry): entry is [string, string] => Boolean(entry[1])));
  return Object.keys(source).length > 0 ? source : undefined;
}

function imagePlacement(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const x = num(record.x);
  const y = num(record.y);
  const zoom = num(record.zoom);
  if (x === undefined && y === undefined && zoom === undefined) return undefined;
  return { x: x ?? 50, y: y ?? 50, zoom: zoom ?? 100 };
}

/**
 * Fotos do documento = atribuições explícitas (IA/editor) + inferência pelas
 * categorias da mídia para o que ninguém atribuiu.
 * - Explícita vence a inferida no mesmo slot (capa, hotel X, destino Y…).
 * - Alvos são resolvidos por id ou nome; alvo inexistente descarta a atribuição
 *   em vez de invalidar o documento inteiro.
 * - hotel_* → hotel (pela legenda ou hotel único); fotos extras do mesmo hotel
 *   viram galeria dele. destination → destino (legenda ou destino único).
 *   airline → print de voos. Capa mais recente primeiro.
 */
function mapImageAssignments(
  state: TripzProposalState,
  destinations: Array<Record<string, unknown>>,
  hotels: Array<Record<string, unknown>>,
  experiences: Array<Record<string, unknown>>,
  explicit: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> {
  const destinationCandidates = candidatesOf(destinations);
  const hotelCandidates = candidatesOf(hotels);
  const experienceCandidates = candidatesOf(experiences, "title");
  const candidatesFor = (role: string): ImageCandidate[] => role === "destination"
    ? destinationCandidates
    : role === "hotel"
      ? hotelCandidates
      : role === "experience"
        ? experienceCandidates
        : [...hotelCandidates, ...destinationCandidates];
  const result: Array<Record<string, unknown>> = [];
  const takenSlots = new Set<string>();
  const usedMedia = new Set<string>();
  const add = (assignment: Record<string, unknown>): void => {
    const role = String(assignment.role);
    const slot = `${role}:${assignment.targetId ?? ""}`;
    if (SINGLE_IMAGE_ROLES.has(role)) {
      if (takenSlots.has(slot)) return;
      takenSlots.add(slot);
    }
    usedMedia.add(String(assignment.mediaId));
    result.push(Object.fromEntries(Object.entries(assignment).filter(([, value]) => value !== undefined)));
  };

  for (const raw of explicit ?? []) {
    const mediaId = str(raw.mediaId);
    const role = str(raw.role);
    if (!mediaId || !role || !IMAGE_ROLES.has(role)) continue;
    const targetId = resolveImageTarget(str(raw.targetId), candidatesFor(role));
    if (TARGETED_IMAGE_ROLES.has(role) && !targetId) continue;
    add({ mediaId, role, targetId, placement: imagePlacement(raw.placement), caption: str(raw.caption), source: imageSource(raw.source) });
  }

  const inferred = state.media
    .map((media, position) => ({ media, position }))
    .filter(({ media }) => !usedMedia.has(media.attachmentId)
      && (media.selectedForPdf || str(media.category)?.toLowerCase() === "cover"))
    .sort((left, right) => {
      const leftCover = str(left.media.category)?.toLowerCase() === "cover";
      const rightCover = str(right.media.category)?.toLowerCase() === "cover";
      if (leftCover && rightCover) return right.position - left.position;
      return (left.media.sortOrder ?? 0) - (right.media.sortOrder ?? 0) || left.position - right.position;
    });
  for (const { media } of inferred) {
    const category = str(media.category)?.toLowerCase() ?? "";
    const label = str(media.label);
    let role = "gallery";
    let targetId: string | undefined;
    if (category === "cover") {
      role = "cover";
    } else if (category === "closing") {
      role = "closing";
    } else if (category === "airline" || category.startsWith("flight")) {
      role = "flights";
    } else if (category === "destination" || category.startsWith("city_")) {
      targetId = category.startsWith("city_")
        ? resolveImageTarget(category.slice("city_".length), destinationCandidates)
        : targetFromLabel(label, destinationCandidates);
      targetId ??= destinationCandidates.length === 1 ? destinationCandidates[0].id : undefined;
      role = targetId ? "destination" : "gallery";
    } else if (category.startsWith("hotel_")) {
      targetId = targetFromLabel(label, hotelCandidates) ?? (hotelCandidates.length === 1 ? hotelCandidates[0].id : undefined);
      role = targetId ? "hotel" : "gallery";
    }
    // Segunda foto do mesmo slot (outra foto do hotel/destino) vai para a galeria do alvo.
    if (SINGLE_IMAGE_ROLES.has(role) && takenSlots.has(`${role}:${targetId ?? ""}`)) {
      if (!targetId) continue;
      role = "gallery";
    }
    add({
      mediaId: media.attachmentId,
      role,
      targetId,
      placement: imagePlacement((media as unknown as Record<string, unknown>).placement),
      caption: label,
      source: imageSource((media.metadata as Record<string, unknown> | undefined)?.credit)
    });
  }
  return result;
}

export function stateToSpec(
  state: TripzProposalState,
  context: TripzStateToSpecContext
): TripzStateToSpecResult {
  void context.tenantId;
  const extras: EditorialStateV2 = (state as unknown as EditorialStateV2) ?? {};
  const narrative = extras.editorial?.narrative ?? {};
  const destinations = mapDestinations(state, extras);
  const destinationIds = destinations.map((destination) => String(destination.id));
  const destinationNames = destinations.map((destination) => String(destination.name));
  const hotels = mapHotels(state, extras, destinationIds);
  const flights = mapFlights(state);
  const itinerary = mapItinerary(state, destinationIds, destinationNames);
  const experiences = mapExperiences(extras, destinationIds);
  const nights = nightsBetween(str(state.startDate), str(state.endDate));
  const candidate = {
    schemaVersion: 2,
    tripTitle: str(state.editorial?.tripTitle) ?? str(state.title),
    origin: str(state.editorial?.origin),
    startDate: str(state.startDate),
    endDate: str(state.endDate),
    departureDate: str(state.startDate),
    returnDate: str(state.endDate),
    nights: num((extras as Record<string, unknown>).nights) ?? nights,
    travellers: mapTravellers(state, extras),
    destinations,
    hotels,
    flights,
    transfers: mapTransfers(state, extras),
    experiences,
    inclusions: mapInclusions(state, extras),
    exclusions: state.editorial?.exclusions ?? mapExclusions(state),
    baggage: Array.isArray(extras.editorial?.baggage)
      ? extras.editorial?.baggage.map((item) => str(item)).filter((item): item is string => Boolean(item))
      : [...new Set(flights.map((flight) => flight.baggage).filter((baggage): baggage is string => Boolean(baggage)))],
    cancellationPolicies: (extras.editorial?.cancellationPolicies ?? []).map((policy) => ({
      label: str(policy.label),
      text: str(policy.text)
    })),
    itinerary,
    commercial: mapCommercial(state, extras),
    consultant: state.editorial?.consultant ?? (context.consultant?.name || context.consultant?.phone || context.consultant?.email
      ? {
        name: context.consultant?.name,
        role: context.consultant?.role,
        phone: context.consultant?.phone,
        email: context.consultant?.email
      }
      : undefined),
    narrative,
    imageAssignments: mapImageAssignments(
      state,
      destinations,
      hotels,
      experiences,
      state.editorial?.imageAssignments as Array<Record<string, unknown>> | undefined
    ),
    pageOverrides: state.editorial?.pageOverrides,
    customSections: state.editorial?.customSections,
    theme: state.editorial?.theme,
    sources: (extras.editorial?.sources ?? []).map((source) => ({
      label: str(source.label),
      url: str(source.url),
      credit: str(source.credit)
    }))
  };
  const parsed = proposalSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      spec: null,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    };
  }
  return { spec: parsed.data, issues: [] };
}

/** Versão combinada do pipeline document/ (spec+brand+render). */
export function tripzDocumentRendererVersion(): string {
  return PROPOSAL_RENDERER_VERSION;
}

export function buildEditorialDefaults(state: TripzProposalState, context: TripzStateToSpecContext): ProposalSpec {
  const result = stateToSpec(state, context);
  if (!result.spec) {
    throw new TripzAiError(
      500,
      "TRIPZ_SPEC_BUILD_FAILED",
      result.issues.length > 0
        ? `Estado editorial inválido: ${result.issues[0]}`
        : "Estado editorial inválido"
    );
  }
  return result.spec;
}

// TODO(wave-c): remover castTripzProposalState quando domain.ts exportar TripzProposalStateV2.


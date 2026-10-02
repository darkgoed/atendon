import type {
  Commercial,
  Destination,
  Experience,
  FlightSegment,
  Hotel,
  ImagePlacement,
  ItineraryDay,
  NarrativeSection,
  CustomSection,
  ProposalSpec,
  SectionBlock,
  SourceReference
} from "./spec.js";
import type { CustomSectionPageData, PageData, ResolvedPhoto, ResolvedSectionBlock } from "./page-data.js";

/** VERSÃO do contrato de render. */
export const PROPOSAL_RENDERER_VERSION = "tripz-editorial-v3";

export type ProposalPageKind = PageData["kind"];

export interface ProposalPage {
  /** Id estável: cover | concept | overview | destination:<id> | hotel:<id> | experiences | services | flights | closing. */
  id: string;
  kind: ProposalPageKind;
  hidden: boolean;
  data: PageData;
}

/* ------------------------------------------------------------------ utils */

const MONTHS_SHORT = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
const MONTHS_FULL = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
];

function parseIso(iso: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "2026-05-20" → "20 MAI" */
export function formatShortDate(iso: string): string {
  const date = parseIso(iso);
  if (!date) return "";
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS_SHORT[date.getUTCMonth()]}`;
}

/** "2026-05-20" → "20 de maio" */
export function formatLongDate(iso: string): string {
  const date = parseIso(iso);
  if (!date) return "";
  return `${date.getUTCDate()} de ${MONTHS_FULL[date.getUTCMonth()]}`;
}

function plural(count: number, singular: string, pluralWord: string): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

/** Rótulos genéricos ("Adulto 2") não são nomes: não vão para capa/rodapé. */
const PLACEHOLDER_TRAVELLER = /^(?:adulto|criança|crianca|bebê|bebe|viajante)(?:\s+\d+)?$/i;

export function namesLine(spec: ProposalSpec): string {
  return spec.travellers.map((traveller) => traveller.name.trim())
    .filter((name) => name && !PLACEHOLDER_TRAVELLER.test(name))
    .join(" & ");
}

function totalNights(spec: ProposalSpec): number {
  if (typeof spec.nights === "number") return spec.nights;
  const start = spec.startDate ? parseIso(spec.startDate) : undefined;
  const end = spec.endDate ? parseIso(spec.endDate) : undefined;
  if (start && end) return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return spec.destinations.reduce((acc, dest) => acc + (dest.nights ?? 0), 0);
}

function actLabelFor(spec: ProposalSpec, dest: Destination): string {
  if (dest.actLabel) return `${dest.actLabel} · ${dest.name.toUpperCase()}`;
  const pos = spec.destinations.findIndex((item) => item.id === dest.id);
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"][pos] ?? String(pos + 1);
  return `ATO ${roman} · ${dest.name.toUpperCase()}`;
}

/** Remove o código IATA: "GRU — SAO PAULO" → "SAO PAULO". */
function cityOf(value: string | undefined): string {
  if (!value) return "";
  const parts = value.split("—");
  const city = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
  return city || value.trim();
}

function moneyValue(total: number, currency: string): string {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: 2 }).format(total);
  } catch {
    return `${currency} ${total.toFixed(2).replace(".", ",")}`;
  }
}

const EXPERIENCES_NOTE = {
  title: "IMPORTANTE",
  text: "As experiências são sugestões para a etapa de assessoria e não estão incluídas, salvo indicação expressa."
};

/* ------------------------------------------------------------------ fotos */

type Assignment = ProposalSpec["imageAssignments"][number];

interface PhotoIndex {
  byKey: Map<string, Assignment[]>;
}

function buildPhotoIndex(spec: ProposalSpec): PhotoIndex {
  const byKey = new Map<string, Assignment[]>();
  for (const assignment of spec.imageAssignments) {
    const key = assignment.targetId ? `${assignment.role}:${assignment.targetId}` : assignment.role;
    const bucket = byKey.get(key) ?? [];
    bucket.push(assignment);
    byKey.set(key, bucket);
  }
  return { byKey };
}

function resolvePhoto(index: PhotoIndex, role: string, targetId?: string, pick = 0): ResolvedPhoto | undefined {
  const bucket = index.byKey.get(targetId ? `${role}:${targetId}` : role);
  if (!bucket || bucket.length === 0) return undefined;
  const assignment = bucket[Math.min(pick, bucket.length - 1)];
  const photo: ResolvedPhoto = { mediaId: assignment.mediaId };
  if (assignment.placement) photo.placement = assignment.placement as ImagePlacement;
  if (assignment.caption) photo.caption = assignment.caption;
  return photo;
}

/** Foto de base do fechamento: só quando houver um mediaId DIFERENTE do topo. */
function resolvePhotoIfDistinct(index: PhotoIndex, role: string): ResolvedPhoto | undefined {
  const top = resolvePhoto(index, role);
  const bottom = resolvePhoto(index, role, undefined, 1);
  if (top && bottom && top.mediaId === bottom.mediaId) return undefined;
  return bottom;
}

function hotelPhotoCount(index: PhotoIndex, hotelId: string): number {
  return (index.byKey.get(`hotel:${hotelId}`)?.length ?? 0) + (index.byKey.get(`gallery:${hotelId}`)?.length ?? 0);
}

/* ------------------------------------------------------------------ copy */

function copyFor(spec: ProposalSpec, destinationId: string): NarrativeSection | undefined {
  return spec.narrative.destinationCopy[destinationId];
}

function subtitleFor(dest: Destination): string | undefined {
  const range = dest.dateRangeLabel ?? (typeof dest.nights === "number" ? plural(dest.nights, "noite", "noites") : undefined);
  const parts: string[] = [];
  if (range) parts.push(range);
  if (typeof dest.nights === "number" && range && !/noite/i.test(range)) parts.push(plural(dest.nights, "noite", "noites"));
  return parts.length ? parts.join(" · ") : undefined;
}

interface TimelineData {
  label: string;
  rows: Array<{ dateLabel: string; title?: string; text?: string; suggested?: boolean }>;
}

function timelineFor(days: ItineraryDay[]): TimelineData {
  const rows = days
    .slice()
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((day) => ({
      dateLabel: day.date ? formatShortDate(day.date) : `DIA ${day.dayNumber}`,
      title: day.title,
      text: day.morning ?? day.afternoon ?? day.evening,
      suggested: day.suggested
    }));
  const allSuggested = rows.length > 0 && rows.every((row) => row.suggested);
  return { label: allSuggested ? "RITMO SUGERIDO" : "CRONOGRAMA", rows };
}

/* ------------------------------------------------------------------ voos */

/** Cidade legível: "GRU - SAO PAULO" → "Sao Paulo"; mantém acentos quando vierem. */
function displayCity(value: string | undefined): string {
  const raw = cityOf(value).split(/\s+-\s+/).pop()?.trim() ?? "";
  if (!raw || raw !== raw.toUpperCase() || /^[A-Z]{3}$/.test(raw)) return raw;
  return raw.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_match, sep: string, letter: string) => `${sep}${letter.toUpperCase()}`)
    .replace(/\b(De|Do|Da|Dos|Das|E)\b/g, (word) => word.toLowerCase());
}

/** Ref. Itália: "São Paulo → Roma · Nápoles → São Paulo · conexões em Madri". */
function flightRouteSubtitle(flights: FlightSegment[], spec: ProposalSpec): string | undefined {
  if (flights.length === 0) return undefined;
  const outbound = flights.filter((flight) => flight.direction === "outbound");
  const inbound = flights.filter((flight) => flight.direction === "return");
  if (outbound.length === 0 || inbound.length === 0) {
    // Um só sentido (ex.: só retorno): a cadeia inteira com as escalas, ref. Porto.
    const chain = [displayCity(flights[0].origin), ...flights.map((flight) => displayCity(flight.destination))]
      .filter((city, position, all) => city && city !== all[position - 1]);
    if (chain.length < 2) return undefined;
    const dates = [...new Set(flights.map((flight) => flight.date).filter((date): date is string => Boolean(date)))];
    return dates.length === 1 ? `${chain.join(" → ")} · ${formatLongDate(dates[0])} de ${dates[0].slice(0, 4)}` : chain.join(" → ");
  }
  const going = outbound;
  const back = inbound;
  const start = spec.origin ?? displayCity(going[0]?.origin);
  const arrive = displayCity(going[going.length - 1]?.destination);
  if (!start || !arrive) return undefined;
  const legs = [start, arrive];
  let route = `${start} → ${arrive}`;
  if (back.length > 0) {
    const depart = displayCity(back[0].origin);
    const end = displayCity(back[back.length - 1].destination);
    if (depart && depart !== arrive) route += ` · ${depart}`;
    if (end) route += ` → ${end}`;
    legs.push(depart, end);
  }
  const connections = new Set<string>();
  for (const group of [going, back]) {
    for (const flight of group.slice(0, -1)) {
      const city = displayCity(flight.destination);
      if (city && !legs.includes(city)) connections.add(city);
    }
  }
  if (connections.size > 0) route += ` · ${connections.size === 1 ? "conexão" : "conexões"} em ${[...connections].join(", ")}`;
  return route;
}

function flightsHeadline(flights: FlightSegment[]): string {
  const airlines = [...new Set(flights.map((flight) => flight.airline?.trim()).filter(Boolean))];
  return airlines.length > 0 ? `Voos previstos com ${airlines.join(" · ")}` : "Voos previstos";
}

/** Título da viagem; sem título, os destinos ("Roma · Sorrento"). */
export function tripTitleOf(spec: ProposalSpec): string {
  return spec.tripTitle?.trim() || spec.destinations.map((destination) => destination.name).join(" · ");
}

function flightsEyebrow(flights: FlightSegment[]): string {
  if (flights.length > 0 && flights.every((flight) => flight.direction === "return" || flight.direction === "other")) {
    return "RETORNO AO BRASIL";
  }
  return "LOGÍSTICA AÉREA";
}

function flightRow(flight: FlightSegment): string[] {
  const kind = flight.direction === "outbound"
    ? "IDA"
    : flight.direction === "return"
      ? "VOLTA"
      : flight.direction === "internal"
        ? "TRECHO"
        : "VOO";
  return [
    kind,
    flight.flightNumber ?? "",
    flight.date ? formatShortDate(flight.date) : "",
    `${displayCity(flight.origin)} → ${displayCity(flight.destination)}`,
    flight.duration ?? "",
    flight.cabin ?? ""
  ];
}

type FlightsChips = Array<{ text: string; variant: "primary" | "plain" | "accent" }>;

function flightChips(flights: FlightSegment[]): FlightsChips {
  const chips: FlightsChips = [];
  const stopover = flights.find((flight) => flight.stopover)?.stopover;
  if (stopover) chips.push({ text: stopover, variant: "primary" });
  const cabin = flights.find((flight) => flight.cabin)?.cabin;
  if (cabin) chips.push({ text: /econ/i.test(cabin) ? "Classe Econômica" : cabin, variant: "plain" });
  const baggage = flights.find((flight) => flight.baggage)?.baggage;
  if (baggage) chips.push({ text: baggage, variant: "accent" });
  return chips;
}

/* ----------------------------------------------------------------- fontes */

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function creditsHtml(sources: SourceReference[]): string | undefined {
  if (sources.length === 0) return undefined;
  const groups = new Map<string, { credit: string; url?: string; labels: string[] }>();
  for (const source of sources) {
    const credit = source.credit ?? source.label;
    const entry = groups.get(credit) ?? { credit, url: source.url, labels: [] };
    if (!entry.url && source.url) entry.url = source.url;
    if (!entry.labels.includes(source.label)) entry.labels.push(source.label);
    groups.set(credit, entry);
  }
  const parts = [...groups.values()].map((entry) => {
    // URL vem do estado da proposta (preenchido pela IA a partir de PDFs e do
    // usuário): escapada e só http(s) — sem isso virava HTML injetado no PDF.
    const href = safeHttpUrl(entry.url);
    const credit = href ? `<a href="${escapeHtml(href)}">${escapeHtml(entry.credit)}</a>` : escapeHtml(entry.credit);
    const label = entry.labels.filter(Boolean).join(", ");
    return label && label !== entry.credit ? `${credit} — ${escapeHtml(label)}` : credit;
  });
  return `FONTES: ${parts.join(" · ")}`;
}

/* ------------------------------------------------------ serviços / hotel */

function hotelSummaryRows(spec: ProposalSpec): Array<{ key: string; value: string }> {
  return spec.hotels.map((hotel) => {
    const dest = spec.destinations.find((item) => item.id === hotel.destinationId);
    return { key: dest ? dest.name : hotel.name, value: plural(hotel.nights ?? dest?.nights ?? 0, "noite", "noites") };
  });
}

function hotelPanelFor(hotel: Hotel, index: PhotoIndex): (PageData & { kind: "destination" })["hotel"] {
  if (hotel.pending) {
    return {
      id: hotel.id,
      name: "Hotel a confirmar",
      pending: true,
      eyebrow: "HOSPEDAGEM",
      meta: hotel.category ? `${hotel.category}${hotel.mealPlan ? ` · ${hotel.mealPlan}` : ""}` : undefined,
      text: hotel.description ?? hotel.highlightNote
    };
  }
  const metaParts = [
    hotel.checkIn && hotel.checkOut ? `${formatShortDate(hotel.checkIn)} — ${formatShortDate(hotel.checkOut)}` : undefined,
    hotel.roomCategory,
    hotel.mealPlan
  ].filter(Boolean);
  return {
    id: hotel.id,
    name: hotel.name,
    pending: false,
    eyebrow: hotel.category ? `HOSPEDAGEM · ${hotel.category.toUpperCase()}` : "HOSPEDAGEM",
    meta: metaParts.length ? metaParts.join(" · ") : undefined,
    text: hotel.description ?? hotel.highlightNote,
    photo: resolvePhoto(index, "hotel", hotel.id)
  };
}

function experienceCards(experiences: Experience[]): Array<{ id: string; title: string; text?: string }> {
  return experiences.map((exp) => ({ id: exp.id, title: exp.title, text: exp.description }));
}

function buildClosingData(spec: ProposalSpec, index: PhotoIndex): PageData & { kind: "closing" } {
  const closing = spec.narrative.closing;
  const commercial: Commercial = spec.commercial;
  const names = namesLine(spec);
  const steps = [
    { number: "01", title: "Aprovação e ajustes", text: "Revisão final com vocês." },
    { number: "02", title: "Processo de reserva", text: "Reservas e experiências confirmadas." },
    { number: "03", title: "Confirmação e emissão", text: "Documentos e vouchers finais." }
  ];
  const investment = typeof commercial.total === "number"
    ? {
      label: "INVESTIMENTO TOTAL",
      value: commercial.currency ? moneyValue(commercial.total, commercial.currency) : commercial.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
      sub: spec.travellers.length === 2 ? "VALOR TOTAL PARA O CASAL" : "VALOR TOTAL DA VIAGEM",
      notes: (commercial.priceNotes ?? []).slice()
    }
    : undefined;
  const paymentRows = (commercial.paymentEntries ?? []).map((entry) => ({ key: entry.label, value: entry.value }));
  const payment = paymentRows.length || commercial.paymentSummary
    ? { title: "FORMA DE PAGAMENTO", rows: paymentRows, summary: commercial.paymentSummary }
    : undefined;
  const differentials = (commercial.differentials ?? []).length
    ? { label: "POR QUE COMPRAR CONOSCO", items: commercial.differentials.slice() }
    : undefined;
  return {
    kind: "closing",
    eyebrow: closing?.eyebrow ?? "MAIS DO QUE RESERVAS",
    headline: closing?.headline ?? "Mais do que reservas",
    body: closing?.body?.slice() ?? [],
    photo: resolvePhoto(index, "closing"),
    bottomPhoto: resolvePhotoIfDistinct(index, "closing"),
    investment,
    payment,
    differentials,
    steps,
    cta: closing?.quote
      ? { quote: closing.quote, target: names ? `Preparada especialmente para ${names}` : undefined }
      : undefined,
    fineprint: "Imagens ilustrativas dos destinos e das hospedagens. Serviços e disponibilidade sujeitos à confirmação.",
    creditsHtml: creditsHtml(spec.sources)
  };
}

/** Derivação determinística de páginas (DESIGN.md §5). */
export function buildProposalPages(spec: ProposalSpec): ProposalPage[] {
  const index = buildPhotoIndex(spec);
  const nights = totalNights(spec);
  const names = namesLine(spec);
  const destinations = spec.destinations;
  const pages: ProposalPage[] = [];
  const push = (id: string, kind: ProposalPageKind, data: PageData): void => {
    pages.push({ id, kind, hidden: false, data });
  };

  /* cover — sempre */
  const departure = spec.departureDate ?? spec.startDate;
  const returnDate = spec.returnDate ?? spec.endDate;
  const coverNote = spec.origin && departure
    ? `· embarque em ${spec.origin} em ${formatLongDate(departure)}`
    : undefined;
  const coverYear = returnDate && departure && returnDate.slice(0, 4) === departure.slice(0, 4)
    ? departure.slice(0, 4)
    : returnDate?.slice(0, 4);
  push("cover", "cover", {
    kind: "cover",
    coverStyle: spec.theme?.coverStyle ?? "classic",
    tripTitle: tripTitleOf(spec),
    names,
    origin: spec.origin,
    photo: resolvePhoto(index, "cover"),
    stats: [
      { value: String(nights), label: nights === 1 ? "NOITE" : "NOITES" },
      { value: String(spec.travellers.length), label: spec.travellers.length === 1 ? "VIAJANTE" : "VIAJANTES" },
      { value: String(destinations.length), label: destinations.length === 1 ? "DESTINO" : "DESTINOS" }
    ],
    dateLine: {
      strong: spec.startDate && spec.endDate
        ? `${formatLongDate(spec.startDate)} a ${formatLongDate(spec.endDate)}${coverYear ? ` de ${coverYear}` : ""}`
        : departure && returnDate
          ? `${formatLongDate(departure)} a ${formatLongDate(returnDate)}${coverYear ? ` de ${coverYear}` : ""}`
          : "",
      note: coverNote
    }
  });

  /* concept — só com conteúdo (texto, citação ou foto); título sozinho vira página vazia */
  const concept = spec.narrative.concept;
  const conceptPhoto = resolvePhoto(index, "concept");
  if ((concept?.body?.length ?? 0) > 0 || concept?.quote || (concept?.moments?.length ?? 0) > 0 || conceptPhoto) {
    push("concept", "concept", {
      kind: "concept",
      eyebrow: concept?.eyebrow ?? "A PROPOSTA",
      headline: concept?.headline ?? "Uma viagem desenhada para vocês",
      quote: concept?.quote,
      body: concept?.body?.slice() ?? [],
      photo: conceptPhoto,
      moments: concept?.moments && concept.moments.length > 0
        ? { label: concept.momentsLabel ?? "O TOM DESTA EXPERIÊNCIA", items: concept.moments.slice() }
        : undefined,
      axes: concept?.axes?.slice() ?? []
    });
  }

  /* overview — se destinations.length >= 2 */
  if (destinations.length >= 2) {
    const transportParts: string[] = [];
    if (spec.flights.length > 0) transportParts.push("aéreo");
    if (spec.transfers.length > 0) transportParts.push("traslados privativos");
    push("overview", "overview", {
      kind: "overview",
      eyebrow: "VISÃO GERAL",
      headline: spec.narrative.overview?.headline ?? "O percurso da viagem",
      subtitle: spec.narrative.overview?.body?.[0]
        ?? (nights ? `${plural(nights, "noite", "noites")} entre ${joinNames([...new Set(destinations.map((dest) => dest.name))])}` : undefined),
      destinations: destinations.map((dest) => ({
        id: dest.id,
        name: dest.name,
        rangeLabel: rangeLabelFor(dest),
        text: dest.summary ?? copyFor(spec, dest.id)?.headline,
        photo: resolvePhoto(index, "destination", dest.id)
      })),
      route: {
        cities: destinations.map((dest) => dest.name.toUpperCase()),
        transportNote: transportParts.length ? transportParts.join(" · ") : undefined
      }
    });
  }

  /* destination:<id> — um ato por destino com conteúdo renderizável */
  let destinationIndex = 0;
  for (const dest of destinations) {
    const copy = copyFor(spec, dest.id);
    const days = spec.itinerary.filter((day) => day.destinationId === dest.id);
    const hotel = spec.hotels.find((item) => item.destinationId === dest.id)
      ?? (destinations.length === 1 ? spec.hotels.find((item) => !item.destinationId) : undefined);
    const destExperiences = spec.experiences.filter((exp) => exp.destinationId === dest.id);
    const photo = resolvePhoto(index, "destination", dest.id);
    const hasContent = Boolean(photo || copy || days.length > 0 || hotel || destExperiences.length > 0);
    if (!hasContent) continue;
    const timeline = days.length > 0 ? timelineFor(days) : undefined;
    const body = copy?.body?.slice() ?? (dest.summary ? [dest.summary] : undefined);
    const sandCard = copy?.moments && copy.moments.length > 0
      ? { label: copy.momentsLabel ?? "MOMENTOS-CHAVE", items: copy.moments.slice() }
      : undefined;
    const hotelPanel = hotel && hotelPageId(spec, index) !== hotel.id ? hotelPanelFor(hotel, index) : undefined;
    push(`destination:${dest.id}`, "destination", {
      kind: "destination",
      layout: spec.pageOverrides.find((override) => override.page === `destination:${dest.id}`)?.layout
        ?? (destinationIndex % 2 === 1 ? "side" : "hero"),
      destinationId: dest.id,
      eyebrow: actLabelFor(spec, dest),
      headline: copy?.headline ?? dest.name,
      subtitle: subtitleFor(dest),
      photo,
      bodyLabel: body && body.length > 0 ? "A EXPERIÊNCIA" : undefined,
      body,
      quote: copy?.quote,
      sandCard,
      timeline,
      hotel: hotelPanel,
      experiences: destExperiences.length > 0
        ? { noteTitle: EXPERIENCES_NOTE.title, noteText: EXPERIENCES_NOTE.text, cards: experienceCards(destExperiences) }
        : undefined
    });
    destinationIndex += 1;
  }

  /* hotel:<id> — página dedicada (1 hotel com ≥2 fotos OU descrição longa) */
  const dedicatedHotelId = hotelPageId(spec, index);
  const dedicatedHotel = dedicatedHotelId ? spec.hotels.find((item) => item.id === dedicatedHotelId) : undefined;
  if (dedicatedHotel) {
    const dest = destinations.find((item) => item.id === dedicatedHotel.destinationId);
    const metaParts = [
      dest ? dest.name : undefined,
      dedicatedHotel.category,
      dedicatedHotel.checkIn && dedicatedHotel.checkOut
        ? `${formatShortDate(dedicatedHotel.checkIn)} — ${formatShortDate(dedicatedHotel.checkOut)}`
        : undefined
    ].filter(Boolean);
    const cancellation = spec.cancellationPolicies[0];
    const gallery = [
      ...(index.byKey.get(`gallery:${dedicatedHotel.id}`) ?? []).map((assignment) => assignment),
      ...(index.byKey.get(`hotel:${dedicatedHotel.id}`) ?? []).slice(1).map((assignment) => assignment)
    ].map((assignment) => {
      const photo: ResolvedPhoto = { mediaId: assignment.mediaId };
      if (assignment.placement) photo.placement = assignment.placement as ImagePlacement;
      if (assignment.caption) photo.caption = assignment.caption;
      return photo;
    });
    const officialCredit = spec.sources.find((source) => /oficial|hotels?/i.test(source.credit ?? ""));
    push(`hotel:${dedicatedHotel.id}`, "hotel", {
      kind: "hotel",
      hotelId: dedicatedHotel.id,
      eyebrow: "HOSPEDAGEM",
      name: dedicatedHotel.name,
      subtitle: metaParts.length ? metaParts.join(" · ") : undefined,
      photo: resolvePhoto(index, "hotel", dedicatedHotel.id),
      description: dedicatedHotel.description,
      roomCard: dedicatedHotel.roomCategory
        ? {
          label: "ACOMODAÇÃO CONTEMPLADA",
          title: dedicatedHotel.roomCategory,
          text: [
            dedicatedHotel.mealPlan,
            dedicatedHotel.nights ? plural(dedicatedHotel.nights, "noite", "noites") : undefined
          ].filter(Boolean).join(" · ") || undefined
        }
        : undefined,
      cancellationCard: cancellation || dedicatedHotel.highlightNote
        ? {
          label: "CANCELAMENTO",
          title: cancellation?.label ?? "Cancelamento",
          text: cancellation?.text ?? dedicatedHotel.highlightNote
        }
        : undefined,
      gallery,
      creditNote: officialCredit ? `As fotografias desta página são oficiais: ${officialCredit.credit}.` : undefined
    });
  }

  /* experiences — só quando há experiências sem destino E nenhum destino no spec */
  const orphanExperiences = spec.experiences.filter((exp) => !exp.destinationId);
  if (orphanExperiences.length > 0 && destinations.length === 0) {
    push("experiences", "experiences", {
      kind: "experiences",
      eyebrow: "EXPERIÊNCIAS",
      headline: "Sugestões para a viagem",
      note: EXPERIENCES_NOTE,
      cards: experienceCards(orphanExperiences)
    });
  }

  /* services — quando há inclusões, exclusões ou hospedagens */
  if (spec.inclusions.length > 0 || spec.exclusions.length > 0 || spec.hotels.length > 0) {
    const hotels = spec.hotels;
    const hotelNights = hotels.reduce((acc, hotel) => acc + (hotel.nights ?? 0), 0);
    const summaryRows = hotels.length >= 2
      ? hotelSummaryRows(spec)
      : [
        { key: "Viajantes", value: names || `${plural(spec.travellers.length, "viajante", "viajantes")}` },
        { key: "Hospedagem", value: hotels[0] ? hotels[0].name : "—" },
        { key: "Retorno", value: (spec.returnDate ?? spec.endDate) ? formatShortDate(spec.returnDate ?? spec.endDate as string) : "—" }
      ];
    const rightSection = (section: string): boolean => /hosped/i.test(section);
    const leftGroups = spec.inclusions.filter((group) => !rightSection(group.section));
    const rightGroups = spec.inclusions.filter((group) => rightSection(group.section));
    push("services", "services", {
      kind: "services",
      eyebrow: "SERVIÇOS CONTEMPLADOS",
      headline: "Tudo o que já está incluído",
      subtitle: "Uma base cuidadosamente organizada para viajar com tranquilidade",
      leftGroups: leftGroups.map((group) => ({
        section: group.section,
        items: group.items.map((item) => ({ title: item.title, detail: item.detail }))
      })),
      rightGroups: rightGroups.map((group) => ({
        section: group.section,
        items: group.items.map((item) => ({ title: item.title, detail: item.detail }))
      })),
      exclusions: spec.exclusions.slice(),
      summary: hotels.length > 0
        ? {
          title: hotels.length >= 2 ? "RESUMO DA HOSPEDAGEM" : "RESUMO",
          rows: summaryRows,
          total: hotels.length >= 2 ? { key: "TOTAL", value: plural(hotelNights, "noite", "noites") } : undefined
        }
        : undefined,
      warnings: []
    });
  }

  /* flights — quando há voos */
  if (spec.flights.length > 0) {
    push("flights", "flights", {
      kind: "flights",
      eyebrow: flightsEyebrow(spec.flights),
      headline: flightsHeadline(spec.flights),
      subtitle: flightRouteSubtitle(spec.flights, spec),
      notice: undefined,
      capture: resolvePhoto(index, "flights"),
      columns: ["TIPO", "NÚMERO", "DATA", "DE → PARA", "DURAÇÃO", "CABINE"],
      rows: spec.flights.map(flightRow),
      chips: flightChips(spec.flights),
      footnote: "Horários locais. Datas, horários e equipamentos serão reconfirmados no momento da emissão."
    });
  }

  /* closing — sempre */
  push("closing", "closing", buildClosingData(spec, index));

  /* seções dinâmicas criadas pela IA — entram onde pediu (after) ou antes de serviços/voos/fechamento */
  const sectionIds = new Set(spec.customSections.map((section) => section.id));
  const lastInsertedFor = new Map<string, string>();
  for (const section of spec.customSections) {
    const anchor = section.after && !section.after.includes(":") && sectionIds.has(section.after) && section.after !== section.id
      ? `section:${section.after}`
      : section.after;
    const sectionPages = buildCustomSectionPages(section);
    // Várias seções no mesmo ponto entram na ordem em que foram declaradas.
    const position = sectionInsertPosition(pages, lastInsertedFor.get(anchor ?? "") ?? anchor);
    pages.splice(position, 0, ...sectionPages.map((data, part) => ({
      id: part === 0 ? `section:${section.id}` : `section:${section.id}:${part + 1}`,
      kind: "custom" as const,
      hidden: false,
      data
    })));
    lastInsertedFor.set(anchor ?? "", `section:${section.id}`);
  }
  packShortSections(pages);

  /* pageOverrides: hidden apenas em páginas opcionais; order desloca a ordem */
  const overrides = new Map(spec.pageOverrides.map((override) => [override.page, override]));
  const OPTIONAL = new Set(["concept", "overview", "experiences", "services", "flights", "hotel", "custom"]);
  for (const page of pages) {
    const override = overrides.get(page.id) ?? (page.kind === "custom" ? overrides.get(page.id.split(":").slice(0, 2).join(":")) : undefined);
    if (!override) continue;
    if (override.hidden && (OPTIONAL.has(page.kind) || page.id.startsWith("destination:"))) page.hidden = true;
  }
  const baseOrder = new Map(pages.map((page, position) => [page.id, position]));
  const orderOf = (page: ProposalPage): number => overrides.get(page.id)?.order
    ?? (page.kind === "custom" ? overrides.get(page.id.split(":").slice(0, 2).join(":"))?.order : undefined)
    ?? 0;
  const sorted = pages.slice().sort((a, b) => {
    const orderA = orderOf(a);
    const orderB = orderOf(b);
    if (orderA !== orderB) return orderA - orderB;
    return (baseOrder.get(a.id) ?? 0) - (baseOrder.get(b.id) ?? 0);
  });
  return sorted;
}

/* --------------------------------------------------------- helpers atrasados */

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : names[0] ?? "";
}

function rangeLabelFor(dest: Destination): string {
  if (dest.dateRangeLabel) return dest.dateRangeLabel;
  if (typeof dest.nights === "number") return `${dest.name.toUpperCase()} · ${plural(dest.nights, "NOITE", "NOITES")}`;
  return dest.name.toUpperCase();
}

/** Id do hotel que ganha página dedicada (ou undefined). */
function hotelPageId(spec: ProposalSpec, index: PhotoIndex): string | undefined {
  if (spec.hotels.length !== 1) return undefined;
  const hotel = spec.hotels[0];
  if (hotel.pending) return undefined;
  const longDescription = (hotel.description?.length ?? 0) > 240;
  if (hotelPhotoCount(index, hotel.id) >= 2 || longDescription) return hotel.id;
  return undefined;
}


/* ------------------------------------------------- seções dinâmicas (IA) */

/** Altura útil (mm) da área de conteúdo de uma página A4 com cabeçalho e rodapé. */
const SECTION_PAGE_HEIGHT = 238;
const SECTION_HEADER_HEIGHT = 30;
const CONTINUATION_HEADER_HEIGHT = 22;
const BLOCK_GAP = 5;

function linesOf(text: string, charsPerLine: number): number {
  return Math.max(1, Math.ceil(text.length / Math.max(12, charsPerLine)));
}

/** Estimativa conservadora da altura de um bloco (mm) para paginar sem cortar. */
export function estimateBlockHeight(block: SectionBlock, charsPerLine: number): number {
  switch (block.type) {
    case "paragraph": return linesOf(block.text, charsPerLine) * 4.9 + 2;
    case "bullets":
      return (block.title ? 7 : 0) + block.items.reduce((acc, item) => acc + linesOf(item, charsPerLine - 8) * 4.5 + 1.8, 0) + 2;
    case "cards": {
      const columns = cardColumns(block.items.length, block.columns, charsPerLine);
      const cardChars = charsPerLine / columns - 6;
      let total = 0;
      for (let start = 0; start < block.items.length; start += columns) {
        const row = block.items.slice(start, start + columns);
        const tallest = Math.max(...row.map((item) => (item.label ? 5 : 0) + linesOf(item.title, cardChars * 0.8) * 6 + (item.text ? linesOf(item.text, cardChars) * 4.1 : 0)));
        total += tallest + 11;
      }
      return total;
    }
    case "table": {
      const cellChars = charsPerLine / block.columns.length - 3;
      const rows = block.rows.reduce((acc, row) => acc + Math.max(...row.map((cell) => linesOf(cell || " ", cellChars))) * 4 + 3.6, 0);
      return (block.title ? 7 : 0) + 9 + rows;
    }
    case "highlight": return 11 + (block.label ? 4.5 : 0) + linesOf(block.text, charsPerLine - 12) * 4.7;
    case "quote": return 6 + linesOf(block.text, charsPerLine * 0.62) * 7;
    case "timeline": return block.items.reduce((acc, item) => acc + 9 + (item.text ? linesOf(item.text, charsPerLine - 26) * 4.2 : 0), 0) + 2;
    case "stats": return 24;
    case "image": return charsPerLine < 80 ? 52 : 72;
    default: return 20;
  }
}

export function cardColumns(count: number, requested: 2 | 3 | undefined, charsPerLine: number): number {
  if (charsPerLine < 80) return 1;
  if (requested) return requested;
  return count % 3 === 0 || count > 4 ? 3 : 2;
}

function resolveBlock(block: SectionBlock): ResolvedSectionBlock {
  if (block.type === "image") return { type: "image", photo: { mediaId: block.mediaId }, caption: block.caption };
  return block;
}

/** Uma seção vira 1+ páginas: blocos são distribuídos pela altura estimada. */
export function buildCustomSectionPages(section: CustomSection): CustomSectionPageData[] {
  const firstLayout = section.mediaId ? section.layout : section.layout === "band" ? "band" : "standard";
  const fullChars = 96;
  const pages: CustomSectionPageData[] = [];
  let current: CustomSectionPageData | undefined;
  let used = 0;
  let capacity = 0;
  let charsPerLine = fullChars;
  const open = (continuation: boolean): void => {
    const layout = continuation ? (firstLayout === "band" ? "band" : "standard") : firstLayout;
    current = {
      kind: "custom",
      sectionId: section.id,
      layout,
      eyebrow: section.eyebrow,
      title: section.title,
      intro: continuation ? undefined : section.intro,
      photo: !continuation && section.mediaId && layout !== "standard" && layout !== "band" ? { mediaId: section.mediaId } : undefined,
      continuation,
      blocks: []
    };
    if (!continuation && section.mediaId && layout === "band") current.photo = { mediaId: section.mediaId };
    pages.push(current);
    charsPerLine = layout === "split" && current.photo ? 54 : fullChars;
    capacity = SECTION_PAGE_HEIGHT - (continuation ? CONTINUATION_HEADER_HEIGHT : SECTION_HEADER_HEIGHT)
      - (current.intro ? linesOf(current.intro, fullChars) * 5 + 4 : 0)
      - (layout === "hero" && current.photo ? 94 : 0)
      - (layout === "band" && current.photo ? 70 : 0);
    used = 0;
  };
  open(false);
  for (const block of section.blocks) {
    const height = estimateBlockHeight(block, charsPerLine) + BLOCK_GAP;
    if (current && current.blocks.length > 0 && used + height > capacity) open(true);
    current!.blocks.push(resolveBlock(block));
    used += height;
  }
  for (const page of pages) page.estimatedHeight = page === pages[pages.length - 1] ? used + headerHeight(page) : SECTION_PAGE_HEIGHT;
  return pages;
}

function headerHeight(page: CustomSectionPageData): number {
  return (page.continuation ? CONTINUATION_HEADER_HEIGHT : SECTION_HEADER_HEIGHT)
    + (page.intro ? linesOf(page.intro, 96) * 5 + 4 : 0);
}

/**
 * Seções curtas e sem foto seguidas (ex.: dicas + comparativo) dividem a mesma
 * página em vez de deixar meia folha em branco cada uma.
 */
function packShortSections(pages: ProposalPage[]): void {
  for (let index = 0; index < pages.length - 1; index += 1) {
    const page = pages[index];
    const next = pages[index + 1];
    if (page.kind !== "custom" || next.kind !== "custom") continue;
    const a = page.data as CustomSectionPageData;
    const b = next.data as CustomSectionPageData;
    const packable = (data: CustomSectionPageData) => data.layout === "standard" && !data.photo && !data.continuation;
    if (!packable(a) || !packable(b)) continue;
    if (pages[index + 2]?.id.startsWith(`${next.id}:`)) continue;
    const combined = (a.estimatedHeight ?? SECTION_PAGE_HEIGHT) + (b.estimatedHeight ?? SECTION_PAGE_HEIGHT) + 10;
    if (combined > SECTION_PAGE_HEIGHT) continue;
    a.stacked = [...(a.stacked ?? []), { sectionId: b.sectionId, eyebrow: b.eyebrow, title: b.title, intro: b.intro, blocks: b.blocks }, ...(b.stacked ?? [])];
    a.estimatedHeight = combined;
    pages.splice(index + 1, 1);
    index -= 1;
  }
}

function sectionInsertPosition(pages: ProposalPage[], after: string | undefined): number {
  if (after) {
    const exact = pages.map((page) => page.id).lastIndexOf(after);
    const byPrefix = exact >= 0 ? exact : pages.map((page) => page.id).reduce((found, id, position) =>
      id === after || id.startsWith(`${after}:`) ? position : found, -1);
    const byKind = byPrefix >= 0 ? byPrefix : pages.map((page) => page.kind as string).lastIndexOf(after);
    if (byKind >= 0) {
      // Depois da página e das continuações dela.
      let position = byKind + 1;
      while (position < pages.length && pages[position].id.startsWith(`${pages[byKind].id}:`)) position += 1;
      return Math.min(position, pages.length - 1 >= 0 && pages[pages.length - 1].kind === "closing" ? pages.length - 1 : pages.length);
    }
  }
  for (const kind of ["services", "flights", "closing"]) {
    const position = pages.findIndex((page) => page.kind === kind);
    if (position >= 0) return position;
  }
  return pages.length;
}

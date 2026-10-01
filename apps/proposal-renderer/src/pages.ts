import type {
  Commercial,
  Destination,
  Experience,
  FlightSegment,
  Hotel,
  ImagePlacement,
  ItineraryDay,
  NarrativeSection,
  ProposalSpec,
  SourceReference
} from "./spec.js";
import type { PageData, ResolvedPhoto } from "./page-data.js";

/** VERSÃO do contrato de render. */
export const PROPOSAL_RENDERER_VERSION = "tripz-editorial-v2";

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

function namesLine(spec: ProposalSpec): string {
  return spec.travellers.map((traveller) => traveller.name.trim()).filter(Boolean).join(" & ");
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

function flightRouteSubtitle(flights: FlightSegment[], spec: ProposalSpec): string | undefined {
  if (flights.length === 0) return undefined;
  const from = cityOf(flights[0].origin) || spec.origin;
  const to = cityOf(flights[flights.length - 1].destination);
  if (!from || !to) return undefined;
  return from === to ? from : `${from} → ${to}`;
}

function flightsEyebrow(flights: FlightSegment[]): string {
  if (flights.length === 0) return "LOGÍSTICA AÉREA";
  const hasOutbound = flights.some((flight) => flight.direction === "outbound" || flight.direction === "internal");
  const allReturn = flights.every((flight) => flight.direction === "return" || flight.direction === "other");
  if (allReturn) return "RETORNO AO BRASIL";
  if (hasOutbound) return "IDA E VOLTA";
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
    `${cityOf(flight.origin)} → ${cityOf(flight.destination)}`,
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
    tripTitle: spec.tripTitle ?? "",
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

  /* concept — se narrative.concept.headline ou destinos */
  const concept = spec.narrative.concept;
  if (concept?.headline || destinations.length > 0) {
    push("concept", "concept", {
      kind: "concept",
      eyebrow: concept?.eyebrow ?? "A PROPOSTA",
      headline: concept?.headline ?? "Uma viagem desenhada para vocês",
      quote: concept?.quote,
      body: concept?.body?.slice() ?? [],
      photo: resolvePhoto(index, "concept"),
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
        ?? (nights ? `${plural(nights, "noite", "noites")} entre ${destinations.map((dest) => dest.name).join(", ")}` : undefined),
      destinations: destinations.map((dest) => ({
        id: dest.id,
        name: dest.name,
        rangeLabel: rangeLabelFor(dest),
        text: dest.summary,
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
      layout: destinationIndex % 2 === 1 ? "side" : "hero",
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
      eyebrow: "SERVIÇOS COMPREENDIDOS",
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
      headline: `Voos previstos com ${[...new Set(spec.flights.map((flight) => flight.airline).filter(Boolean))].join(" · ")}`,
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

  /* pageOverrides: hidden apenas em páginas opcionais; order desloca a ordem */
  const overrides = new Map(spec.pageOverrides.map((override) => [override.page, override]));
  const OPTIONAL = new Set(["concept", "overview", "experiences", "services", "flights", "hotel"]);
  for (const page of pages) {
    const override = overrides.get(page.id);
    if (!override) continue;
    if (override.hidden && (OPTIONAL.has(page.kind) || page.id.startsWith("destination:"))) page.hidden = true;
      }
  const baseOrder = new Map(pages.map((page, position) => [page.id, position]));
  const sorted = pages.slice().sort((a, b) => {
    const orderA = overrides.get(a.id)?.order ?? 0;
    const orderB = overrides.get(b.id)?.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return (baseOrder.get(a.id) ?? 0) - (baseOrder.get(b.id) ?? 0);
  });
  return sorted;
}

/* --------------------------------------------------------- helpers atrasados */

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

import type { TripzBrandConfig } from "./brand.js";

export type TripzDocumentPageKind =
  | "cover"
  | "intro"
  | "flights"
  | "hotel"
  | "gallery"
  | "transfer"
  | "insurance"
  | "itinerary"
  | "included"
  | "pricing"
  | "notes"
  | "contact";

export interface TripzDocumentAsset {
  id: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: Uint8Array;
  category?: string;
  label?: string;
  selectedForPdf?: boolean;
  sortOrder?: number;
}

export interface TripzDocumentPage {
  kind: TripzDocumentPageKind;
  eyebrow: string;
  title: string;
  subtitle?: string;
  paragraphs: string[];
  facts: Array<{ label: string; value: string }>;
  bullets: string[];
  images: TripzDocumentAsset[];
}

export interface TripzDocumentModel {
  rendererVersion: string;
  proposalRevision: number;
  title: string;
  brand: TripzBrandConfig;
  pages: TripzDocumentPage[];
}

export interface TripzProposalDocumentInput {
  revision?: number;
  title?: string;
  client?: { name?: string };
  destination?: string;
  startDate?: string;
  endDate?: string;
  passengers?: { adults?: number; children?: number; infants?: number };
  flights?: Array<{
    airline?: string;
    flightNumber?: string;
    date?: string;
    departureTime?: string;
    arrivalTime?: string;
    origin?: string;
    destination?: string;
    duration?: string;
    stops?: string | number;
    stopover?: string;
    aircraft?: string;
    cabin?: string;
    baggage?: string;
    notes?: string;
  }>;
  hotel?: {
    name?: string;
    roomType?: string;
    mealPlan?: string;
    description?: string;
    checkIn?: string;
    checkOut?: string;
    nightlyRate?: number | string;
    totalRate?: number | string;
    currency?: string;
  };
  includedItems?: Array<string | { type?: string; title?: string; label?: string; description?: string; included?: boolean }>;
  pricing?: {
    pricePerPerson?: number | string;
    boardingTax?: number | string;
    totalPrice?: number | string;
    currency?: string;
    notes?: string;
  };
  itinerary?: Array<{
    dayNumber: number;
    date?: string;
    title?: string;
    morning?: string;
    afternoon?: string;
    evening?: string;
    notes?: string[];
  }>;
  notes?: string[];
}

export const TRIPZ_DOCUMENT_RENDERER_VERSION = "tripz-document-v1";

function text(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function dateLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text(value, 40);
}

function amount(value: number | string | undefined, currency = "BRL"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(numeric)) return text(String(value), 80);
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(numeric);
  } catch {
    return `${currency} ${numeric.toFixed(2)}`;
  }
}

function passengerLabel(input: TripzProposalDocumentInput["passengers"]): string | undefined {
  if (!input) return undefined;
  const parts: string[] = [];
  if (input.adults) parts.push(`${input.adults} adulto${input.adults === 1 ? "" : "s"}`);
  if (input.children) parts.push(`${input.children} criança${input.children === 1 ? "" : "s"}`);
  if (input.infants) parts.push(`${input.infants} bebê${input.infants === 1 ? "" : "s"}`);
  return parts.join(", ") || undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function textChunks(value: string, maxLength: number): string[] {
  const cleaned = text(value, 20_000);
  if (!cleaned) return [];
  const chunks: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxLength) {
    const boundary = remaining.lastIndexOf(" ", maxLength);
    const end = boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function page(input: Omit<TripzDocumentPage, "paragraphs" | "facts" | "bullets" | "images"> & Partial<TripzDocumentPage>): TripzDocumentPage {
  return {
    ...input,
    paragraphs: input.paragraphs?.flatMap((item) => textChunks(item, 420)) ?? [],
    facts: input.facts?.flatMap((item) => {
      const label = text(item.label, 100) ?? "Detalhe";
      const values = textChunks(item.value, 220);
      return (values.length ? values : ["A confirmar"]).map((value, index) => ({
        label: index === 0 ? label : `${label} (continuação)`,
        value
      }));
    }) ?? [],
    bullets: input.bullets?.flatMap((item) => textChunks(item, 200)) ?? [],
    images: input.images ?? []
  };
}

function contentWeight(input: { type: "paragraph" | "fact" | "bullet"; value: string }): number {
  const lineCharacters = input.type === "paragraph" ? 82 : 68;
  const lines = Math.max(1, Math.ceil(input.value.length / lineCharacters));
  return lines + (input.type === "fact" ? 2 : 1);
}

function paginatePage(source: TripzDocumentPage): TripzDocumentPage[] {
  if (source.kind === "cover") return [source];
  const items = [
    ...source.paragraphs.map((value) => ({ type: "paragraph" as const, value })),
    ...source.facts.map((fact) => ({ type: "fact" as const, value: fact.value, fact })),
    ...source.bullets.map((value) => ({ type: "bullet" as const, value }))
  ];
  if (items.length === 0) return [source];
  const pages: TripzDocumentPage[] = [];
  let current = page({ ...source, paragraphs: [], facts: [], bullets: [] });
  let weight = current.images.length > 0 ? 16 : 0;
  const flush = () => {
    pages.push(current);
    current = page({
      ...source,
      title: `${source.title} — continuação`,
      subtitle: undefined,
      paragraphs: [],
      facts: [],
      bullets: [],
      images: []
    });
    weight = 0;
  };
  for (const item of items) {
    const nextWeight = contentWeight(item);
    if (weight > 0 && weight + nextWeight > 25) flush();
    if (item.type === "paragraph") current.paragraphs.push(item.value);
    else if (item.type === "fact") current.facts.push(item.fact);
    else current.bullets.push(item.value);
    weight += nextWeight;
  }
  if (current.paragraphs.length || current.facts.length || current.bullets.length || current.images.length) {
    pages.push(current);
  }
  return pages;
}

function includedDetails(item: NonNullable<TripzProposalDocumentInput["includedItems"]>[number]) {
  if (typeof item === "string") return { type: "other", label: text(item, 300) ?? "Item incluído" };
  return {
    type: text(item.type, 60)?.toLowerCase() ?? "other",
    label: text(item.label, 240) ?? text(item.title, 240) ?? text(item.description, 240) ?? "Item incluído",
    description: text(item.description, 600)
  };
}

export function buildTripzDocumentModel(
  proposal: TripzProposalDocumentInput,
  assets: TripzDocumentAsset[],
  brand: TripzBrandConfig
): TripzDocumentModel {
  const destination = text(proposal.destination, 160) ?? "Sua próxima viagem";
  const clientName = text(proposal.client?.name, 160);
  const selectedAssets = assets
    .filter((asset) => asset.selectedForPdf !== false && asset.data.byteLength > 0)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  const cover = selectedAssets.find((asset) => asset.category === "cover")
    ?? selectedAssets.find((asset) => asset.category === "destination")
    ?? selectedAssets[0];
  const pages: TripzDocumentPage[] = [];

  pages.push(page({
    kind: "cover",
    eyebrow: brand.agencyName,
    title: destination,
    subtitle: clientName ? `Proposta preparada para ${clientName}` : "Proposta de viagem",
    facts: [
      ...(dateLabel(proposal.startDate) ? [{ label: "Embarque", value: dateLabel(proposal.startDate)! }] : []),
      ...(dateLabel(proposal.endDate) ? [{ label: "Retorno", value: dateLabel(proposal.endDate)! }] : []),
      ...(passengerLabel(proposal.passengers) ? [{ label: "Viajantes", value: passengerLabel(proposal.passengers)! }] : [])
    ],
    images: cover ? [cover] : []
  }));

  if (brand.agentName || clientName) {
    pages.push(page({
      kind: "intro",
      eyebrow: "Bem-vindo",
      title: clientName ? `Olá, ${clientName}` : "Uma viagem pensada para você",
      paragraphs: [
        `Esta proposta reúne os detalhes confirmados para ${destination}.`,
        brand.agentName ? `${brand.agentName} acompanhará você durante a preparação desta experiência.` : "Nossa equipe acompanhará você durante a preparação desta experiência."
      ]
    }));
  }

  const flights = proposal.flights ?? [];
  for (const [index, flightGroup] of chunk(flights, 2).entries()) {
    pages.push(page({
      kind: "flights",
      eyebrow: "Aéreo",
      title: index === 0 ? "Seus voos" : "Continuação dos voos",
      facts: flightGroup.flatMap((flight, flightIndex) => {
        const route = [text(flight.origin, 80), text(flight.destination, 80)].filter(Boolean).join(" → ") || `Trecho ${index * 2 + flightIndex + 1}`;
        const detail = [dateLabel(flight.date), text(flight.departureTime, 20), text(flight.arrivalTime, 20)].filter(Boolean).join(" · ");
        const carrier = [text(flight.airline, 100), text(flight.flightNumber, 30)].filter(Boolean).join(" ");
        return [
          { label: route, value: [carrier, detail].filter(Boolean).join(" — ") || "Detalhes a confirmar" },
          ...([flight.duration, flight.stops, flight.stopover, flight.cabin, flight.baggage].some((value) => value !== undefined)
            ? [{ label: "Detalhes", value: [text(flight.duration, 50), flight.stops !== undefined ? `${flight.stops} escala(s)` : text(flight.stopover, 120), text(flight.cabin, 60), text(flight.baggage, 140)].filter(Boolean).join(" · ") }]
            : []),
          ...(text(flight.notes, 300) ? [{ label: "Observação", value: text(flight.notes, 300)! }] : [])
        ];
      })
    }));
  }

  if (proposal.hotel && Object.values(proposal.hotel).some((value) => value !== undefined && value !== "")) {
    const hotelImages = selectedAssets.filter((asset) => asset.category?.startsWith("hotel_")).slice(0, 2);
    pages.push(page({
      kind: "hotel",
      eyebrow: "Hospedagem",
      title: text(proposal.hotel.name, 180) ?? "Sua hospedagem",
      subtitle: text(proposal.hotel.roomType, 140),
      paragraphs: proposal.hotel.description ? [proposal.hotel.description] : [],
      facts: [
        ...(dateLabel(proposal.hotel.checkIn) ? [{ label: "Check-in", value: dateLabel(proposal.hotel.checkIn)! }] : []),
        ...(dateLabel(proposal.hotel.checkOut) ? [{ label: "Check-out", value: dateLabel(proposal.hotel.checkOut)! }] : []),
        ...(text(proposal.hotel.mealPlan, 100) ? [{ label: "Regime", value: text(proposal.hotel.mealPlan, 100)! }] : []),
        ...(amount(proposal.hotel.totalRate, proposal.hotel.currency) ? [{ label: "Hospedagem", value: amount(proposal.hotel.totalRate, proposal.hotel.currency)! }] : [])
      ],
      images: hotelImages
    }));
  }

  const gallery = selectedAssets.filter((asset) => asset.id !== cover?.id);
  for (const [index, images] of chunk(gallery, 4).entries()) {
    pages.push(page({
      kind: "gallery",
      eyebrow: "Galeria",
      title: index === 0 ? `Conheça ${destination}` : "Mais detalhes da viagem",
      images
    }));
  }

  const included = (proposal.includedItems ?? []).filter((item) => typeof item === "string" || item.included !== false).map(includedDetails);
  const transfers = included.filter((item) => item.type.includes("transfer") || /traslado/i.test(item.label));
  const insurance = included.filter((item) => item.type.includes("insurance") || /seguro/i.test(item.label));
  if (transfers.length) pages.push(page({ kind: "transfer", eyebrow: "Conforto", title: "Traslados", bullets: transfers.map((item) => item.description ? `${item.label}: ${item.description}` : item.label) }));
  if (insurance.length) pages.push(page({ kind: "insurance", eyebrow: "Proteção", title: "Seguro viagem", bullets: insurance.map((item) => item.description ? `${item.label}: ${item.description}` : item.label) }));

  for (const itineraryGroup of chunk(proposal.itinerary ?? [], 3)) {
    pages.push(page({
      kind: "itinerary",
      eyebrow: "Roteiro",
      title: "Dias para aproveitar",
      facts: itineraryGroup.flatMap((day) => {
        const heading = `Dia ${day.dayNumber}${day.title ? ` — ${text(day.title, 120)}` : ""}`;
        const schedule = [day.morning ? `Manhã: ${text(day.morning, 300)}` : undefined, day.afternoon ? `Tarde: ${text(day.afternoon, 300)}` : undefined, day.evening ? `Noite: ${text(day.evening, 300)}` : undefined].filter(Boolean).join(" · ");
        return [{ label: heading, value: [dateLabel(day.date), schedule].filter(Boolean).join(" — ") || "Programação livre" }];
      }),
      bullets: itineraryGroup.flatMap((day) => day.notes ?? [])
    }));
  }

  const remainingIncluded = included.filter((item) => !transfers.includes(item) && !insurance.includes(item));
  if (remainingIncluded.length) pages.push(page({ kind: "included", eyebrow: "Detalhes", title: "Itens incluídos", bullets: remainingIncluded.map((item) => item.description ? `${item.label}: ${item.description}` : item.label) }));

  if (proposal.pricing && Object.values(proposal.pricing).some((value) => value !== undefined && value !== "")) {
    const currency = proposal.pricing.currency ?? "BRL";
    pages.push(page({
      kind: "pricing",
      eyebrow: "Investimento",
      title: "Valores da proposta",
      facts: [
        ...(amount(proposal.pricing.pricePerPerson, currency) ? [{ label: "Por pessoa", value: amount(proposal.pricing.pricePerPerson, currency)! }] : []),
        ...(amount(proposal.pricing.boardingTax, currency) ? [{ label: "Taxa de embarque", value: amount(proposal.pricing.boardingTax, currency)! }] : []),
        ...(amount(proposal.pricing.totalPrice, currency) ? [{ label: "Valor total", value: amount(proposal.pricing.totalPrice, currency)! }] : [])
      ],
      paragraphs: proposal.pricing.notes ? [proposal.pricing.notes] : []
    }));
  }

  if (proposal.notes?.length) pages.push(page({ kind: "notes", eyebrow: "Antes de embarcar", title: "Observações", bullets: proposal.notes }));

  pages.push(page({
    kind: "contact",
    eyebrow: brand.agencyName,
    title: "Vamos seguir com essa viagem?",
    paragraphs: ["Fale com seu agente para confirmar detalhes, disponibilidade e condições antes da emissão."],
    facts: [
      ...(brand.agentName ? [{ label: "Agente", value: brand.agentName }] : []),
      ...(brand.phone ? [{ label: "Telefone", value: brand.phone }] : []),
      ...(brand.email ? [{ label: "E-mail", value: brand.email }] : []),
      ...(brand.address ? [{ label: "Endereço", value: brand.address }] : [])
    ]
  }));

  return {
    rendererVersion: TRIPZ_DOCUMENT_RENDERER_VERSION,
    proposalRevision: Math.max(0, Math.trunc(proposal.revision ?? 0)),
    title: text(proposal.title, 180) ?? `Proposta ${destination}`,
    brand,
    pages: pages.flatMap(paginatePage)
  };
}

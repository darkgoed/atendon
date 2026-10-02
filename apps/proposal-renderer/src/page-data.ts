import type { ProposalBrandConfig } from "./brand.js";
import type {
  Destination,
  Experience,
  FlightSegment,
  Hotel,
  ImagePlacement,
  ItineraryDay,
  NarrativeSection,
  SectionBlock,
  Transfer
} from "./spec.js";

/**
 * Contrato page-data: o builder (pages.ts) resolve TUDO (fotos por papel,
 * copy por destino, dias por destino) e entrega props prontas. Componentes
 * não conhecem o ProposalSpec — recebem só o que desenham.
 */

export interface ResolvedPhoto {
  /** src resolvido no render (data URI ou URL) — preenchido pelo renderer. */
  src?: string;
  placement?: ImagePlacement;
  caption?: string;
  /** mediaId quando veio de um assignment (o editor usa para trocar). */
  mediaId?: string;
}

export interface CoverPageData {
  kind: "cover";
  coverStyle?: "classic" | "split" | "minimal" | "framed";
  tripTitle: string;
  names: string;
  origin?: string;
  photo?: ResolvedPhoto;
  stats: Array<{ value: string; label: string }>;
  dateLine: { strong: string; note?: string };
}

export interface ConceptPageData {
  kind: "concept";
  eyebrow: string;
  headline: string;
  quote?: string;
  body: string[];
  photo?: ResolvedPhoto;
  moments?: { label: string; items: string[] };
  axes: Array<{ label: string; value: string }>;
}

export interface OverviewPageData {
  kind: "overview";
  eyebrow: string;
  headline: string;
  subtitle?: string;
  destinations: Array<{
    id: string;
    name: string;
    rangeLabel: string;
    text?: string;
    photo?: ResolvedPhoto;
  }>;
  route: { cities: string[]; transportNote?: string };
}

export interface TimelineRow {
  dateLabel: string;
  title?: string;
  text?: string;
  suggested?: boolean;
}

export interface DestinationPageData {
  kind: "destination";
  /** Variante editorial determinística: hero (foto topo) alterna com side (foto lateral). */
  layout: "hero" | "side";
  destinationId: string;
  eyebrow: string;
  headline: string;
  subtitle?: string;
  photo?: ResolvedPhoto;
  bodyLabel?: string;
  body?: string[];
  quote?: string;
  sandCard?: { label: string; items: string[] };
  timeline?: { label: string; rows: TimelineRow[] };
  hotel?: {
    id: string;
    name: string;
    pending: boolean;
    eyebrow: string;
    meta?: string;
    text?: string;
    photo?: ResolvedPhoto;
  };
  experiences?: { noteTitle: string; noteText: string; cards: Array<{ id: string; title: string; text?: string }> };
}

export interface HotelPageData {
  kind: "hotel";
  hotelId: string;
  eyebrow: string;
  name: string;
  subtitle?: string;
  photo?: ResolvedPhoto;
  description?: string;
  roomCard?: { label: string; title: string; text?: string };
  cancellationCard?: { label: string; title: string; text?: string };
  gallery: ResolvedPhoto[];
  creditNote?: string;
}

export interface ExperiencesPageData {
  kind: "experiences";
  eyebrow: string;
  headline: string;
  note: { title: string; text: string };
  cards: Array<{ id: string; title: string; text?: string }>;
}

export interface ServicesPageData {
  kind: "services";
  eyebrow: string;
  headline: string;
  subtitle?: string;
  /** Coluna esquerda: logística (aéreo/bagagens, experiências, transportes). */
  leftGroups: Array<{ section: string; items: Array<{ title: string; detail?: string }> }>;
  /** Coluna direita, antes do importante: hospedagens. */
  rightGroups: Array<{ section: string; items: Array<{ title: string; detail?: string }> }>;
  exclusions: string[];
  summary?: { title: string; rows: Array<{ key: string; value: string }>; total?: { key: string; value: string } };
  warnings: string[];
}

export interface FlightsPageData {
  kind: "flights";
  eyebrow: string;
  headline: string;
  subtitle?: string;
  notice?: { title: string; sub?: string };
  capture?: ResolvedPhoto;
  columns: string[];
  rows: string[][];
  chips: Array<{ text: string; variant: "primary" | "plain" | "accent" }>;
  footnote?: string;
}

export interface ClosingPageData {
  kind: "closing";
  eyebrow: string;
  headline: string;
  body: string[];
  photo?: ResolvedPhoto;
  bottomPhoto?: ResolvedPhoto;
  investment?: {
    label: string;
    value: string;
    sub: string;
    notes: string[];
  };
  payment?: { title: string; rows: Array<{ key: string; value: string }>; summary?: string };
  differentials?: { label: string; items: string[] };
  steps: Array<{ number: string; title: string; text: string }>;
  cta?: { quote: string; target?: string };
  fineprint?: string;
  creditsHtml?: string;
}

/** Bloco de seção dinâmica já resolvido (imagens viram ResolvedPhoto). */
export type ResolvedSectionBlock =
  | Exclude<SectionBlock, { type: "image" }>
  | { type: "image"; photo: ResolvedPhoto; caption?: string };

export interface CustomSectionPageData {
  kind: "custom";
  sectionId: string;
  layout: "standard" | "split" | "hero" | "band";
  eyebrow?: string;
  title: string;
  intro?: string;
  photo?: ResolvedPhoto;
  /** Página de continuação da mesma seção (sem foto e sem intro). */
  continuation: boolean;
  blocks: ResolvedSectionBlock[];
  /** Seções curtas empilhadas na mesma página (sem foto). */
  stacked?: Array<{ sectionId: string; eyebrow?: string; title: string; intro?: string; blocks: ResolvedSectionBlock[] }>;
  /** Altura estimada (mm) usada só na paginação. */
  estimatedHeight?: number;
}

export type PageData =
  | CustomSectionPageData
  | CoverPageData
  | ConceptPageData
  | OverviewPageData
  | DestinationPageData
  | HotelPageData
  | ExperiencesPageData
  | ServicesPageData
  | FlightsPageData
  | ClosingPageData;

export interface ProposalRenderContext {
  brand: ProposalBrandConfig;
  /** assets[mediaId] → src final (data URI no PDF, URL no preview). */
  assets: ProposalDocumentAssets;
  /** Ano de referência para formatação de datas (derivado do spec). */
  yearHint?: number;
}

export type ProposalDocumentAssets = Record<string, { kind: "data" | "url"; src: string }>;

export type { Destination, Experience, FlightSegment, Hotel, ItineraryDay, NarrativeSection, Transfer };

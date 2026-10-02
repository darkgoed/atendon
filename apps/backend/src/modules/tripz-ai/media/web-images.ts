// Fotos da internet para a proposta: busca SOMENTE no Wikimedia Commons
// (licenças abertas, autor e licença vêm com a foto), em hosts fixos — a IA
// nunca escolhe URL. Usado quando o agente pede "pegue imagens da internet".
import { createHash } from "node:crypto";
import { mapDestinations, stateToSpec } from "../document/editorial.js";
import { TRIPZ_MAX_SELECTED_MEDIA, type TripzAccessScope, type TripzProposalMedia, type TripzProposalState } from "../domain.js";
import { upsertImageAssignments } from "../ai/orchestrator.js";

const USER_AGENT = "AtendON-TripzMedia/1.0 (https://atendon.alpdash.com.br)";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIPEDIA_PT_API = "https://pt.wikipedia.org/w/api.php";
const WIKIPEDIA_EN_API = "https://en.wikipedia.org/w/api.php";
const ALLOWED_IMAGE_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BANNED_TITLE = /\b(?:map|mapa|logo|flag|bandeira|coat|bras[aã]o|diagram|collage|montage|plan|planta|chart|airport|aeroporto|aeropuerto|metro|subway|stamp|selo|poster|seal|signage|sign|hotel|resort|lobby|interior)\b/i;
const OPEN_LICENSE = /^(?:cc[ -]?by(?:[ -]sa)?(?:[ -]\d(?:\.\d)?)?|cc0(?:[ -]1\.0)?|public domain|pd)\b/i;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebPhoto {
  title: string;
  imageUrl: string;
  pageUrl: string;
  credit: string;
  license: string;
}

/** Pedido explícito do agente: "pegue/busque imagens da internet", "fotos do google"... */
export function wantsWebImages(message: string): boolean {
  const text = message.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!/\b(?:imagem|imagens|foto|fotos|fotografias?)\b/.test(text)) return false;
  if (/\b(?:nao|nunca|sem)\b.{0,30}\b(?:internet|web|google|online)\b/.test(text)) return false;
  return /\b(?:internet|web|google|online|wikimedia|banco de imagens|da rede)\b/.test(text);
}

function placeName(name: string): string {
  return name.split(/[,(]|\s[-–—]\s/)[0].trim();
}

function words(value: string): string[] {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !["the", "city", "cidade", "de", "do", "da"].includes(word));
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

async function getJson(fetchImpl: FetchLike, base: string, params: Record<string, string>): Promise<unknown> {
  const url = `${base}?${new URLSearchParams({ format: "json", ...params })}`;
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * "Nova York" → { name: "New York City", country: "United States" } pelo link
 * interlíngua + descrição curta da Wikipédia em inglês. O Commons é indexado em
 * inglês, e o país desambigua nomes como "Porto" (Portugal × Porto Alegre).
 */
async function englishPlace(fetchImpl: FetchLike, name: string): Promise<{ name?: string; country?: string }> {
  try {
    const data = await getJson(fetchImpl, WIKIPEDIA_PT_API, {
      action: "query", titles: name, redirects: "1", prop: "langlinks", lllang: "en"
    }) as { query?: { pages?: Record<string, { langlinks?: Array<{ "*": string }> }> } };
    const english = Object.values(data.query?.pages ?? {})[0]?.langlinks?.[0]?.["*"];
    if (!english) return {};
    let country: string | undefined;
    try {
      const described = await getJson(fetchImpl, WIKIPEDIA_EN_API, {
        action: "query", titles: english, redirects: "1", prop: "description"
      }) as { query?: { pages?: Record<string, { description?: string }> } };
      const description = Object.values(described.query?.pages ?? {})[0]?.description ?? "";
      country = description.match(/\bin (?:the )?([A-Z][A-Za-z.' -]+?)(?:,|$)/)?.[1]?.trim()
        ?? description.match(/,\s*([A-Z][A-Za-z.' -]+)$/)?.[1]?.trim();
    } catch {
      country = undefined;
    }
    return { name: english, country };
  } catch {
    return {};
  }
}

interface CommonsPage {
  index?: number;
  title: string;
  imageinfo?: Array<{
    mime?: string;
    width?: number;
    height?: number;
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

async function searchCommons(fetchImpl: FetchLike, query: string): Promise<CommonsPage[]> {
  const data = await getJson(fetchImpl, COMMONS_API, {
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: "1600"
  }) as { query?: { pages?: Record<string, CommonsPage> } };
  return Object.values(data.query?.pages ?? {}).sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

const GENERIC_AFTER_PLACE = new Set(["cityscape", "skyline", "panorama", "panoramic", "view", "views", "at", "from", "by", "in", "city", "harbour", "harbor", "old", "town", "downtown", "centre", "center", "night", "sunset", "river", "bay", "beach", "skyline"]);

/** "Porto Moniz"/"Porto Alegre" não são o Porto: outro nome próprio logo após o lugar. */
function namesAnotherPlace(title: string, place: string, placeWords: string[]): boolean {
  if (place.trim().split(/\s+/).length !== 1) return false;
  const escaped = place.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of title.matchAll(new RegExp(`\\b${escaped}\\s+(\\p{Lu}[\\p{Ll}]+)`, "giu"))) {
    const next = words(match[1])[0] ?? match[1].toLowerCase();
    if (!GENERIC_AFTER_PLACE.has(next) && !placeWords.includes(next)) return true;
  }
  return false;
}

function toPhoto(page: CommonsPage, placeWords: string[], place = ""): WebPhoto | undefined {
  const info = page.imageinfo?.[0];
  if (!info?.thumburl || info.mime !== "image/jpeg" || !info.width || !info.height) return undefined;
  const ratio = info.width / info.height;
  if (info.width < 1_600 || ratio < 1.3 || ratio > 2.4) return undefined;
  if (BANNED_TITLE.test(page.title)) return undefined;
  const titleWords = words(page.title);
  if (!placeWords.some((word) => titleWords.includes(word))) return undefined;
  if (place && namesAnotherPlace(page.title.replace(/^File:/, ""), place, placeWords)) return undefined;
  const license = stripHtml(info.extmetadata?.LicenseShortName?.value ?? "");
  if (!OPEN_LICENSE.test(license)) return undefined;
  let host: string;
  try {
    host = new URL(info.thumburl).hostname;
  } catch {
    return undefined;
  }
  if (!ALLOWED_IMAGE_HOSTS.has(host)) return undefined;
  const artist = stripHtml(info.extmetadata?.Artist?.value ?? "").slice(0, 120) || "Autor desconhecido";
  return {
    title: page.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
    imageUrl: info.thumburl,
    pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    credit: `${artist} / Wikimedia Commons, ${license}`.slice(0, 300),
    license
  };
}

/** Até `count` fotos de paisagem, licença aberta, com o nome do lugar no título. */
export async function findPlacePhotos(fetchImpl: FetchLike, name: string, count: number): Promise<WebPhoto[]> {
  const place = placeName(name);
  if (!place) return [];
  const { name: english, country } = await englishPlace(fetchImpl, place);
  const placeWords = [...new Set([...words(place), ...words(english ?? "")])];
  const base = (english ?? place).replace(/\s*\(.*\)$/, "");
  const withCountry = country && !base.includes(country) ? `${base} ${country}` : undefined;
  const queries = [
    ...(withCountry ? [`${withCountry} cityscape`, `${withCountry} panorama`, withCountry] : []),
    `${base} cityscape`, `${base} panorama`, `${base} landscape`, base
  ];
  const found: WebPhoto[] = [];
  for (const query of queries) {
    if (found.length >= count) break;
    let pages: CommonsPage[];
    try {
      pages = await searchCommons(fetchImpl, query);
    } catch {
      continue;
    }
    for (const page of pages) {
      const photo = toPhoto(page, placeWords, base);
      if (photo && !found.some((item) => item.imageUrl === photo.imageUrl)) found.push(photo);
      if (found.length >= count) break;
    }
  }
  return found;
}

export async function downloadPhoto(fetchImpl: FetchLike, photo: WebPhoto): Promise<Buffer | undefined> {
  const url = new URL(photo.imageUrl);
  if (url.protocol !== "https:" || !ALLOWED_IMAGE_HOSTS.has(url.hostname)) return undefined;
  const response = await fetchImpl(url.href, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return undefined;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mime !== "image/jpeg") return undefined;
  const data = Buffer.from(await response.arrayBuffer());
  return data.length > 0 && data.length <= MAX_IMAGE_BYTES ? data : undefined;
}

export interface WebImageAttachmentStore {
  createAttachment(scope: TripzAccessScope, input: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    extension: string;
    data: Buffer;
    contentHash: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ attachment: { id: string } }>;
}

export interface WebImagesResult {
  proposal: TripzProposalState;
  added: Array<{ slot: string; place: string }>;
  message: string;
}

type Slot = { role: "cover" | "destination" | "closing"; targetId?: string; place: string };

/**
 * Preenche capa, destinos e fechamento VAZIOS com fotos do Commons. Nunca
 * substitui foto escolhida pelo agente; hotéis ficam de fora (foto de hotel
 * errada vira promessa falsa — o agente envia as oficiais).
 */
export async function attachWebImages(input: {
  scope: TripzAccessScope;
  conversationId: string;
  proposal: TripzProposalState;
  store: WebImageAttachmentStore;
  fetchImpl?: FetchLike;
}): Promise<WebImagesResult> {
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const state = input.proposal;
  const destinations = mapDestinations(state, state as never)
    .map((destination) => ({ id: String(destination.id), name: String(destination.name) }))
    .filter((destination) => destination.name && destination.name !== "Destino");
  if (destinations.length === 0) {
    return { proposal: state, added: [], message: "Para buscar fotos na internet preciso saber o destino da viagem." };
  }
  const filled = new Set((stateToSpec(state, { tenantId: input.scope.tenantId }).spec?.imageAssignments ?? [])
    .map((assignment) => `${assignment.role}:${assignment.targetId ?? ""}`));
  const slots: Slot[] = [];
  const first = destinations[0];
  if (!filled.has("cover:")) slots.push({ role: "cover", place: first.name });
  for (const destination of destinations) {
    if (!filled.has(`destination:${destination.id}`)) slots.push({ role: "destination", targetId: destination.id, place: destination.name });
  }
  if (!filled.has("closing:")) slots.push({ role: "closing", place: destinations[destinations.length - 1].name });
  if (slots.length === 0) {
    return { proposal: state, added: [], message: "A capa, os destinos e o fechamento já têm fotos; não troquei nenhuma." };
  }

  const selected = state.media.filter((media) => media.selectedForPdf).length;
  const budget = Math.max(0, TRIPZ_MAX_SELECTED_MEDIA - selected);
  const byPlace = new Map<string, WebPhoto[]>();
  for (const slot of slots) {
    if (!byPlace.has(slot.place)) {
      const need = slots.filter((item) => item.place === slot.place).length;
      byPlace.set(slot.place, await findPlacePhotos(fetchImpl, slot.place, need + 1));
    }
  }

  const next = structuredClone(state);
  const media: TripzProposalMedia[] = [];
  const assignments: Array<{ mediaId: string; role: Slot["role"]; targetId?: string; caption?: string; source?: Record<string, string> }> = [];
  const sources = [...(next.editorial?.sources ?? [])];
  const added: WebImagesResult["added"] = [];
  const used = new Set<string>();
  let sortOrder = next.media.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
  for (const slot of slots) {
    if (added.length >= budget) break;
    const photo = byPlace.get(slot.place)?.find((candidate) => !used.has(candidate.imageUrl));
    if (!photo) continue;
    used.add(photo.imageUrl);
    let data: Buffer | undefined;
    try {
      data = await downloadPhoto(fetchImpl, photo);
    } catch {
      data = undefined;
    }
    if (!data) continue;
    const { attachment } = await input.store.createAttachment(input.scope, {
      conversationId: input.conversationId,
      fileName: `${photo.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 80) || "foto"}.jpg`,
      mimeType: "image/jpeg",
      extension: "jpg",
      data,
      contentHash: createHash("sha256").update(data).digest("hex"),
      metadata: { source: { kind: "wikimedia_commons", url: photo.pageUrl }, credit: photo.credit, license: photo.license }
    });
    media.push({
      attachmentId: attachment.id,
      category: slot.role === "cover" ? "cover" : slot.role === "closing" ? "closing" : "destination",
      label: `${slot.place} — Wikimedia Commons`.slice(0, 300),
      confidence: 1,
      sortOrder: sortOrder++,
      selectedForPdf: true,
      metadata: { credit: photo.credit, license: photo.license, sourceUrl: photo.pageUrl }
    });
    assignments.push({
      mediaId: attachment.id,
      role: slot.role,
      ...(slot.targetId ? { targetId: slot.targetId } : {}),
      source: { url: photo.pageUrl, credit: photo.credit, license: photo.license }
    });
    if (!sources.some((source) => source.url === photo.pageUrl)) {
      sources.push({ label: slot.place, url: photo.pageUrl, credit: photo.credit });
    }
    added.push({ slot: slot.role === "cover" ? "capa" : slot.role === "closing" ? "fechamento" : slot.place, place: slot.place });
  }

  if (added.length === 0) {
    return {
      proposal: state,
      added,
      message: `Não encontrei no Wikimedia Commons fotos com licença aberta e boa resolução para ${destinations.map((item) => item.name).join(", ")}. Envie as fotos aqui no chat que eu as coloco no PDF.`
    };
  }
  next.media.push(...media);
  next.editorial = {
    ...(next.editorial ?? {}),
    // Fotos já presentes ficam: a capa/destinos inferidos pelas categorias continuam valendo.
    imageAssignments: upsertImageAssignments(next.editorial?.imageAssignments ?? [], assignments as never),
    sources: sources.slice(0, 40)
  };
  next.schemaVersion = 2;
  const slotsText = added.map((item) => item.slot).join(", ");
  return {
    proposal: next,
    added,
    message: `Coloquei ${added.length} foto${added.length === 1 ? "" : "s"} com licença aberta do Wikimedia Commons (${slotsText}). Os créditos entram no rodapé do fechamento. Para os hotéis, envie as fotos oficiais aqui no chat.`
  };
}

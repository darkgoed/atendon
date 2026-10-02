import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fontes vendidas no pacote (OFL — ver assets/fonts/OFL-NOTES.txt).
 * Noto Sans / Noto Serif Display são variáveis (wght 100–900); a itálica é
 * estática. Subsets latin + latin-ext cobrem pt-BR e aspas tipográficas.
 */

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

export interface ProposalFontFace {
  family: string;
  style: "normal" | "italic";
  /** Peso simples (itálica estática) ou intervalo (variável). */
  weight: string;
  unicodeRange: string;
  file: string;
}

const LATIN = "U+0000-00FF, U+2013-2014, U+2018-2019, U+201C-201D, U+2022, U+2192";
const LATIN_EXT = "U+0100-024F, U+1E00-1EFF";

export const PROPOSAL_FONT_FACES: ProposalFontFace[] = [
  { family: "Noto Serif Display", style: "normal", weight: "100 900", file: "noto-serif-display-var-latin.woff2", unicodeRange: LATIN },
  { family: "Noto Serif Display", style: "normal", weight: "100 900", file: "noto-serif-display-var-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Noto Serif Display", style: "italic", weight: "400", file: "noto-serif-display-italic-latin.woff2", unicodeRange: LATIN },
  { family: "Noto Serif Display", style: "italic", weight: "400", file: "noto-serif-display-italic-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Noto Sans", style: "normal", weight: "100 900", file: "noto-sans-var-latin.woff2", unicodeRange: LATIN },
  { family: "Noto Sans", style: "normal", weight: "100 900", file: "noto-sans-var-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Cormorant Garamond", style: "normal", weight: "300 700", file: "cormorant-garamond-var-latin.woff2", unicodeRange: LATIN },
  { family: "Cormorant Garamond", style: "normal", weight: "300 700", file: "cormorant-garamond-var-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Cormorant Garamond", style: "italic", weight: "300 700", file: "cormorant-garamond-italic-latin.woff2", unicodeRange: LATIN },
  { family: "Cormorant Garamond", style: "italic", weight: "300 700", file: "cormorant-garamond-italic-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Playfair Display", style: "normal", weight: "400 900", file: "playfair-display-var-latin.woff2", unicodeRange: LATIN },
  { family: "Playfair Display", style: "normal", weight: "400 900", file: "playfair-display-var-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Playfair Display", style: "italic", weight: "400 900", file: "playfair-display-italic-latin.woff2", unicodeRange: LATIN },
  { family: "Playfair Display", style: "italic", weight: "400 900", file: "playfair-display-italic-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Montserrat", style: "normal", weight: "100 900", file: "montserrat-var-latin.woff2", unicodeRange: LATIN },
  { family: "Montserrat", style: "normal", weight: "100 900", file: "montserrat-var-latin-ext.woff2", unicodeRange: LATIN_EXT },
  { family: "Montserrat", style: "italic", weight: "100 900", file: "montserrat-italic-latin.woff2", unicodeRange: LATIN },
  { family: "Montserrat", style: "italic", weight: "100 900", file: "montserrat-italic-latin-ext.woff2", unicodeRange: LATIN_EXT }
];

/** Faces de uma lista de famílias (o PDF embute só o par em uso). */
export function proposalFontFacesFor(families?: readonly string[]): ProposalFontFace[] {
  if (!families || families.length === 0) return PROPOSAL_FONT_FACES.filter((face) => face.family === "Noto Serif Display" || face.family === "Noto Sans");
  return PROPOSAL_FONT_FACES.filter((face) => families.includes(face.family));
}

const base64Cache = new Map<string, string>();

export function readProposalFontBase64(file: string): string {
  const cached = base64Cache.get(file);
  if (cached) return cached;
  const data = readFileSync(join(FONTS_DIR, file));
  const base64 = data.toString("base64");
  base64Cache.set(file, base64);
  return base64;
}

export const PROPOSAL_FONT_FILES = PROPOSAL_FONT_FACES.map((face) => face.file);

/** CSS @font-face com fontes inline (base64) — usado no HTML do PDF. */
export function proposalFontFaceCssInline(families?: readonly string[]): string {
  return proposalFontFacesFor(families).map((face) =>
    `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};src:url(data:font/woff2;base64,${readProposalFontBase64(face.file)}) format('woff2');unicode-range:${face.unicodeRange};}`
  ).join("\n");
}

/** CSS @font-face apontando para URLs servidas (preview do painel). */
export function proposalFontFaceCssExternal(baseUrl: string, families?: readonly string[]): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return proposalFontFacesFor(families).map((face) =>
    `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};src:url('${normalized}${face.file}') format('woff2');unicode-range:${face.unicodeRange};}`
  ).join("\n");
}

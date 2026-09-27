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

export const PROPOSAL_FONT_FACES: ProposalFontFace[] = [
  { family: "Noto Serif Display", style: "normal", weight: "100 900", file: "noto-serif-display-var-latin.woff2", unicodeRange: "U+0000-00FF, U+2013-2014, U+2018-2019, U+201C-201D, U+2022, U+2192" },
  { family: "Noto Serif Display", style: "normal", weight: "100 900", file: "noto-serif-display-var-latin-ext.woff2", unicodeRange: "U+0100-024F, U+1E00-1EFF" },
  { family: "Noto Serif Display", style: "italic", weight: "400", file: "noto-serif-display-italic-latin.woff2", unicodeRange: "U+0000-00FF, U+2013-2014, U+2018-2019, U+201C-201D, U+2022, U+2192" },
  { family: "Noto Serif Display", style: "italic", weight: "400", file: "noto-serif-display-italic-latin-ext.woff2", unicodeRange: "U+0100-024F, U+1E00-1EFF" },
  { family: "Noto Sans", style: "normal", weight: "100 900", file: "noto-sans-var-latin.woff2", unicodeRange: "U+0000-00FF, U+2013-2014, U+2018-2019, U+201C-201D, U+2022, U+2192" },
  { family: "Noto Sans", style: "normal", weight: "100 900", file: "noto-sans-var-latin-ext.woff2", unicodeRange: "U+0100-024F, U+1E00-1EFF" }
];

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
export function proposalFontFaceCssInline(): string {
  return PROPOSAL_FONT_FACES.map((face) =>
    `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};src:url(data:font/woff2;base64,${readProposalFontBase64(face.file)}) format('woff2');unicode-range:${face.unicodeRange};}`
  ).join("\n");
}

/** CSS @font-face apontando para URLs servidas (preview do painel). */
export function proposalFontFaceCssExternal(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return PROPOSAL_FONT_FACES.map((face) =>
    `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};src:url('${normalized}${face.file}') format('woff2');unicode-range:${face.unicodeRange};}`
  ).join("\n");
}

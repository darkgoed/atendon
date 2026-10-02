import type { ProposalBrandConfig } from "./brand.js";
import type { ProposalTheme } from "./spec.js";

/**
 * Visual por proposta sobre a marca do tenant. A IA sugere paleta, par de
 * fontes e estilo de capa; aqui ficam os limites que mantêm o documento
 * legível: cada cor só entra se passar no contraste do papel que ocupa.
 */

export type FontPairId = NonNullable<ProposalTheme["fontPair"]>;

/** Família dos títulos/citações por par; o corpo é sempre Noto Sans (legibilidade). */
export const FONT_PAIRS: Record<FontPairId, { display: string; fallback: string }> = {
  classic: { display: "Noto Serif Display", fallback: "\"Times New Roman\", serif" },
  elegant: { display: "Cormorant Garamond", fallback: "Georgia, serif" },
  refined: { display: "Playfair Display", fallback: "Georgia, serif" },
  modern: { display: "Montserrat", fallback: "Arial, sans-serif" }
};

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return 0;
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#ffffff";

/** Tokens finais: paleta do tema onde ela for legível, marca do tenant no resto. */
export function themedTokens(brand: ProposalBrandConfig, theme: ProposalTheme | undefined): ProposalBrandConfig["tokens"] {
  const tokens = { ...brand.tokens };
  const palette = theme?.palette;
  if (!palette) return tokens;
  // primary/secondary/accent carregam texto branco (capa, cards, banners).
  if (palette.primary && contrast(palette.primary, WHITE) >= 7) tokens.primary = palette.primary;
  if (palette.secondary && contrast(palette.secondary, WHITE) >= 4.5) tokens.secondary = palette.secondary;
  if (palette.accent && contrast(palette.accent, WHITE) >= 3) tokens.accent = palette.accent;
  // fundo claro com texto escuro; areia aparece como texto sobre a cor primária.
  if (palette.background && luminance(palette.background) >= 0.78 && contrast(palette.background, tokens.ink) >= 8) {
    tokens.background = palette.background;
  }
  if (palette.sand && contrast(palette.sand, tokens.primary) >= 4.5) tokens.sand = palette.sand;
  return tokens;
}

export function fontPairOf(theme: ProposalTheme | undefined): FontPairId {
  return theme?.fontPair ?? "classic";
}

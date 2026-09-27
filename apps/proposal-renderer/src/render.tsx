import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProposalBrandConfig } from "./brand.js";
import type { ProposalSpec } from "./spec.js";
import type { ProposalDocumentAssets } from "./page-data.js";
import { ProposalDocument } from "./document.js";
import { proposalFontFaceCssInline, proposalFontFaceCssExternal } from "./fonts.js";

const RENDERER_DIR = dirname(fileURLToPath(import.meta.url));

function readProposalCss(): string {
  const candidates = [
    join(RENDERER_DIR, "styles", "proposal.css"),
    join(RENDERER_DIR, "..", "src", "styles", "proposal.css")
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error("proposal.css não encontrado (dist/styles ou src/styles)");
}

function renderDocumentMarkup(input: {
  spec: ProposalSpec;
  brand: ProposalBrandConfig;
  assets: ProposalDocumentAssets;
}): string {
  return renderToStaticMarkup(
    <ProposalDocument
      spec={input.spec}
      brand={input.brand}
      context={{ brand: input.brand, assets: input.assets }}
    />
  );
}

/** HTML standalone A4 (PDF e preview) — CSS e fontes embutidos, sem JS, sem rede. */
export function renderProposalHtml(input: {
  spec: ProposalSpec;
  brand: ProposalBrandConfig;
  assets: ProposalDocumentAssets;
  fontMode?: "inline" | "external";
  fontBaseUrl?: string;
  baseUrl?: string;
}): string {
  const fontMode = input.fontMode ?? "inline";
  const fontCss = fontMode === "external"
    ? proposalFontFaceCssExternal(input.fontBaseUrl ?? "/proposal-fonts")
    : proposalFontFaceCssInline();
  const css = readProposalCss();
  const markup = renderDocumentMarkup({ spec: input.spec, brand: input.brand, assets: input.assets });
  const title = `${input.spec.tripTitle ?? "Proposta"} · Proposta`;
  const baseHref = input.baseUrl ? `<base href="${input.baseUrl}">` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${baseHref}<title>${title}</title><style>@page { size: A4; margin: 0; } html, body { margin: 0; padding: 0; background: #e8e5de; }${fontCss}${css}</style></head><body>${markup}</body></html>`;
}

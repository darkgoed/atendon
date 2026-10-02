import type { CSSProperties, JSX } from "react";
import type { ProposalBrandConfig } from "./brand.js";
import type { ProposalSpec } from "./spec.js";
import type { PageData, ProposalRenderContext, ProposalDocumentAssets, ResolvedPhoto } from "./page-data.js";
import type { FooterInfo } from "./components/shared.js";
import type { ProposalPage } from "./pages.js";
import { buildProposalPages, formatShortDate, namesLine, tripTitleOf } from "./pages.js";
import { ProposalCover } from "./components/proposal-cover.js";
import { ProposalConcept } from "./components/proposal-concept.js";
import { ProposalOverview } from "./components/proposal-overview.js";
import { DestinationActPage } from "./components/destination-act-page.js";
import { HotelPage } from "./components/hotel-page.js";
import { ExperiencesPage } from "./components/experiences-page.js";
import { ServicesPage } from "./components/services-page.js";
import { FlightsPage } from "./components/flights-page.js";
import { CommercialClosing } from "./components/closing-page.js";

export type { ProposalDocumentAssets };

function isPhoto(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.mediaId === "string" || ("placement" in candidate && "caption" in candidate);
}

/** Propaga src dos assets nas fotos resolvidas (cópia profunda, sem mutar props). */
function resolvePhotoSrcs<T>(value: T, assets: ProposalDocumentAssets): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node !== "object" || node === null) return node;
    const record = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) output[key] = visit(child);
    if (isPhoto(output)) {
      const mediaId = output.mediaId as string | undefined;
      const asset = mediaId ? assets[mediaId] : undefined;
      output.src = asset?.src ?? output.src;
    }
    return output;
  };
  return visit(value) as T;
}

function brandCssVars(brand: ProposalBrandConfig): CSSProperties {
  const vars: Record<string, string> = {
    "--tp-bg": brand.tokens.background,
    "--tp-primary": brand.tokens.primary,
    "--tp-secondary": brand.tokens.secondary,
    "--tp-accent": brand.tokens.accent,
    "--tp-sand": brand.tokens.sand,
    "--tp-ink": brand.tokens.ink,
    "--tp-muted": brand.tokens.muted,
    "--tp-info": brand.tokens.info
  };
  if (brand.fonts.serif) vars["--tp-font-serif"] = `'${brand.fonts.serif}', "Times New Roman", serif`;
  if (brand.fonts.sans) vars["--tp-font-sans"] = `'${brand.fonts.sans}', Arial, sans-serif`;
  return vars as CSSProperties;
}

function footerInfoFor(spec: ProposalSpec): FooterInfo {
  const left = [tripTitleOf(spec).toUpperCase(), namesLine(spec).toUpperCase()].filter(Boolean).join(" · ");
  const start = spec.startDate ?? spec.departureDate;
  const end = spec.endDate ?? spec.returnDate;
  const right = start && end && start !== end
    ? `${formatShortDate(start)} — ${formatShortDate(end)}`
    : start
      ? formatShortDate(start)
      : "";
  return { left, right };
}

function PageRenderer(props: { data: PageData; footer: FooterInfo }): JSX.Element {
  switch (props.data.kind) {
    case "cover": return <ProposalCover data={props.data} />;
    case "concept": return <ProposalConcept data={props.data} footer={props.footer} />;
    case "overview": return <ProposalOverview data={props.data} footer={props.footer} />;
    case "destination": return <DestinationActPage data={props.data} footer={props.footer} />;
    case "hotel": return <HotelPage data={props.data} footer={props.footer} />;
    case "experiences": return <ExperiencesPage data={props.data} footer={props.footer} />;
    case "services": return <ServicesPage data={props.data} footer={props.footer} />;
    case "flights": return <FlightsPage data={props.data} footer={props.footer} />;
    case "closing": return <CommercialClosing data={props.data} />;
    default: return <></>;
  }
}

/** Compõe as páginas resolvidas em DOM A4 (dono da resolução de fotos). */
export function ProposalDocument(props: {
  spec: ProposalSpec;
  brand: ProposalBrandConfig;
  context: ProposalRenderContext;
  pages?: ProposalPage[];
}): JSX.Element {
  const built = props.pages ?? buildProposalPages(props.spec);
  const resolved = resolvePhotoSrcs(built, props.context.assets);
  const footer = footerInfoFor(props.spec);
  return (
    <div className="tp-doc" style={brandCssVars(props.brand)}>
      {resolved
        .filter((page) => !page.hidden)
        .map((page) => (
          <PageRenderer key={page.id} data={page.data} footer={footer} />
        ))}
    </div>
  );
}

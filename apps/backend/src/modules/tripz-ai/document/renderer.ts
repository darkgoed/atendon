import { createHash } from "node:crypto";
import { createTripzBrandConfig, type TripzBrandConfig } from "./brand.js";
import { renderTripzHtml } from "./html-renderer.js";
import { renderTripzPdf } from "./pdf-renderer.js";
import { buildTripzDocumentModel, type TripzDocumentAsset, type TripzDocumentModel, type TripzProposalDocumentInput } from "./view-model.js";

export interface TripzRenderedDocument {
  model: TripzDocumentModel;
  html: string;
  contentHash: string;
}

function modelFingerprint(model: TripzDocumentModel): string {
  const serializable = {
    ...model,
    brand: { ...model.brand, logo: model.brand.logo ? { mimeType: model.brand.logo.mimeType, size: model.brand.logo.data.byteLength } : undefined },
    pages: model.pages.map((page) => ({
      ...page,
      images: page.images.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, category: asset.category, label: asset.label, selectedForPdf: asset.selectedForPdf, sortOrder: asset.sortOrder, sha256: createHash("sha256").update(asset.data).digest("hex") }))
    }))
  };
  return createHash("sha256").update(JSON.stringify(serializable)).digest("hex");
}

export function createTripzPreview(input: {
  proposal: TripzProposalDocumentInput;
  assets?: TripzDocumentAsset[];
  brand?: Partial<TripzBrandConfig>;
}): TripzRenderedDocument {
  const model = buildTripzDocumentModel(input.proposal, input.assets ?? [], createTripzBrandConfig(input.brand));
  return { model, html: renderTripzHtml(model), contentHash: modelFingerprint(model) };
}

export async function createTripzPdf(preview: TripzRenderedDocument): Promise<{ data: Uint8Array; contentHash: string }> {
  const data = await renderTripzPdf(preview.model);
  return { data, contentHash: preview.contentHash };
}


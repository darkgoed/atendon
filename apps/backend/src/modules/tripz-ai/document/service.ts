import sharp from "sharp";
import { TRIPZ_MAX_SELECTED_MEDIA, TripzAiError, type TripzAccessScope, type TripzProposal } from "../domain.js";
import type { TripzAiRepository } from "../repository.js";
import { createTripzBrandConfig, type TripzBrandConfig } from "./brand.js";
import { createTripzPdf, createTripzPreview } from "./renderer.js";
import { TRIPZ_DOCUMENT_RENDERER_VERSION, type TripzDocumentAsset, type TripzProposalDocumentInput } from "./view-model.js";

export const TRIPZ_DOCUMENT_MAX_MEDIA = TRIPZ_MAX_SELECTED_MEDIA;
export const TRIPZ_DOCUMENT_MAX_IMAGE_BYTES = 256 * 1024;
export const TRIPZ_DOCUMENT_MAX_TOTAL_MEDIA_BYTES = 3 * 1024 * 1024;

const IMAGE_PROFILES = [
  { width: 1_600, height: 1_200, quality: 78 },
  { width: 1_280, height: 960, quality: 68 },
  { width: 1_024, height: 768, quality: 58 },
  { width: 800, height: 600, quality: 48 }
] as const;

async function normalizeDocumentImage(data: Buffer): Promise<Buffer> {
  for (const profile of IMAGE_PROFILES) {
    const normalized = await sharp(data, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(profile.width, profile.height, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: profile.quality, progressive: true, mozjpeg: true })
      .toBuffer();
    if (normalized.length <= TRIPZ_DOCUMENT_MAX_IMAGE_BYTES) return normalized;
  }
  throw new TripzAiError(413, "TRIPZ_RENDER_MEDIA_TOO_LARGE", "Uma imagem selecionada é complexa demais para o documento");
}

function brandFromEnvironment(environment: NodeJS.ProcessEnv): Partial<TripzBrandConfig> {
  return {
    agencyName: environment.TRIPZ_BRAND_AGENCY_NAME || "Tripz Turismo",
    agentName: environment.TRIPZ_BRAND_AGENT_NAME || undefined,
    primaryColor: environment.TRIPZ_BRAND_PRIMARY_COLOR || undefined,
    secondaryColor: environment.TRIPZ_BRAND_SECONDARY_COLOR || undefined,
    backgroundColor: environment.TRIPZ_BRAND_BACKGROUND_COLOR || undefined,
    textColor: environment.TRIPZ_BRAND_TEXT_COLOR || undefined,
    mutedColor: environment.TRIPZ_BRAND_MUTED_COLOR || undefined,
    phone: environment.TRIPZ_BRAND_PHONE || undefined,
    email: environment.TRIPZ_BRAND_EMAIL || undefined,
    address: environment.TRIPZ_BRAND_ADDRESS || undefined
  };
}

function proposalInput(proposal: TripzProposal): TripzProposalDocumentInput {
  const state = proposal.state;
  return {
    revision: proposal.revision,
    title: state.title,
    client: state.client,
    destination: state.destination,
    startDate: state.startDate,
    endDate: state.endDate,
    passengers: state.passengers,
    flights: state.flights.map((flight) => ({
      ...flight,
      notes: flight.notes?.join(" · ")
    })),
    hotel: state.hotel,
    includedItems: state.includedItems,
    pricing: state.pricing,
    itinerary: state.itinerary,
    notes: state.notes
  };
}

export class TripzDocumentService {
  private readonly brand: TripzBrandConfig;

  constructor(
    private readonly repository: TripzAiRepository,
    brand: Partial<TripzBrandConfig> = brandFromEnvironment(process.env)
  ) {
    this.brand = createTripzBrandConfig(brand);
  }

  private async loadAssets(scope: TripzAccessScope, proposal: TripzProposal): Promise<TripzDocumentAsset[]> {
    const assets: TripzDocumentAsset[] = [];
    const selectedMedia = proposal.state.media
      .filter((item) => item.selectedForPdf)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.attachmentId.localeCompare(right.attachmentId));
    if (selectedMedia.length > TRIPZ_DOCUMENT_MAX_MEDIA) {
      throw new TripzAiError(413, "TRIPZ_RENDER_MEDIA_LIMIT", `Selecione no máximo ${TRIPZ_DOCUMENT_MAX_MEDIA} imagens para o documento`);
    }
    let totalBytes = 0;
    for (const media of selectedMedia) {
      const stored = await this.repository.getAttachmentContent(scope, proposal.conversationId, media.attachmentId);
      if (!stored || !["image/jpeg", "image/png", "image/webp"].includes(stored.attachment.mimeType)) continue;
      const data = await normalizeDocumentImage(stored.data);
      totalBytes += data.length;
      if (totalBytes > TRIPZ_DOCUMENT_MAX_TOTAL_MEDIA_BYTES) {
        throw new TripzAiError(413, "TRIPZ_RENDER_MEDIA_BYTES", "As imagens selecionadas excedem o limite seguro do documento");
      }
      assets.push({
        id: stored.attachment.id,
        mimeType: "image/jpeg",
        data,
        category: media.category,
        label: media.label,
        selectedForPdf: media.selectedForPdf,
        sortOrder: media.sortOrder
      });
    }
    return assets;
  }

  async renderPreview(scope: TripzAccessScope, proposal: TripzProposal): Promise<{ html: string; rendererVersion: string }> {
    const preview = createTripzPreview({
      proposal: proposalInput(proposal),
      assets: await this.loadAssets(scope, proposal),
      brand: this.brand
    });
    return { html: preview.html, rendererVersion: preview.model.rendererVersion };
  }

  async renderPdf(scope: TripzAccessScope, proposal: TripzProposal): Promise<{ data: Buffer; rendererVersion: string }> {
    const preview = createTripzPreview({
      proposal: proposalInput(proposal),
      assets: await this.loadAssets(scope, proposal),
      brand: this.brand
    });
    const pdf = await createTripzPdf(preview);
    return { data: Buffer.from(pdf.data), rendererVersion: TRIPZ_DOCUMENT_RENDERER_VERSION };
  }
}

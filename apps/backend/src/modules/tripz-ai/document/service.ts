import sharp from "sharp";
import { TRIPZ_MAX_SELECTED_MEDIA, TripzAiError, type TripzAccessScope, type TripzProposal } from "../domain.js";
import type { TripzAiRepository } from "../repository.js";
import { getBrandSettings, tripzBrandDatabase } from "./brand-settings.js";
import { APP_PANEL_URL, TRIPZ_PDF_DISABLE_CHROMIUM } from "./env.js";
import { exportDocumentPdf, PDF_ENGINE_UNAVAILABLE } from "./pdf-chromium.js";
import { stateToSpec } from "./editorial.js";
import {
  PROPOSAL_RENDERER_VERSION,
  proposalSpecSchema,
  type ProposalBrandConfig,
  type ProposalDocumentAssets,
  type ProposalSpec
} from "@atendon/proposal-renderer";

export const TRIPZ_DOCUMENT_MAX_MEDIA = TRIPZ_MAX_SELECTED_MEDIA;
export const TRIPZ_DOCUMENT_MAX_IMAGE_BYTES = 256 * 1024;
export const TRIPZ_DOCUMENT_MAX_TOTAL_MEDIA_BYTES = 3 * 1024 * 1024;

const RENDERABLE_MIME = ["image/jpeg", "image/png", "image/webp"];

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

interface BuiltDocument {
  spec: ProposalSpec;
  brand: ProposalBrandConfig;
}

export class TripzDocumentService {
  constructor(private readonly repository: TripzAiRepository) {}

  private async loadBrand(scope: TripzAccessScope): Promise<ProposalBrandConfig> {
    const database = tripzBrandDatabase(this.repository as unknown as object);
    return getBrandSettings(database, scope.tenantId);
  }

  /** assets por mediaId: data URI no PDF (inline) ou URL relativa no preview. */
  private async loadAssets(
    scope: TripzAccessScope,
    proposal: TripzProposal,
    spec: ProposalSpec,
    mode: "data" | "url"
  ): Promise<{ assets: ProposalDocumentAssets; issues: string[] }> {
    const assets: ProposalDocumentAssets = {};
    const issues: string[] = [];
    const selectedMedia = proposal.state.media
      .filter((item) => item.selectedForPdf)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.attachmentId.localeCompare(right.attachmentId));
    if (selectedMedia.length > TRIPZ_DOCUMENT_MAX_MEDIA) {
      throw new TripzAiError(413, "TRIPZ_RENDER_MEDIA_LIMIT", `Selecione no máximo ${TRIPZ_DOCUMENT_MAX_MEDIA} imagens para o documento`);
    }
    // Foto atribuída a um slot (capa, hotel X…) entra mesmo fora da seleção —
    // ex.: imagem enviada por URL no editor ou indicada no chat. Atribuídas primeiro.
    const sectionMediaIds = spec.customSections.flatMap((section) => [
      ...(section.mediaId ? [section.mediaId] : []),
      ...section.blocks.flatMap((block) => block.type === "image" ? [block.mediaId] : [])
    ]);
    const assignedIds = [...new Set([...spec.imageAssignments.map((assignment) => assignment.mediaId), ...sectionMediaIds])];
    const mediaIds = [...new Set([...assignedIds, ...selectedMedia.map((media) => media.attachmentId)])]
      .slice(0, TRIPZ_DOCUMENT_MAX_MEDIA + 4);
    let totalBytes = 0;
    for (const mediaId of mediaIds) {
      const stored = await this.repository.getAttachmentContent(scope, proposal.conversationId, mediaId);
      if (!stored || !RENDERABLE_MIME.includes(stored.attachment.mimeType)) {
        issues.push(`media ${mediaId} indisponível ou não renderizável`);
        continue;
      }
      if (mode === "url") {
        assets[stored.attachment.id] = {
          kind: "url",
          src: `/api/conversations/${proposal.conversationId}/attachments/${stored.attachment.id}/content`
        };
        continue;
      }
      const data = await normalizeDocumentImage(stored.data);
      totalBytes += data.length;
      if (totalBytes > TRIPZ_DOCUMENT_MAX_TOTAL_MEDIA_BYTES) {
        throw new TripzAiError(413, "TRIPZ_RENDER_MEDIA_BYTES", "As imagens selecionadas excedem o limite seguro do documento");
      }
      assets[stored.attachment.id] = { kind: "data", src: `data:image/jpeg;base64,${data.toString("base64")}` };
    }
    return { assets, issues };
  }

  /** state → ProposalSpec validado + brand do tenant (fonte única do documento). */
  private async buildDocument(scope: TripzAccessScope, proposal: TripzProposal): Promise<BuiltDocument> {
    const brand = await this.loadBrand(scope);
    const built = stateToSpec(proposal.state, { tenantId: scope.tenantId, brand });
    if (!built.spec) {
      throw new TripzAiError(422, "TRIPZ_SPEC_INVALID", `Estado não pôde ser normalizado em ProposalSpec: ${built.issues[0] ?? "inválido"}`);
    }
    return { spec: built.spec, brand };
  }

  async renderPreview(scope: TripzAccessScope, proposal: TripzProposal): Promise<{ html: string; rendererVersion: string }> {
    const { spec, brand } = await this.buildDocument(scope, proposal);
    const parsedSpec: ProposalSpec = proposalSpecSchema.parse(spec);
    const { renderProposalHtml } = await import("@atendon/proposal-renderer");
    const { assets } = await this.loadAssets(scope, proposal, parsedSpec, "url");
    const panelUrl = APP_PANEL_URL(process.env);
    const html = renderProposalHtml({
      spec: parsedSpec,
      brand,
      assets,
      fontMode: "external",
      fontBaseUrl: `${panelUrl ?? ""}/proposal-fonts`
    });
    return { html, rendererVersion: PROPOSAL_RENDERER_VERSION };
  }

  async renderPdf(scope: TripzAccessScope, proposal: TripzProposal): Promise<{ data: Buffer; rendererVersion: string }> {
    if (TRIPZ_PDF_DISABLE_CHROMIUM(process.env)) {
      throw new TripzAiError(503, PDF_ENGINE_UNAVAILABLE, "Motor de PDF indisponível neste ambiente");
    }
    const { spec, brand } = await this.buildDocument(scope, proposal);
    const parsedSpec: ProposalSpec = proposalSpecSchema.parse(spec);
    const { renderProposalHtml } = await import("@atendon/proposal-renderer");
    const { assets } = await this.loadAssets(scope, proposal, parsedSpec, "data");
    const html = renderProposalHtml({
      spec: parsedSpec,
      brand,
      assets,
      fontMode: "inline"
    });
    const pdf = await exportDocumentPdf({ spec: parsedSpec, html });
    return { data: pdf, rendererVersion: PROPOSAL_RENDERER_VERSION };
  }
}

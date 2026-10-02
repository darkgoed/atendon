import { createHash } from "node:crypto";
import { TRIPZ_DOCX_MIME, TRIPZ_XLSX_MIME } from "./office-text.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db/client.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { createTripzFeatureGate, requireTripzAiPermission, type TripzAuthorizer, type TripzFeatureGate } from "./authorization.js";
import { validateTripzProposal, tripzProposalContentFingerprint } from "./ai/proposal-validator.js";
import { getBrandSettings, tripzBrandDatabase, upsertTripzBrandSettings } from "./document/brand-settings.js";
import {
  tripzBrandSettingsPutSchema,
  tripzFinalizeSchema,
  tripzMediaFromUrlSchema,
  tripzProposalVersionRevertSchema
} from "./document/payload-schemas.js";
import { TripzAiError, tripzNotFound, type TripzAccessScope, type TripzMessage, type TripzProposal, type TripzProposalPatch } from "./domain.js";
import { TripzAiRepository, type TripzRepositoryPort } from "./repository.js";
import {
  tripzAttachmentParamsSchema,
  tripzAttachmentUploadHeadersSchema,
  tripzConversationCreateSchema,
  tripzConversationListQuerySchema,
  tripzConversationParamsSchema,
  tripzConversationRenameSchema,
  tripzDocumentParamsSchema,
  tripzGenerateDocumentSchema,
  tripzIdempotencyKeySchema,
  tripzMessageCreateSchema,
  tripzMessageParamsSchema,
  tripzMessageListQuerySchema,
  tripzProposalPatchRequestSchema
} from "./schemas.js";
import { PostgresTripzFileStore, tripzContentDisposition, type TripzFileStore } from "./storage.js";
import { OutboundDownloadTooLargeError, OutboundUrlError, publicHttpsDownload, type PublicHttpsDownload } from "../../security/outbound-url.js";

export interface TripzMessageCreatedContext {
  scope: TripzAccessScope;
  conversationId: string;
  message: TripzMessage;
  attachmentIds: string[];
  reused: boolean;
}

export interface TripzDocumentRenderContext {
  scope: TripzAccessScope;
  conversationId: string;
  proposal: TripzProposal;
}

export interface TripzPreviewRenderResult {
  html: string;
  rendererVersion: string;
}

export interface TripzPdfRenderResult {
  data: Buffer;
  rendererVersion: string;
}

export interface TripzRouteDependencies {
  repository?: TripzRepositoryPort;
  fileStore?: TripzFileStore;
  authorize?: TripzAuthorizer;
  featureGate?: TripzFeatureGate;
  onMessageCreated?: (context: TripzMessageCreatedContext) => Promise<void>;
  renderPreview?: (context: TripzDocumentRenderContext) => Promise<TripzPreviewRenderResult>;
  renderPdf?: (context: TripzDocumentRenderContext) => Promise<TripzPdfRenderResult>;
  /** Download de mídia externa (padrão: publicHttpsDownload, pinado contra SSRF). */
  downloadMedia?: typeof publicHttpsDownload;
}

function responseError(statusCode: number, code: string, message: string): TripzAiError {
  return new TripzAiError(statusCode, code, message);
}

function rendererReady(proposal: TripzProposal, kind: "preview" | "pdf"): void {
  const state = proposal.state;
  const validation = validateTripzProposal(state, { requiredFields: state.generationRequirements, additionalIssues: state.inconsistencies });
  if (!validation.canGenerate) throw responseError(409, "TRIPZ_PROPOSAL_NOT_READY", "Resolva os dados obrigatórios antes de gerar");
  if (kind === "pdf" && (!state.reviewConfirmation?.confirmed || state.reviewConfirmation.proposalFingerprint !== tripzProposalContentFingerprint(state))) {
    throw responseError(409, "TRIPZ_SUMMARY_CONFIRMATION_REQUIRED", "Confirme o resumo desta versão antes de gerar o PDF");
  }
  if (state.inconsistencies.some((issue) => issue.severity === "critical")) {
    throw responseError(409, "TRIPZ_CRITICAL_ISSUES", "Resolva as inconsistências críticas antes de gerar");
  }
  const accepted = kind === "preview"
    ? ["ready_for_review", "ready_for_pdf", "pdf_generated"]
    : ["ready_for_pdf", "pdf_generated"];
  if (!accepted.includes(state.status)) {
    throw responseError(409, "TRIPZ_PROPOSAL_NOT_READY", kind === "preview"
      ? "Revise o resumo da proposta antes de gerar a prévia"
      : "Confirme o resumo da proposta antes de gerar o PDF");
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  const parsed = tripzIdempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw responseError(400, "TRIPZ_IDEMPOTENCY_REQUIRED", "Informe um Idempotency-Key válido");
  }
  return parsed.data;
}

export async function registerTripzAiRoutes(app: FastifyInstance, dependencies: TripzRouteDependencies = {}) {
  const repository = dependencies.repository ?? new TripzAiRepository(db);
  const fileStore = dependencies.fileStore ?? new PostgresTripzFileStore(repository);
  const authorize = dependencies.authorize ?? requireTripzAiPermission;
  const featureGate = dependencies.featureGate ?? createTripzFeatureGate(db);
  const downloadMedia = dependencies.downloadMedia ?? publicHttpsDownload;

  for (const contentType of ["image/jpeg", "image/png", "image/webp", "application/pdf", TRIPZ_DOCX_MIME, TRIPZ_XLSX_MIME, "text/plain", "text/csv"]) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    }
  }

  const access = async (request: FastifyRequest) => {
    const scope = await authorize(request);
    await featureGate(scope.tenantId);
    return scope;
  };

  app.post("/tripz-ai/conversations", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const body = tripzConversationCreateSchema.parse(request.body ?? {});
    const detail = await repository.createConversation(scope, body.title);
    request.log.info({ component: "TripzAI", action: "conversation_created", tenantId: scope.tenantId,
      conversationId: detail.conversation.id }, "[TripzAI] conversation created");
    return reply.status(201).send({ conversation: detail.conversation, proposal: detail.proposal });
  });

  app.get("/tripz-ai/conversations", async (request) => {
    const scope = await access(request);
    const query = tripzConversationListQuerySchema.parse(request.query);
    const page = await repository.listConversations(scope, query);
    return { conversations: page.items, nextCursor: page.nextCursor };
  });

  app.get("/tripz-ai/conversations/:id", async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const detail = await repository.getConversationDetail(scope, id);
    if (!detail) return reply.status(404).send({ error: "Conversa não encontrada" });
    return detail;
  });

  app.delete("/tripz-ai/conversations/:id", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    if (!await repository.deleteConversation(scope, id)) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    request.log.info({ component: "TripzAI", action: "conversation_deleted", tenantId: scope.tenantId,
      conversationId: id }, "[TripzAI] conversation deleted");
    return reply.status(204).send();
  });

  app.patch("/tripz-ai/conversations/:id", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const { title } = tripzConversationRenameSchema.parse(request.body);
    const conversation = await repository.renameConversation(scope, id, title);
    request.log.info({ component: "TripzAI", action: "conversation_renamed", tenantId: scope.tenantId,
      conversationId: id }, "[TripzAI] conversation renamed");
    return { conversation };
  });

  app.get("/tripz-ai/conversations/:id/messages", async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const query = tripzMessageListQuerySchema.parse(request.query);
    const page = await repository.listMessages(scope, id, query);
    if (!page) return reply.status(404).send({ error: "Conversa não encontrada" });
    return { messages: page.items, nextCursor: page.nextCursor };
  });

  app.post("/tripz-ai/conversations/:id/messages", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const body = tripzMessageCreateSchema.parse(request.body);
    const result = await repository.createUserMessage(scope, {
      conversationId: id,
      content: body.content,
      attachmentIds: body.attachmentIds,
      idempotencyKey: idempotencyKey(request)
    });
    if (dependencies.onMessageCreated) {
      try {
        await dependencies.onMessageCreated({
          scope,
          conversationId: id,
          message: result.message,
          attachmentIds: body.attachmentIds,
          reused: result.reused
        });
      } catch (error) {
        request.log.error({ component: "TripzAI", action: "message_dispatch_failed", tenantId: scope.tenantId,
          conversationId: id, messageId: result.message.id,
          errorName: error instanceof Error ? error.name : "UnknownError" }, "[TripzAI] message dispatch failed");
        throw responseError(503, "TRIPZ_PROCESSING_UNAVAILABLE", "Mensagem salva; processamento temporariamente indisponível");
      }
    }
    request.log.info({ component: "TripzAI", action: result.reused ? "message_reused" : "message_created",
      tenantId: scope.tenantId, conversationId: id, messageId: result.message.id },
    "[TripzAI] message persisted");
    return reply.status(202).send({ message: result.message, reused: result.reused });
  });

  app.post("/tripz-ai/conversations/:id/messages/:messageId/retry", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id, messageId } = tripzMessageParamsSchema.parse(request.params);
    const result = await repository.retryUserMessage(scope, id, messageId);
    if (dependencies.onMessageCreated) {
      try {
        await dependencies.onMessageCreated({
          scope,
          conversationId: id,
          message: result.message,
          attachmentIds: result.attachmentIds,
          reused: result.reused
        });
      } catch (error) {
        request.log.error({ component: "TripzAI", action: "message_retry_dispatch_failed",
          tenantId: scope.tenantId, conversationId: id, messageId,
          errorName: error instanceof Error ? error.name : "UnknownError" },
        "[TripzAI] message retry dispatch failed");
        throw responseError(503, "TRIPZ_PROCESSING_UNAVAILABLE", "Nova tentativa salva; processamento temporariamente indisponível");
      }
    }
    return reply.status(202).send({ message: result.message, reused: result.reused });
  });

  app.post("/tripz-ai/conversations/:id/attachments", {
    bodyLimit: 20 * 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.tripzUpload }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const headers = tripzAttachmentUploadHeadersSchema.parse(request.headers);
    if (!Buffer.isBuffer(request.body)) {
      throw responseError(400, "TRIPZ_FILE_BODY_INVALID", "Envie o arquivo como corpo binário");
    }
    const result = await fileStore.upload(scope, {
      conversationId: id,
      fileName: headers["x-tripz-file-name"] ?? headers["x-file-name"]!,
      mimeType: headers["content-type"],
      data: request.body
    });
    request.log.info({ component: "TripzAI", action: result.reused ? "attachment_reused" : "attachment_uploaded",
      tenantId: scope.tenantId, conversationId: id, attachmentId: result.attachment.id,
      mimeType: result.attachment.mimeType, sizeBytes: result.attachment.sizeBytes },
    "[TripzAI] attachment stored");
    return reply.status(result.reused ? 200 : 201).send(result);
  });

  app.get("/tripz-ai/conversations/:id/attachments/:attachmentId/content", async (request, reply) => {
    const scope = await access(request);
    const { id, attachmentId } = tripzAttachmentParamsSchema.parse(request.params);
    const content = await fileStore.read(scope, id, attachmentId);
    if (!content) return reply.status(404).send({ error: "Anexo não encontrado" });
    return reply
      .header("content-type", content.attachment.mimeType)
      .header("content-length", content.data.length)
      .header("content-disposition", tripzContentDisposition(content.attachment.fileName))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(content.data);
  });

  app.delete("/tripz-ai/conversations/:id/attachments/:attachmentId", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id, attachmentId } = tripzAttachmentParamsSchema.parse(request.params);
    if (!await fileStore.remove(scope, id, attachmentId)) {
      return reply.status(404).send({ error: "Anexo não encontrado" });
    }
    return reply.status(204).send();
  });

  app.get("/tripz-ai/conversations/:id/proposal", async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const proposal = await repository.getProposal(scope, id);
    if (!proposal) return reply.status(404).send({ error: "Proposta não encontrada" });
    return { proposal };
  });

  app.patch("/tripz-ai/conversations/:id/proposal", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const body = tripzProposalPatchRequestSchema.parse(request.body);
    const proposal = await repository.patchProposal(scope, {
      conversationId: id,
      expectedRevision: body.expectedRevision,
      patch: body.patch
    });
    request.log.info({ component: "TripzAI", action: "proposal_updated", tenantId: scope.tenantId,
      conversationId: id, proposalRevision: proposal.revision }, "[TripzAI] proposal updated");
    return { proposal };
  });

  app.post("/tripz-ai/conversations/:id/preview", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzExport }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const { expectedRevision } = tripzGenerateDocumentSchema.parse(request.body);
    if (!dependencies.renderPreview) {
      throw responseError(503, "TRIPZ_PREVIEW_UNAVAILABLE", "Geração de prévia não configurada");
    }
    const proposal = await repository.getProposal(scope, id);
    if (!proposal) throw tripzNotFound("Proposta não encontrada");
    if (proposal.revision !== expectedRevision) {
      throw responseError(409, "TRIPZ_REVISION_CONFLICT", "A proposta foi alterada; recarregue antes de gerar");
    }
    rendererReady(proposal, "preview");
    const rendered = await dependencies.renderPreview({ scope, conversationId: id, proposal });
    const document = await repository.saveGeneratedDocument(scope, {
      conversationId: id,
      expectedRevision,
      kind: "preview",
      rendererVersion: rendered.rendererVersion,
      data: rendered.html
    });
    return reply.status(201).send({ document, html: rendered.html });
  });

  app.post("/tripz-ai/conversations/:id/pdf", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzExport }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const { expectedRevision } = tripzGenerateDocumentSchema.parse(request.body);
    if (!dependencies.renderPdf) {
      throw responseError(503, "TRIPZ_PDF_UNAVAILABLE", "Geração de PDF não configurada");
    }
    const detail = await repository.getConversationDetail(scope, id);
    const proposal = detail?.proposal;
    if (!proposal) throw tripzNotFound("Proposta não encontrada");
    if (proposal.revision !== expectedRevision) {
      throw responseError(409, "TRIPZ_REVISION_CONFLICT", "A proposta foi alterada; recarregue antes de gerar");
    }
    rendererReady(proposal, "pdf");
    if (!detail.documents.some((document) =>
      document.kind === "preview" && document.proposalRevision === expectedRevision
    )) {
      throw responseError(409, "TRIPZ_PREVIEW_REQUIRED", "Gere e revise a prévia desta versão antes do PDF");
    }
    const rendered = await dependencies.renderPdf({ scope, conversationId: id, proposal });
    const document = await repository.saveGeneratedDocument(scope, {
      conversationId: id,
      expectedRevision,
      kind: "pdf",
      rendererVersion: rendered.rendererVersion,
      data: rendered.data
    });
    return reply.status(201).send({
      document,
      downloadUrl: `/tripz-ai/conversations/${id}/documents/${document.id}/content`
    });
  });

  app.get("/tripz-ai/conversations/:id/documents/:documentId/content", async (request, reply) => {
    const scope = await access(request);
    const { id, documentId } = tripzDocumentParamsSchema.parse(request.params);
    const content = await repository.getDocumentContent(scope, id, documentId);
    if (!content) return reply.status(404).send({ error: "Documento não encontrado" });
    const extension = content.document.kind === "pdf" ? "pdf" : "html";
    return reply
      .header("content-type", content.document.mimeType)
      .header("content-length", content.document.sizeBytes)
      .header("content-disposition", tripzContentDisposition(`tripz-proposta.${extension}`,
        content.document.kind === "pdf" ? "attachment" : "inline"))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(content.data);
  });

  /* ---- editorial: brand settings por tenant (0196) ---- */

  app.get("/tripz-ai/brand-settings", async (request) => {
    const scope = await access(request);
    const config = await getBrandSettings(tripzBrandDatabase(repository), scope.tenantId);
    return { config };
  });

  app.put("/tripz-ai/brand-settings", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request) => {
    const scope = await access(request);
    // A marca vale para o tenant inteiro (todo PDF enviado a clientes): só quem gerencia a Tripz IA.
    if (!scope.canManage) throw new TripzAiError(403, "TRIPZ_PERMISSION_DENIED", "Somente quem gerencia a Tripz IA pode alterar a marca");
    tripzBrandSettingsPutSchema.parse(request.body);
    const config = await upsertTripzBrandSettings(tripzBrandDatabase(repository), scope.tenantId, (request.body as { config?: unknown }).config);
    request.log.info({ component: "TripzAI", action: "brand_settings_saved", tenantId: scope.tenantId }, "[TripzAI] brand settings saved");
    return { config };
  });

  /* ---- editorial: validação, finalize e versionamento ---- */

  app.post("/tripz-ai/conversations/:id/validate", async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const proposal = await repository.getProposal(scope, id);
    if (!proposal) throw tripzNotFound("Proposta não encontrada");
    const validation = validateTripzProposal(proposal.state);
    const critical = validation.issues.filter((issue) => issue.severity === "critical");
    return {
      missingInformation: validation.missingInformation,
      issues: validation.issues,
      canFinalize: critical.length === 0 && proposal.state.status === "ready_for_pdf"
    };
  });

  app.post("/tripz-ai/conversations/:id/finalize", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const body = tripzFinalizeSchema.parse(request.body ?? {});
    const proposal = await repository.getProposal(scope, id);
    if (!proposal) throw tripzNotFound("Proposta não encontrada");
    if (proposal.state.finalized) {
      throw responseError(409, "TRIPZ_ALREADY_FINALIZED", "A proposta já está finalizada; reverta ou crie uma nova versão");
    }
    const validation = validateTripzProposal(proposal.state);
    if (validation.issues.some((issue) => issue.severity === "critical")) {
      throw responseError(409, "TRIPZ_CRITICAL_ISSUES", "Resolva as inconsistências críticas antes de finalizar");
    }
    const version = await repository.saveProposalVersion(scope, {
      conversationId: id,
      ...(body.label ? { label: body.label } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      state: proposal.state,
      documentRevision: proposal.revision,
      approvedByUserId: scope.userId
    });
    const updated = await repository.patchProposal(scope, {
      conversationId: id,
      expectedRevision: proposal.revision,
      patch: { finalized: true }
    });
    request.log.info({ component: "TripzAI", action: "proposal_finalized", tenantId: scope.tenantId,
      conversationId: id, versionNumber: version.versionNumber }, "[TripzAI] proposal finalized");
    return { version, proposal: updated };
  });

  app.get("/tripz-ai/conversations/:id/versions", async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const versions = await repository.listProposalVersions(scope, id);
    return { versions };
  });

  /** Reverter = criar NOVA versão com o estado antigo (nunca sobrescreve a aprovada). */
  app.post("/tripz-ai/conversations/:id/versions", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const body = tripzProposalVersionRevertSchema.parse(request.body ?? {});
    const proposal = await repository.getProposal(scope, id);
    if (!proposal) throw tripzNotFound("Proposta não encontrada");
    const versions = await repository.listProposalVersions(scope, id);
    const target = versions.find((version) => version.id === body.versionId);
    if (!target) throw tripzNotFound("Versão não encontrada");
    const reverted = await repository.saveProposalVersion(scope, {
      conversationId: id,
      label: `Reversão da V${target.versionNumber}`,
      notes: target.label ? `Estado restaurado de "${target.label}"` : `Estado restaurado da versão V${target.versionNumber}`,
      state: target.state,
      documentRevision: proposal.revision,
      approvedByUserId: scope.userId
    });
    const updated = await repository.patchProposal(scope, {
      conversationId: id,
      expectedRevision: proposal.revision,
      patch: { ...target.state, finalized: target.state.finalized ?? false } as TripzProposalPatch
    });
    request.log.info({ component: "TripzAI", action: "proposal_version_reverted", tenantId: scope.tenantId,
      conversationId: id, fromVersion: target.versionNumber }, "[TripzAI] proposal version reverted");
    return { version: reverted, proposal: updated };
  });

  /* ---- editorial: media-from-url com guard de SSRF ---- */

  app.post("/tripz-ai/conversations/:id/media/from-url", {
    config: { rateLimit: HTTP_RATE_LIMITS.tripzWrite }
  }, async (request, reply) => {
    const scope = await access(request);
    const { id } = tripzConversationParamsSchema.parse(request.params);
    const body = tripzMediaFromUrlSchema.parse(request.body);
    // SSRF: HTTPS apenas, DNS pinado no socket (nome que resolve para IP
    // interno é recusado), 3xx não seguido e corpo cortado em 8 MB no stream.
    let downloaded: PublicHttpsDownload;
    try {
      downloaded = await downloadMedia(body.url, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 15_000,
        headers: { "user-agent": "AtendON-TripzMedia/1.0" }
      });
    } catch (error) {
      if (error instanceof OutboundUrlError) {
        throw responseError(400, "TRIPZ_MEDIA_URL_PRIVATE", "A URL precisa ser HTTPS pública");
      }
      if (error instanceof OutboundDownloadTooLargeError) {
        throw responseError(413, "TRIPZ_MEDIA_URL_SIZE", "A imagem excede o limite de 8 MB");
      }
      throw responseError(400, "TRIPZ_MEDIA_URL_FETCH", "Não foi possível baixar a imagem");
    }
    if (downloaded.status < 200 || downloaded.status >= 300) {
      throw responseError(400, "TRIPZ_MEDIA_URL_FETCH", "Não foi possível baixar a imagem");
    }
    const mimeType = downloaded.contentType.split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
      throw responseError(400, "TRIPZ_MEDIA_URL_TYPE", "A URL deve apontar para uma imagem jpeg/png/webp");
    }
    const buffer = downloaded.body;
    if (buffer.length === 0) {
      throw responseError(400, "TRIPZ_MEDIA_URL_FETCH", "Não foi possível baixar a imagem");
    }
    const fileName = body.label
      ? `${body.label.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 80)}${extensionForMime(mimeType)}`
      : `imagem${extensionForMime(mimeType)}`;
    const { attachment } = await repository.createAttachment(scope, {
      conversationId: id,
      fileName,
      mimeType,
      extension: extensionForMime(mimeType).replace(".", ""),
      data: buffer,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      metadata: {
        source: { kind: "url", url: body.url },
        category: body.category,
        ...(body.label ? { label: body.label } : {})
      }
    });
    return reply.status(201).send({
      mediaId: attachment.id,
      attachmentId: attachment.id,
      mimeType,
      sizeBytes: buffer.length,
      category: body.category,
      ...(body.label ? { label: body.label } : {})
    });
  });
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

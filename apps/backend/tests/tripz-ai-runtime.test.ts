import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createEmptyTripzProposalState,
  TripzAiError,
  type TripzAccessScope,
  type TripzConversationDetail,
  type TripzMessage,
  type TripzProposal
} from "../src/modules/tripz-ai/domain.js";
import type { TripzConversationOrchestrator } from "../src/modules/tripz-ai/ai/orchestrator.js";
import type { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import { TripzAiTurnProcessor } from "../src/modules/tripz-ai/runtime.js";

function fixture() {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const now = new Date().toISOString();
  const scope: TripzAccessScope = { tenantId, userId, canManage: false };
  const state = {
    ...createEmptyTripzProposalState(),
    destination: "Aruba",
    itinerary: [{ dayNumber: 1, title: "Chegada" }],
    status: "ready_for_review" as const
  };
  const proposal: TripzProposal = {
    id: randomUUID(), conversationId, schemaVersion: 1, revision: 2, state,
    createdAt: now, updatedAt: now
  };
  const message: TripzMessage = {
    id: messageId, conversationId, role: "user", content: "Monte a proposta",
    metadata: {}, processingStatus: "queued", proposalRevisionBefore: 2,
    proposalRevisionAfter: null, createdAt: now, updatedAt: now
  };
  const detail: TripzConversationDetail = {
    conversation: {
      id: conversationId, title: "Aruba", status: "ready_for_review", summary: null,
      stateRevision: 2, processingStatus: "queued", processingErrorCode: null,
      createdByUserId: userId, createdAt: now, updatedAt: now
    },
    proposal,
    messages: [message],
    attachments: [],
    documents: []
  };
  return { scope, conversationId, messageId, proposal, message, detail };
}

describe("TripzAiTurnProcessor", () => {
  it("revalidates access before processing and atomically completes the persisted turn", async () => {
    const item = fixture();
    const refreshedScope = { ...item.scope, canManage: true };
    const repository = {
      getConversationDetail: vi.fn().mockResolvedValue(item.detail),
      markMessageProcessing: vi.fn().mockResolvedValue(true),
      listMessageAttachmentIds: vi.fn().mockResolvedValue([]),
      getUsageBudget: vi.fn().mockResolvedValue({ providerRequests: 1, inputTokens: 20, outputTokens: 5, costUsd: 0.01 }),
      getAttachmentContent: vi.fn(),
      updateAttachmentProcessing: vi.fn().mockResolvedValue(true),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      completeAiTurn: vi.fn().mockResolvedValue({
        proposal: { ...item.proposal, revision: 3 },
        assistantMessage: { ...item.message, id: randomUUID(), role: "assistant" }
      })
    } as unknown as TripzAiRepository;
    const processTurn = vi.fn().mockResolvedValue({
      assistantMessage: "Resumo pronto.",
      summary: "Aruba com roteiro.",
      proposal: item.proposal.state,
      validation: { proposal: item.proposal.state, missingInformation: [], issues: [], canGenerate: true, blockingReasons: [] },
      requestedAction: "none",
      documentGenerationAllowed: false,
      rejectedChanges: [],
      usage: { model: "test/model", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, providerRequestIndex: 1 },
      budget: { providerRequests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      fileAnnotations: []
    });
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: vi.fn().mockResolvedValue(refreshedScope),
      createOrchestrator: () => ({ processTurn } as unknown as TripzConversationOrchestrator)
    });

    await expect(processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: []
    })).resolves.toBe("completed");
    expect(repository.getConversationDetail).toHaveBeenCalledWith(refreshedScope, item.conversationId);
    expect(repository.completeAiTurn).toHaveBeenCalledWith(refreshedScope, expect.objectContaining({
      userMessageId: item.messageId,
      expectedRevision: 2,
      assistantMessage: "Resumo pronto."
    }));
    expect(processTurn).toHaveBeenCalledWith(expect.objectContaining({
      budget: { providerRequests: 1, inputTokens: 20, outputTokens: 5, costUsd: 0.01 }
    }));
  });

  it("correlates same-name PDFs by attachment id and flags unclassified images for review", async () => {
    const item = fixture();
    const imageId = randomUUID();
    const firstPdfId = randomUUID();
    const secondPdfId = randomUUID();
    const cachedPdfId = randomUUID();
    const now = new Date().toISOString();
    const stored = new Map<string, { fileName: string; mimeType: string; extension: string; extractedText?: string }>([
      [imageId, { fileName: "hotel.png", mimeType: "image/png", extension: "png" }],
      [firstPdfId, { fileName: "dados.pdf", mimeType: "application/pdf", extension: "pdf" }],
      [secondPdfId, { fileName: "dados.pdf", mimeType: "application/pdf", extension: "pdf" }],
      [cachedPdfId, {
        fileName: "cache.pdf",
        mimeType: "application/pdf",
        extension: "pdf",
        extractedText: "Texto já extraído"
      }]
    ]);
    const repository = {
      getConversationDetail: vi.fn().mockResolvedValue(item.detail),
      markMessageProcessing: vi.fn().mockResolvedValue(true),
      listMessageAttachmentIds: vi.fn().mockResolvedValue([imageId, firstPdfId, secondPdfId, cachedPdfId]),
      getUsageBudget: vi.fn().mockResolvedValue({ providerRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      getAttachmentContent: vi.fn().mockImplementation(async (_scope: unknown, _conversationId: string, attachmentId: string) => {
        const file = stored.get(attachmentId);
        if (!file) return null;
        return {
          attachment: {
            id: attachmentId,
            conversationId: item.conversationId,
            messageId: item.messageId,
            fileName: file.fileName,
            mimeType: file.mimeType,
            extension: file.extension,
            sizeBytes: 4,
            contentHash: "a".repeat(64),
            processingStatus: "pending",
            metadata: {},
            createdAt: now,
            updatedAt: now
          },
          data: Buffer.from("test"),
          ...(file.extractedText ? { extractedText: file.extractedText } : {})
        };
      }),
      updateAttachmentProcessing: vi.fn().mockResolvedValue(true),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      completeAiTurn: vi.fn().mockResolvedValue({
        proposal: { ...item.proposal, revision: 3 },
        assistantMessage: { ...item.message, id: randomUUID(), role: "assistant" }
      })
    } as unknown as TripzAiRepository;
    const processTurn = vi.fn().mockImplementation(async (input: {
      attachments: Array<{ attachmentId: string; fileName: string; base64?: string; extractedText?: string }>;
    }) => {
      const firstPdf = input.attachments.find((attachment) => attachment.attachmentId === firstPdfId)!;
      const secondPdf = input.attachments.find((attachment) => attachment.attachmentId === secondPdfId)!;
      expect(firstPdf.fileName).not.toBe(secondPdf.fileName);
      expect(firstPdf.fileName).toContain(firstPdfId);
      expect(secondPdf.fileName).toContain(secondPdfId);
      expect(firstPdf).toMatchObject({ base64: Buffer.from("test").toString("base64") });
      expect(firstPdf).not.toHaveProperty("extractedText");
      const cachedPdf = input.attachments.find((attachment) => attachment.attachmentId === cachedPdfId);
      expect(cachedPdf).toMatchObject({ extractedText: "Texto já extraído" });
      expect(cachedPdf).not.toHaveProperty("base64");
      return {
        assistantMessage: "Materiais analisados.",
        summary: "Aruba com anexos.",
        proposal: item.proposal.state,
        validation: { proposal: item.proposal.state, missingInformation: [], issues: [], canGenerate: true, blockingReasons: [] },
        requestedAction: "none",
        documentGenerationAllowed: false,
        rejectedChanges: [],
        usage: { model: "test/model", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, providerRequestIndex: 1 },
        budget: { providerRequests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
        fileAnnotations: [
          { type: "file", file: { hash: "first", name: firstPdf.fileName, content: [{ type: "text", text: "Texto do primeiro PDF" }] } },
          { type: "file", file: { hash: "second", name: secondPdf.fileName, content: [{ type: "text", text: "Texto do segundo PDF" }] } }
        ]
      };
    });
    const extractPdfText = vi.fn().mockResolvedValue(undefined);
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: async (scope) => scope,
      createOrchestrator: () => ({ processTurn } as unknown as TripzConversationOrchestrator),
      extractPdfText
    });

    await processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: [imageId, firstPdfId, secondPdfId, cachedPdfId]
    });
    expect(repository.completeAiTurn).toHaveBeenCalledWith(item.scope, expect.objectContaining({
      attachmentResults: expect.arrayContaining([
        expect.objectContaining({ attachmentId: imageId, status: "needs_review" }),
        expect.objectContaining({ attachmentId: firstPdfId, status: "processed", extractedText: "Texto do primeiro PDF" }),
        expect.objectContaining({ attachmentId: secondPdfId, status: "processed", extractedText: "Texto do segundo PDF" }),
        expect.objectContaining({ attachmentId: cachedPdfId, status: "processed", extractedText: "Texto já extraído" })
      ])
    }));
    expect(repository.updateAttachmentProcessing).toHaveBeenCalledWith(item.scope, expect.objectContaining({
      attachmentId: firstPdfId,
      status: "processing",
      extractedText: "Texto do primeiro PDF"
    }));
    expect(extractPdfText).toHaveBeenCalledTimes(2);
  });

  it("persists local PDF text before the provider boundary and reuses cached text without reparsing", async () => {
    const item = fixture();
    const localPdfId = randomUUID();
    const cachedPdfId = randomUUID();
    const now = new Date().toISOString();
    const stored = new Map<string, { fileName: string; extractedText?: string }>([
      [localPdfId, { fileName: "local.pdf", extractedText: undefined }],
      [cachedPdfId, { fileName: "cache.pdf", extractedText: "Texto persistido" }]
    ]);
    const repository = {
      getConversationDetail: vi.fn().mockResolvedValue(item.detail),
      markMessageProcessing: vi.fn().mockResolvedValue(true),
      listMessageAttachmentIds: vi.fn().mockResolvedValue([localPdfId, cachedPdfId]),
      getUsageBudget: vi.fn().mockResolvedValue({ providerRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      getAttachmentContent: vi.fn().mockImplementation(async (_scope: unknown, _conversationId: string, attachmentId: string) => {
        const file = stored.get(attachmentId);
        if (!file) return null;
        const data = Buffer.from("%PDF-1.7\n%%EOF", "latin1");
        return {
          attachment: {
            id: attachmentId,
            conversationId: item.conversationId,
            messageId: item.messageId,
            fileName: file.fileName,
            mimeType: "application/pdf",
            extension: "pdf",
            sizeBytes: data.length,
            contentHash: "b".repeat(64),
            processingStatus: "pending",
            metadata: { pageCountHint: 1 },
            createdAt: now,
            updatedAt: now
          },
          data,
          ...(file.extractedText ? { extractedText: file.extractedText } : {})
        };
      }),
      updateAttachmentProcessing: vi.fn().mockResolvedValue(true),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      completeAiTurn: vi.fn().mockResolvedValue({
        proposal: { ...item.proposal, revision: 3 },
        assistantMessage: { ...item.message, id: randomUUID(), role: "assistant" }
      })
    } as unknown as TripzAiRepository;
    const processTurn = vi.fn().mockImplementation(async (input: {
      attachments: Array<{ attachmentId: string; base64?: string; extractedText?: string }>;
    }) => {
      expect(input.attachments).toEqual(expect.arrayContaining([
        expect.objectContaining({ attachmentId: localPdfId, extractedText: "Texto extraído localmente" }),
        expect.objectContaining({ attachmentId: cachedPdfId, extractedText: "Texto persistido" })
      ]));
      expect(input.attachments.every((attachment) => attachment.base64 === undefined)).toBe(true);
      return {
        assistantMessage: "PDFs analisados.",
        summary: "Aruba com PDFs.",
        proposal: item.proposal.state,
        validation: { proposal: item.proposal.state, missingInformation: [], issues: [], canGenerate: true, blockingReasons: [] },
        requestedAction: "none",
        documentGenerationAllowed: false,
        rejectedChanges: [],
        usage: { model: "test/model", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, providerRequestIndex: 1 },
        budget: { providerRequests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
        fileAnnotations: []
      };
    });
    const extractPdfText = vi.fn().mockResolvedValue("Texto extraído localmente");
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: async (scope) => scope,
      createOrchestrator: () => ({ processTurn } as unknown as TripzConversationOrchestrator),
      extractPdfText
    });

    await processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: [localPdfId, cachedPdfId]
    });

    expect(extractPdfText).toHaveBeenCalledTimes(1);
    expect(repository.updateAttachmentProcessing).toHaveBeenCalledWith(item.scope, {
      conversationId: item.conversationId,
      attachmentId: localPdfId,
      status: "processing",
      extractedText: "Texto extraído localmente"
    });
    expect(repository.completeAiTurn).toHaveBeenCalledWith(item.scope, expect.objectContaining({
      attachmentResults: expect.arrayContaining([
        expect.objectContaining({ attachmentId: localPdfId, extractedText: "Texto extraído localmente" }),
        expect.objectContaining({ attachmentId: cachedPdfId, extractedText: "Texto persistido" })
      ])
    }));
  });

  it("stops before loading state or calling OpenRouter when the kill switch/access guard denies the job", async () => {
    const item = fixture();
    const repository = { getConversationDetail: vi.fn() } as unknown as TripzAiRepository;
    const createOrchestrator = vi.fn();
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: async () => { throw new TripzAiError(409, "FEATURE_FLAG_DISABLED", "Tripz IA desabilitada"); },
      createOrchestrator
    });
    await expect(processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: []
    })).rejects.toMatchObject({ code: "FEATURE_FLAG_DISABLED" });
    expect(repository.getConversationDetail).not.toHaveBeenCalled();
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it("does not cross the provider boundary when another worker already claimed the turn", async () => {
    const item = fixture();
    const repository = {
      getConversationDetail: vi.fn().mockResolvedValue(item.detail),
      markMessageProcessing: vi.fn().mockResolvedValue(false)
    } as unknown as TripzAiRepository;
    const createOrchestrator = vi.fn();
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: async (scope) => scope,
      createOrchestrator
    });
    await expect(processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: []
    })).resolves.toBe("already_claimed");
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it("rejects an incomplete attachment job before reading private bytes or calling the provider", async () => {
    const item = fixture();
    const linkedAttachmentId = randomUUID();
    const repository = {
      getConversationDetail: vi.fn().mockResolvedValue(item.detail),
      markMessageProcessing: vi.fn().mockResolvedValue(true),
      listMessageAttachmentIds: vi.fn().mockResolvedValue([linkedAttachmentId]),
      getUsageBudget: vi.fn(),
      getAttachmentContent: vi.fn()
    } as unknown as TripzAiRepository;
    const createOrchestrator = vi.fn();
    const processor = new TripzAiTurnProcessor(repository, {
      authorizeScope: async (scope) => scope,
      createOrchestrator
    });
    await expect(processor.process({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: []
    })).rejects.toMatchObject({ code: "TRIPZ_ATTACHMENT_SET_MISMATCH", statusCode: 400 });
    expect(repository.getUsageBudget).not.toHaveBeenCalled();
    expect(repository.getAttachmentContent).not.toHaveBeenCalled();
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it("persists a safe terminal error for the message and its attachments", async () => {
    const item = fixture();
    const attachmentId = randomUUID();
    const repository = {
      markTurnTerminalFailure: vi.fn().mockResolvedValue(true)
    } as unknown as TripzAiRepository;
    const processor = new TripzAiTurnProcessor(repository, { authorizeScope: async (scope) => scope });
    await processor.markTerminalFailure({
      scope: item.scope,
      conversationId: item.conversationId,
      messageId: item.messageId,
      attachmentIds: [attachmentId]
    }, new Error("conteúdo sensível"));
    expect(repository.markTurnTerminalFailure).toHaveBeenCalledWith({
      tenantId: item.scope.tenantId,
      conversationId: item.conversationId,
      messageId: item.messageId,
      errorCode: "TRIPZ_AI_PROCESSING_FAILED"
    });
  });
});

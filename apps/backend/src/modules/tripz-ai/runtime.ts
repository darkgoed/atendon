import { logger } from "../../logger.js";
import type { TripzAiTurnJob } from "../../queue/tripz-ai-queue.js";
import { TripzAiError, type TripzAttachmentProcessingStatus } from "./domain.js";
import {
  parseTripzOpenRouterConfig,
  TripzConversationOrchestrator,
  TripzOpenRouterClient,
  type TripzAiAttachmentContent,
  type TripzAiTurnResult
} from "./ai/index.js";
import {
  extractTripzPdfTextLocally,
  type TripzPdfTextExtractionInput
} from "./pdf-text-extractor.js";
import { TripzAiRepository } from "./repository.js";

export interface TripzAiTurnProcessorDependencies {
  authorizeScope: (scope: TripzAiTurnJob["scope"]) => Promise<TripzAiTurnJob["scope"]>;
  createOrchestrator?: () => TripzConversationOrchestrator;
  extractPdfText?: (input: TripzPdfTextExtractionInput) => Promise<string | undefined>;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof TripzAiError) return error.code;
  return "TRIPZ_AI_PROCESSING_FAILED";
}

function extractedPdfText(
  annotations: TripzAiTurnResult["fileAnnotations"],
  fileName: string
): string | undefined {
  const normalizedName = fileName.normalize("NFKC").toLocaleLowerCase("pt-BR");
  const annotation = annotations.find((item) =>
    item.file.name?.normalize("NFKC").toLocaleLowerCase("pt-BR") === normalizedName
  );
  const extracted = annotation?.file.content?.flatMap((part) =>
    part.type === "text" && part.text.trim() ? [part.text.trim()] : []
  ).join("\n\n").slice(0, 200_000);
  return extracted || undefined;
}

export class TripzAiTurnProcessor {
  private orchestrator?: TripzConversationOrchestrator;

  constructor(
    private readonly repository: TripzAiRepository,
    private readonly dependencies: TripzAiTurnProcessorDependencies
  ) {}

  private getOrchestrator(): TripzConversationOrchestrator {
    if (this.orchestrator) return this.orchestrator;
    if (this.dependencies.createOrchestrator) {
      this.orchestrator = this.dependencies.createOrchestrator();
      return this.orchestrator;
    }
    const parsed = parseTripzOpenRouterConfig(process.env);
    const client = new TripzOpenRouterClient(parsed, { logger });
    this.orchestrator = new TripzConversationOrchestrator(client, {
      contextBudgetCharacters: parsed.maxContextCharacters,
      maxHistoryMessages: 12
    });
    return this.orchestrator;
  }

  async process(job: TripzAiTurnJob): Promise<string> {
    const scope = await this.dependencies.authorizeScope(job.scope);
    const detail = await this.repository.getConversationDetail(scope, job.conversationId);
    if (!detail) throw new TripzAiError(404, "TRIPZ_NOT_FOUND", "Conversa não encontrada");
    const userMessage = detail.messages.find((message) => message.id === job.messageId && message.role === "user");
    if (!userMessage) throw new TripzAiError(404, "TRIPZ_MESSAGE_NOT_FOUND", "Mensagem não encontrada");
    if (userMessage.processingStatus === "completed") return "already_completed";

    const claimed = await this.repository.markMessageProcessing(scope, {
      conversationId: job.conversationId,
      messageId: job.messageId,
      status: "processing"
    });
    if (!claimed) return "already_claimed";
    const persistedAttachmentIds = (await this.repository.listMessageAttachmentIds(scope, {
      conversationId: job.conversationId,
      messageId: job.messageId
    })).sort();
    const requestedAttachmentIds = [...new Set(job.attachmentIds)].sort();
    if (requestedAttachmentIds.length !== job.attachmentIds.length
      || requestedAttachmentIds.length !== persistedAttachmentIds.length
      || requestedAttachmentIds.some((id, index) => id !== persistedAttachmentIds[index])) {
      throw new TripzAiError(400, "TRIPZ_ATTACHMENT_SET_MISMATCH", "Os anexos do turno não correspondem à mensagem persistida");
    }
    const budget = await this.repository.getUsageBudget(scope, {
      conversationId: job.conversationId,
      messageId: job.messageId
    });
    const attachments: TripzAiAttachmentContent[] = [];
    for (const attachmentId of requestedAttachmentIds) {
      const stored = await this.repository.getAttachmentContent(scope, job.conversationId, attachmentId);
      if (!stored || stored.attachment.messageId !== job.messageId) {
        throw new TripzAiError(400, "TRIPZ_ATTACHMENT_INVALID", "Anexo da mensagem não encontrado");
      }
      await this.repository.updateAttachmentProcessing(scope, {
        conversationId: job.conversationId,
        attachmentId,
        status: "processing"
      });
      const extractedText = stored.attachment.mimeType === "application/pdf"
        ? stored.extractedText ?? await (this.dependencies.extractPdfText ?? extractTripzPdfTextLocally)({
          data: stored.data,
          mimeType: stored.attachment.mimeType,
          sizeBytes: stored.attachment.sizeBytes,
          metadata: stored.attachment.metadata
        })
        : undefined;
      if (!stored.extractedText && extractedText) {
        // Persist before the paid/provider boundary so a failed or retried turn
        // never parses the same private textual PDF again.
        await this.repository.updateAttachmentProcessing(scope, {
          conversationId: job.conversationId,
          attachmentId,
          status: "processing",
          extractedText
        });
      }
      attachments.push({
        attachmentId,
        fileName: `${attachmentId}-${stored.attachment.fileName}`,
        mimeType: stored.attachment.mimeType,
        ...(extractedText
          ? { extractedText }
          : { base64: stored.data.toString("base64") })
      });
    }

    const result = await this.getOrchestrator().processTurn({
      conversationId: job.conversationId,
      userMessage: userMessage.content,
      proposal: detail.proposal.state,
      sessionSummary: detail.conversation.summary,
      recentMessages: detail.messages
        .filter((message) => message.id !== userMessage.id && message.content.trim())
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.content })),
      attachments,
      budget,
      onUsage: (usage) => this.repository.recordUsage(scope, {
        conversationId: job.conversationId,
        messageId: job.messageId,
        purpose: attachments.length ? "attachment" : "conversation",
        model: usage.model,
        provider: usage.provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        durationMs: usage.durationMs,
        requestIndex: usage.providerRequestIndex
      })
    });

    const attachmentResults = attachments.map((attachment) => {
      const media = result.proposal.media.find((item) => item.attachmentId === attachment.attachmentId);
      const extractedText = attachment.mimeType === "application/pdf"
        ? attachment.extractedText ?? extractedPdfText(result.fileAnnotations, attachment.fileName)
        : undefined;
      const status: TripzAttachmentProcessingStatus = attachment.mimeType === "application/pdf"
        ? extractedText ? "processed" : "needs_review"
        : media?.confidence !== undefined && media.confidence >= 0.6 ? "processed" : "needs_review";
      return {
        attachmentId: attachment.attachmentId,
        status,
        ...(extractedText ? { extractedText } : {}),
        metadata: {
          ...(media ? { category: media.category, label: media.label, confidence: media.confidence } : {}),
          processedBy: "tripz_ai"
        }
      };
    });

    // Cache parser output before the atomic proposal commit. If that commit conflicts or the
    // worker is interrupted, the next automatic/manual attempt reuses the private extraction.
    for (const attachment of attachmentResults) {
      const inputAttachment = attachments.find((item) => item.attachmentId === attachment.attachmentId);
      if (!attachment.extractedText || inputAttachment?.extractedText) continue;
      await this.repository.updateAttachmentProcessing(scope, {
        conversationId: job.conversationId,
        attachmentId: attachment.attachmentId,
        status: "processing",
        extractedText: attachment.extractedText
      });
    }

    const completed = await this.repository.completeAiTurn(scope, {
      conversationId: job.conversationId,
      userMessageId: job.messageId,
      expectedRevision: detail.proposal.revision,
      proposal: result.proposal,
      assistantMessage: result.assistantMessage,
      summary: result.summary,
      attachmentResults
    });
    logger.info({
      component: "TripzAI",
      action: "turn_completed",
      tenantId: job.scope.tenantId,
      conversationId: job.conversationId,
      messageId: job.messageId,
      proposalRevision: completed.proposal.revision,
      requestedAction: result.requestedAction,
      documentGenerationAllowed: result.documentGenerationAllowed
    }, "[TripzAI] turn completed");
    return "completed";
  }

  async markTerminalFailure(job: TripzAiTurnJob, error: unknown): Promise<void> {
    const errorCode = safeErrorCode(error);
    await this.repository.markTurnTerminalFailure({
      tenantId: job.scope.tenantId,
      conversationId: job.conversationId,
      messageId: job.messageId,
      errorCode
    });
  }
}

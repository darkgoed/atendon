import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  TripzAiError,
  createEmptyTripzProposalState,
  type TripzAccessScope,
  type TripzAttachment,
  type TripzConversation,
  type TripzConversationDetail,
  type TripzGeneratedDocument,
  type TripzMessage,
  type TripzProposal
} from "../src/modules/tripz-ai/domain.js";
import type {
  TripzAttachmentBinary,
  TripzDocumentContent,
  TripzRepositoryPort
} from "../src/modules/tripz-ai/repository.js";
import { registerTripzAiRoutes } from "../src/modules/tripz-ai/routes.js";
import type { TripzFileStore } from "../src/modules/tripz-ai/storage.js";

const now = new Date().toISOString();
const conversationId = randomUUID();
const proposalId = randomUUID();
const messageId = randomUUID();
const attachmentId = randomUUID();
const documentId = randomUUID();
const scope: TripzAccessScope = { tenantId: randomUUID(), userId: randomUUID(), canManage: false };

const conversation: TripzConversation = {
  id: conversationId,
  title: "Aruba",
  status: "ready_for_pdf",
  summary: null,
  stateRevision: 2,
  processingStatus: "idle",
  processingErrorCode: null,
  createdByUserId: scope.userId,
  createdAt: now,
  updatedAt: now
};
const proposal: TripzProposal = {
  id: proposalId,
  conversationId,
  schemaVersion: 1,
  revision: 2,
  state: { ...createEmptyTripzProposalState(), destination: "Aruba", status: "ready_for_pdf" },
  createdAt: now,
  updatedAt: now
};
const message: TripzMessage = {
  id: messageId,
  conversationId,
  role: "user",
  content: "Casal para Aruba",
  metadata: {},
  processingStatus: "queued",
  proposalRevisionBefore: 2,
  proposalRevisionAfter: null,
  createdAt: now,
  updatedAt: now
};
const attachment: TripzAttachment = {
  id: attachmentId,
  conversationId,
  messageId: null,
  fileName: "hotel.png",
  mimeType: "image/png",
  extension: "png",
  sizeBytes: 24,
  contentHash: "a".repeat(64),
  processingStatus: "pending",
  metadata: { width: 2, height: 3 },
  createdAt: now,
  updatedAt: now
};
const document: TripzGeneratedDocument = {
  id: documentId,
  conversationId,
  proposalRevision: 2,
  kind: "preview",
  rendererVersion: "test-v1",
  contentHash: "b".repeat(64),
  sizeBytes: 15,
  mimeType: "text/html; charset=utf-8",
  createdAt: now
};

class FakeRepository implements TripzRepositoryPort {
  createMessageCalls = 0;
  savedKinds: string[] = [];
  documents: TripzGeneratedDocument[] = [];
  proposal = proposal;

  async createConversation(): Promise<TripzConversationDetail> {
    return { conversation, proposal: this.proposal, messages: [], attachments: [], documents: [] };
  }
  async listConversations() { return { items: [conversation], nextCursor: null }; }
  async getConversationDetail() { return { conversation, proposal: this.proposal, messages: [message], attachments: [attachment], documents: this.documents }; }
  async renameConversation(_scope: TripzAccessScope, _conversationId: string, title: string) {
    return { ...conversation, title };
  }
  async deleteConversation() { return true; }
  async listMessages() { return { items: [message], nextCursor: null }; }
  async createUserMessage() { this.createMessageCalls += 1; return { message, reused: false }; }
  async retryUserMessage() { return { message: { ...message, processingStatus: "queued" as const }, attachmentIds: [attachmentId], reused: false }; }
  async getProposal() { return this.proposal; }
  async patchProposal() { return { ...this.proposal, revision: this.proposal.revision + 1 }; }
  async createAttachment() { return { attachment, reused: false }; }
  async getAttachmentContent(): Promise<TripzAttachmentBinary | null> { return { attachment, data: Buffer.alloc(24) }; }
  async deleteAttachment() { return true; }
  async saveGeneratedDocument(_scope: TripzAccessScope, input: { kind: "preview" | "pdf" }) {
    this.savedKinds.push(input.kind);
    const saved = { ...document, kind: input.kind, mimeType: input.kind === "pdf" ? "application/pdf" : document.mimeType };
    this.documents = [...this.documents.filter((item) => item.kind !== input.kind), saved];
    return saved;
  }
  async getDocumentContent(): Promise<TripzDocumentContent | null> { return { document, data: "<p>preview</p>" }; }
  async markTurnTerminalFailure() { return true; }
}

class FakeStore implements TripzFileStore {
  uploadInput: { fileName: string; mimeType: string; data: Buffer } | null = null;
  async upload(_scope: TripzAccessScope, input: { conversationId: string; fileName: string; mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; data: Buffer }) {
    this.uploadInput = input;
    return { attachment, reused: false };
  }
  async read(): Promise<TripzAttachmentBinary | null> { return { attachment, data: Buffer.alloc(24) }; }
  async remove() { return true; }
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(input: {
  repository?: FakeRepository;
  fileStore?: FakeStore;
  featureGate?: () => Promise<void>;
  onMessageCreated?: () => Promise<void>;
  render?: boolean;
} = {}) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => reply
    .status(error instanceof z.ZodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 500))
    .send({
      error: error instanceof Error ? error.message : "Erro interno",
      message: error instanceof Error ? error.message : "Erro interno"
    }));
  const repository = input.repository ?? new FakeRepository();
  const fileStore = input.fileStore ?? new FakeStore();
  await registerTripzAiRoutes(app, {
    repository,
    fileStore,
    authorize: async () => ({ ...scope, actorScope: "workspace", isRoot: false }),
    featureGate: input.featureGate ?? (async () => undefined),
    onMessageCreated: input.onMessageCreated,
    ...(input.render ? {
      renderPreview: async () => ({ html: "<p>preview</p>", rendererVersion: "test-v1" }),
      renderPdf: async () => ({ data: Buffer.from("%PDF-1.7\n%%EOF"), rendererVersion: "test-v1" })
    } : {})
  });
  await app.ready();
  return { app, repository, fileStore };
}

describe("Tripz AI routes", () => {
  it("fails closed at the feature gate before exposing conversations", async () => {
    const repository = new FakeRepository();
    const { app } = await appWith({ repository, featureGate: async () => {
      throw new TripzAiError(409, "FEATURE_FLAG_DISABLED", "Tripz IA desabilitada");
    } });
    const response = await app.inject({ url: "/tripz-ai/conversations" });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe("Tripz IA desabilitada");
  });

  it("receives one raw binary upload with an explicit safe filename header", async () => {
    const fileStore = new FakeStore();
    const { app } = await appWith({ fileStore });
    const payload = Buffer.alloc(24, 1);
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/attachments`,
      headers: { "content-type": "image/png", "x-tripz-file-name": "hotel%20ver%C3%A3o.png" },
      payload
    });
    expect(response.statusCode).toBe(201);
    expect(fileStore.uploadInput).toMatchObject({ fileName: "hotel verão.png", mimeType: "image/png", data: payload });
    expect(response.json()).toMatchObject({ attachment: { id: attachmentId }, reused: false });
  });

  it("requires idempotency for messages and dispatches only after persistence", async () => {
    const dispatched = vi.fn(async () => undefined);
    const { app, repository } = await appWith({ onMessageCreated: dispatched });
    const missing = await app.inject({
      method: "POST", url: `/tripz-ai/conversations/${conversationId}/messages`, payload: { content: "Aruba" }
    });
    expect(missing.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/messages`,
      headers: { "idempotency-key": "tripz-test-0001" },
      payload: { content: "Aruba", attachmentIds: [] }
    });
    expect(response.statusCode).toBe(202);
    expect(repository.createMessageCalls).toBe(1);
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ conversationId, message }));
  });

  it("renames only the authorized conversation with a bounded title", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "PATCH",
      url: `/tripz-ai/conversations/${conversationId}`,
      payload: { title: "Aruba — Lua de mel" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conversation: { id: conversationId, title: "Aruba — Lua de mel" } });
    expect((await app.inject({
      method: "PATCH",
      url: `/tripz-ai/conversations/${conversationId}`,
      payload: { title: " " }
    })).statusCode).toBe(400);
  });

  it("does not let proposal PATCH forge server-owned readiness fields", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "PATCH",
      url: `/tripz-ai/conversations/${conversationId}/proposal`,
      payload: {
        expectedRevision: 2,
        patch: { status: "ready_for_pdf", missingInformation: [], inconsistencies: [] }
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps a saved idempotent message recoverable when dispatch is unavailable", async () => {
    const { app, repository } = await appWith({ onMessageCreated: async () => { throw new Error("queue down"); } });
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/messages`,
      headers: { "idempotency-key": "tripz-test-0002" },
      payload: { content: "Aruba", attachmentIds: [] }
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("queue down");
    expect(repository.createMessageCalls).toBe(1);
  });

  it("requeues a failed persisted turn with its original attachments", async () => {
    const dispatched = vi.fn(async () => undefined);
    const { app } = await appWith({ onMessageCreated: dispatched });
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/messages/${messageId}/retry`
    });
    expect(response.statusCode).toBe(202);
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      attachmentIds: [attachmentId]
    }));
  });

  it("uses injected preview/PDF renderers and persists their exact proposal revision", async () => {
    const { app, repository } = await appWith({ render: true });
    const preview = await app.inject({
      method: "POST", url: `/tripz-ai/conversations/${conversationId}/preview`, payload: { expectedRevision: 2 }
    });
    expect(preview.statusCode).toBe(201);
    expect(preview.json()).toMatchObject({ document: { proposalRevision: 2 }, html: "<p>preview</p>" });
    const pdf = await app.inject({
      method: "POST", url: `/tripz-ai/conversations/${conversationId}/pdf`, payload: { expectedRevision: 2 }
    });
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json().downloadUrl).toContain(documentId);
    expect(repository.savedKinds).toEqual(["preview", "pdf"]);
  });

  it("requires a preview of the current revision before rendering the PDF", async () => {
    const { app, repository } = await appWith({ render: true });
    const pdf = await app.inject({
      method: "POST", url: `/tripz-ai/conversations/${conversationId}/pdf`, payload: { expectedRevision: 2 }
    });
    expect(pdf.statusCode).toBe(409);
    expect(pdf.json().message).toContain("prévia");
    expect(repository.savedKinds).toEqual([]);
  });

  it("blocks generation before review and does not expose a missing foreign asset", async () => {
    const repository = new FakeRepository();
    repository.proposal = { ...proposal, state: { ...proposal.state, status: "collecting" } };
    const fileStore = new FakeStore();
    fileStore.read = async () => null;
    const { app } = await appWith({ repository, fileStore, render: true });
    expect((await app.inject({
      method: "POST", url: `/tripz-ai/conversations/${conversationId}/preview`, payload: { expectedRevision: 2 }
    })).statusCode).toBe(409);
    const content = await app.inject({
      url: `/tripz-ai/conversations/${conversationId}/attachments/${attachmentId}/content`
    });
    expect(content.statusCode).toBe(404);
    expect(content.body).not.toContain(attachmentId);
  });
});

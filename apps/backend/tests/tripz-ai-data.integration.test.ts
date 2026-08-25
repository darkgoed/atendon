import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import type { TripzAccessScope } from "../src/modules/tripz-ai/domain.js";
import { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import { PostgresTripzFileStore } from "../src/modules/tripz-ai/storage.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const repository = new TripzAiRepository(pool);
const fileStore = new PostgresTripzFileStore(repository);

let tenantA = "";
let tenantB = "";
let ownerA = "";
let colleagueA = "";
let ownerB = "";
let ownerScope: TripzAccessScope;
let colleagueScope: TripzAccessScope;
let managerScope: TripzAccessScope;
let foreignScope: TripzAccessScope;

function png(width = 2, height = 3): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data, 0);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

beforeAll(async () => {
  tenantA = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Tripz tenant A ${suffix}`]
  )).rows[0].id;
  tenantB = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Tripz tenant B ${suffix}`]
  )).rows[0].id;
  ownerA = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`tripz-owner-a-${suffix}@test.local`]
  )).rows[0].id;
  colleagueA = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`tripz-colleague-a-${suffix}@test.local`]
  )).rows[0].id;
  ownerB = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`tripz-owner-b-${suffix}@test.local`]
  )).rows[0].id;
  ownerScope = { tenantId: tenantA, userId: ownerA, canManage: false };
  colleagueScope = { tenantId: tenantA, userId: colleagueA, canManage: false };
  managerScope = { tenantId: tenantA, userId: colleagueA, canManage: true };
  foreignScope = { tenantId: tenantB, userId: ownerB, canManage: true };
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerA, colleagueA, ownerB]]);
  await pool.end();
});

describe("Tripz AI tenant-safe persistence", () => {
  it("creates isolated conversations and applies owner/manage visibility to list and detail", async () => {
    const mine = await repository.createConversation(ownerScope, "Aruba");
    const colleague = await repository.createConversation(colleagueScope, "Chile");
    const foreign = await repository.createConversation(foreignScope, "Lisboa");

    expect((await repository.listConversations(ownerScope, { limit: 20 })).items.map((item) => item.id))
      .toEqual([mine.conversation.id]);
    expect(await repository.getConversationDetail(ownerScope, colleague.conversation.id)).toBeNull();
    expect(await repository.getConversationDetail(foreignScope, mine.conversation.id)).toBeNull();
    expect((await repository.listConversations(managerScope, { limit: 20 })).items.map((item) => item.id).sort())
      .toEqual([mine.conversation.id, colleague.conversation.id].sort());
    expect((await repository.getConversationDetail(managerScope, colleague.conversation.id))?.conversation.title)
      .toBe("Chile");
    expect((await repository.renameConversation(ownerScope, mine.conversation.id, "Aruba especial")).title)
      .toBe("Aruba especial");
    await repository.patchProposal(ownerScope, {
      conversationId: mine.conversation.id,
      expectedRevision: 0,
      patch: { destination: "Aruba" }
    });
    expect((await repository.getConversationDetail(ownerScope, mine.conversation.id))?.conversation.title)
      .toBe("Aruba especial");
    await expect(repository.renameConversation(ownerScope, colleague.conversation.id, "Não autorizado"))
      .rejects.toMatchObject({ statusCode: 404, code: "TRIPZ_NOT_FOUND" });

    const malformedCursor = Buffer.from(JSON.stringify({
      timestamp: new Date().toISOString(),
      id: "------------------------------------"
    }), "utf8").toString("base64url");
    await expect(repository.listConversations(ownerScope, { cursor: malformedCursor, limit: 20 }))
      .rejects.toMatchObject({ statusCode: 400, code: "TRIPZ_CURSOR_INVALID" });

    await repository.deleteConversation(managerScope, colleague.conversation.id);
    await repository.deleteConversation(foreignScope, foreign.conversation.id);
    await repository.deleteConversation(ownerScope, mine.conversation.id);
  });

  it("stores verified bytes privately and binds an attachment to one idempotent message", async () => {
    const detail = await repository.createConversation(ownerScope, "Maceió");
    const other = await repository.createConversation(foreignScope, "Foreign");
    const uploaded = await fileStore.upload(ownerScope, {
      conversationId: detail.conversation.id,
      fileName: "hotel.png",
      mimeType: "image/png",
      data: png()
    });
    const duplicate = await fileStore.upload(ownerScope, {
      conversationId: detail.conversation.id,
      fileName: "hotel-copia.png",
      mimeType: "image/png",
      data: png()
    });
    expect(duplicate).toMatchObject({ reused: true, attachment: { id: uploaded.attachment.id } });
    expect(await fileStore.read(colleagueScope, detail.conversation.id, uploaded.attachment.id)).toBeNull();
    expect((await fileStore.read(ownerScope, detail.conversation.id, uploaded.attachment.id))?.data).toEqual(png());
    await expect(repository.updateAttachmentProcessing(colleagueScope, {
      conversationId: detail.conversation.id,
      attachmentId: uploaded.attachment.id,
      status: "processing"
    })).rejects.toMatchObject({ statusCode: 404, code: "TRIPZ_NOT_FOUND" });

    const first = await repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Estas são as fotos do hotel",
      attachmentIds: [uploaded.attachment.id],
      idempotencyKey: "tripz-integration-message-1"
    });
    const replay = await repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Estas são as fotos do hotel",
      attachmentIds: [uploaded.attachment.id],
      idempotencyKey: "tripz-integration-message-1"
    });
    expect(first.reused).toBe(false);
    expect(replay).toMatchObject({ reused: true, message: { id: first.message.id } });
    await expect(repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Conteúdo diferente",
      attachmentIds: [uploaded.attachment.id],
      idempotencyKey: "tripz-integration-message-1"
    })).rejects.toMatchObject({ statusCode: 409, code: "TRIPZ_IDEMPOTENCY_CONFLICT" });
    await expect(fileStore.remove(ownerScope, detail.conversation.id, uploaded.attachment.id))
      .rejects.toMatchObject({ code: "TRIPZ_ATTACHMENT_LINKED" });
    await expect(repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Uma segunda análise concorrente",
      attachmentIds: [],
      idempotencyKey: "tripz-integration-concurrent-turn"
    })).rejects.toMatchObject({ statusCode: 409, code: "TRIPZ_TURN_IN_PROGRESS" });
    await repository.markMessageProcessing(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id,
      status: "processing"
    });
    expect(await repository.markMessageProcessing(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id,
      status: "processing"
    })).toBe(false);
    expect(await repository.listMessageAttachmentIds(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id
    })).toEqual([uploaded.attachment.id]);
    await repository.recordUsage(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id,
      purpose: "attachment",
      model: "test/model",
      inputTokens: 10,
      outputTokens: 4,
      costUsd: 0.01,
      durationMs: 5,
      requestIndex: 1
    });
    await repository.recordUsage(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id,
      purpose: "attachment",
      model: "test/model",
      inputTokens: 8,
      outputTokens: 3,
      costUsd: 0.02,
      durationMs: 4,
      requestIndex: 2
    });
    expect(await repository.getUsageBudget(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: first.message.id
    })).toEqual({ providerRequests: 2, inputTokens: 18, outputTokens: 7, costUsd: 0.03 });
    const completed = await repository.completeAiTurn(ownerScope, {
      conversationId: detail.conversation.id,
      userMessageId: first.message.id,
      expectedRevision: 0,
      proposal: {
        ...detail.proposal.state,
        destination: "Maceió",
        hotel: { name: "Hotel seguro" },
        media: [{
          attachmentId: uploaded.attachment.id,
          category: "hotel_facade",
          sortOrder: 0,
          selectedForPdf: true
        }],
        status: "ready_for_review"
      },
      assistantMessage: "Dados do hotel processados.",
      summary: "Maceió com hospedagem.",
      attachmentResults: [{ attachmentId: uploaded.attachment.id, status: "processed" }]
    });
    expect(completed).toMatchObject({
      proposal: { revision: 1, state: { destination: "Maceió" } },
      assistantMessage: { role: "assistant", processingStatus: "completed" }
    });
    const reuploaded = await fileStore.upload(ownerScope, {
      conversationId: detail.conversation.id,
      fileName: "hotel-reenviado.png",
      mimeType: "image/png",
      data: png()
    });
    expect(reuploaded).toMatchObject({ reused: false });
    expect(reuploaded.attachment.id).not.toBe(uploaded.attachment.id);
    expect(await fileStore.remove(ownerScope, detail.conversation.id, reuploaded.attachment.id)).toBe(true);

    const foreignAttachment = await fileStore.upload(foreignScope, {
      conversationId: other.conversation.id,
      fileName: "foreign.png",
      mimeType: "image/png",
      data: png(4, 5)
    });
    await expect(repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Não pode vincular",
      attachmentIds: [foreignAttachment.attachment.id],
      idempotencyKey: "tripz-integration-message-2"
    })).rejects.toMatchObject({ statusCode: 400, code: "TRIPZ_ATTACHMENT_INVALID" });

    await repository.deleteConversation(foreignScope, other.conversation.id);
    await repository.deleteConversation(ownerScope, detail.conversation.id);
  });

  it("updates proposal with optimistic revision and invalidates stale generated content", async () => {
    const detail = await repository.createConversation(ownerScope, "Foz");
    const media = await fileStore.upload(ownerScope, {
      conversationId: detail.conversation.id,
      fileName: "capa.png",
      mimeType: "image/png",
      data: png(8, 6)
    });
    const updated = await repository.patchProposal(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 0,
      patch: {
        destination: "Foz do Iguaçu",
        notes: ["Roteiro de cinco dias"],
        itinerary: [{ dayNumber: 1, title: "Cataratas" }],
        media: [{
          attachmentId: media.attachment.id,
          category: "cover",
          label: "Capa Foz",
          sortOrder: 0,
          selectedForPdf: true
        }]
      }
    });
    expect(updated).toMatchObject({ revision: 1, state: { destination: "Foz do Iguaçu", status: "ready_for_review" } });
    expect((await pool.query<{ category: string; selected_for_pdf: boolean }>(
      "SELECT category,selected_for_pdf FROM tripz_ai_proposal_media WHERE proposal_id=$1",
      [updated.id]
    )).rows).toEqual([{ category: "cover", selected_for_pdf: true }]);
    await expect(repository.patchProposal(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 0,
      patch: { notes: ["stale"] }
    })).rejects.toMatchObject({ statusCode: 409, code: "TRIPZ_REVISION_CONFLICT" });

    const pdf = await fileStore.upload(ownerScope, {
      conversationId: detail.conversation.id,
      fileName: "dados.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1")
    });
    await repository.updateAttachmentProcessing(ownerScope, {
      conversationId: detail.conversation.id,
      attachmentId: pdf.attachment.id,
      status: "processed",
      extractedText: "Conteúdo extraído uma única vez"
    });
    expect((await repository.getAttachmentContent(ownerScope, detail.conversation.id, pdf.attachment.id))?.extractedText)
      .toBe("Conteúdo extraído uma única vez");
    await expect(repository.patchProposal(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 1,
      patch: { media: [{
        attachmentId: pdf.attachment.id,
        category: "other",
        sortOrder: 1,
        selectedForPdf: true
      }] }
    })).rejects.toMatchObject({ statusCode: 400, code: "TRIPZ_MEDIA_ATTACHMENT_INVALID" });

    const generated = await repository.saveGeneratedDocument(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 1,
      kind: "preview",
      rendererVersion: "integration-v1",
      data: "<!doctype html><title>Foz</title>"
    });
    const retried = await repository.saveGeneratedDocument(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 1,
      kind: "preview",
      rendererVersion: "integration-v2",
      data: "<!doctype html><title>Conteúdo variável no retry</title>"
    });
    expect(retried.id).toBe(generated.id);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM tripz_ai_generated_documents
       WHERE tenant_id=$1 AND conversation_id=$2 AND proposal_revision=1 AND kind='preview'`,
      [ownerScope.tenantId, detail.conversation.id]
    )).rows[0].count).toBe(1);
    await pool.query(
      "UPDATE tripz_ai_conversations SET processing_status='queued' WHERE tenant_id=$1 AND id=$2",
      [ownerScope.tenantId, detail.conversation.id]
    );
    await expect(repository.saveGeneratedDocument(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 1,
      kind: "preview",
      rendererVersion: "integration-v3",
      data: "<!doctype html><title>Não deve ser salvo durante o turno</title>"
    })).rejects.toMatchObject({ statusCode: 409, code: "TRIPZ_TURN_IN_PROGRESS" });
    await pool.query(
      "UPDATE tripz_ai_conversations SET processing_status='idle' WHERE tenant_id=$1 AND id=$2",
      [ownerScope.tenantId, detail.conversation.id]
    );
    expect((await repository.getDocumentContent(ownerScope, detail.conversation.id, generated.id))?.data)
      .toContain("Conteúdo variável no retry");
    expect(await repository.getDocumentContent(colleagueScope, detail.conversation.id, generated.id)).toBeNull();

    const revised = await repository.patchProposal(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 1,
      patch: { notes: ["Roteiro corrigido"], media: [] }
    });
    expect(revised.revision).toBe(2);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM tripz_ai_proposal_media WHERE proposal_id=$1",
      [updated.id]
    )).rows[0].count).toBe(0);
    expect(await repository.getDocumentContent(ownerScope, detail.conversation.id, generated.id)).toBeNull();

    await repository.deleteConversation(ownerScope, detail.conversation.id);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM tripz_ai_proposals WHERE conversation_id=$1",
      [detail.conversation.id]
    )).rows[0].count).toBe(0);
  });

  it("keeps the latest turn in bounded conversation details and ignores unknown message state changes", async () => {
    const detail = await repository.createConversation(ownerScope, "Histórico longo");
    await pool.query(
      `INSERT INTO tripz_ai_messages(
         tenant_id,conversation_id,role,content,processing_status,created_at
       )
       SELECT $1,$2,'assistant','Histórico ' || sequence,'completed',
              now() - ((206-sequence) * interval '1 second')
       FROM generate_series(1,205) sequence`,
      [tenantA, detail.conversation.id]
    );
    const current = await repository.createUserMessage(ownerScope, {
      conversationId: detail.conversation.id,
      content: "Turno mais recente",
      attachmentIds: [],
      idempotencyKey: "tripz-latest-turn-history"
    });
    const bounded = await repository.getConversationDetail(ownerScope, detail.conversation.id);
    expect(bounded?.messages).toHaveLength(200);
    expect(bounded?.messages.at(-1)?.id).toBe(current.message.id);

    expect(await repository.markMessageProcessing(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: randomUUID(),
      status: "failed",
      errorCode: "SHOULD_NOT_CHANGE_CONVERSATION"
    })).toBe(false);
    expect((await repository.getConversationDetail(ownerScope, detail.conversation.id))?.conversation.processingStatus)
      .toBe("queued");
    await repository.markMessageProcessing(ownerScope, {
      conversationId: detail.conversation.id,
      messageId: current.message.id,
      status: "processing"
    });
    await pool.query(
      "UPDATE tripz_ai_messages SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [current.message.id]
    );
    expect(await repository.failStaleProcessingTurns()).toBe(1);
    expect((await repository.getConversationDetail(ownerScope, detail.conversation.id))?.conversation)
      .toMatchObject({ processingStatus: "failed", processingErrorCode: "TRIPZ_AI_WORKER_INTERRUPTED" });
    await expect(repository.retryUserMessage(colleagueScope, detail.conversation.id, current.message.id))
      .rejects.toMatchObject({ statusCode: 404, code: "TRIPZ_NOT_FOUND" });
    expect(await repository.retryUserMessage(ownerScope, detail.conversation.id, current.message.id))
      .toMatchObject({ reused: false, message: { processingStatus: "queued" }, attachmentIds: [] });
    await pool.query(
      "UPDATE tripz_ai_messages SET created_at=now()-interval '1 minute' WHERE id=$1",
      [current.message.id]
    );
    expect(await repository.listQueuedTurnsForRecovery({ olderThanMs: 5_000 })).toContainEqual({
      scope: { tenantId: tenantA, userId: ownerA, canManage: false },
      conversationId: detail.conversation.id,
      messageId: current.message.id,
      attachmentIds: []
    });
    await expect(repository.deleteConversation(ownerScope, detail.conversation.id))
      .rejects.toMatchObject({ statusCode: 409, code: "TRIPZ_TURN_IN_PROGRESS" });
    await repository.markTurnTerminalFailure({
      tenantId: ownerScope.tenantId,
      conversationId: detail.conversation.id,
      messageId: current.message.id,
      errorCode: "TRIPZ_TEST_CLEANUP"
    });
    await repository.deleteConversation(ownerScope, detail.conversation.id);
  });

  it("terminalizes a recovered manager turn even after its manage visibility is revoked", async () => {
    const detail = await repository.createConversation(ownerScope, "Recuperação de gerente");
    const queued = await repository.createUserMessage(managerScope, {
      conversationId: detail.conversation.id,
      content: "Turno criado com permissão de gestão",
      attachmentIds: [],
      idempotencyKey: "tripz-manager-recovery"
    });
    await pool.query(
      "UPDATE tripz_ai_messages SET created_at=now()-interval '1 minute' WHERE id=$1",
      [queued.message.id]
    );
    const recovered = (await repository.listQueuedTurnsForRecovery({ olderThanMs: 5_000 }))
      .find((turn) => turn.messageId === queued.message.id);
    expect(recovered).toMatchObject({
      scope: { tenantId: tenantA, userId: colleagueA, canManage: false },
      conversationId: detail.conversation.id
    });
    expect(await repository.markTurnTerminalFailure({
      tenantId: recovered!.scope.tenantId,
      conversationId: recovered!.conversationId,
      messageId: recovered!.messageId,
      errorCode: "FEATURE_PERMISSION_DENIED"
    })).toBe(true);
    const failed = await repository.getConversationDetail(ownerScope, detail.conversation.id);
    expect(failed?.conversation).toMatchObject({
      processingStatus: "failed",
      processingErrorCode: "FEATURE_PERMISSION_DENIED"
    });
    expect(failed?.messages.find((message) => message.id === queued.message.id))
      .toMatchObject({ processingStatus: "failed" });
    await repository.deleteConversation(ownerScope, detail.conversation.id);
  });

  it("keeps server-owned generation requirements blocking after a public proposal patch", async () => {
    const detail = await repository.createConversation(ownerScope, "Requisito persistente");
    await pool.query(
      `UPDATE tripz_ai_proposals SET state=jsonb_set(state,'{generationRequirements}',$3::jsonb)
       WHERE tenant_id=$1 AND conversation_id=$2`,
      [ownerScope.tenantId, detail.conversation.id, JSON.stringify([{
        path: "includedItems.insurance",
        label: "seguro",
        reason: "Declarado como necessário pelo agente na conversa."
      }])]
    );
    const patched = await repository.patchProposal(ownerScope, {
      conversationId: detail.conversation.id,
      expectedRevision: 0,
      patch: { destination: "Aruba", hotel: { name: "Hotel Tripz" } }
    });
    expect(patched.state.status).toBe("collecting");
    expect(patched.state.missingInformation).toContainEqual(expect.objectContaining({
      label: "seguro",
      required: true
    }));
    await repository.deleteConversation(ownerScope, detail.conversation.id);
  });

  it("keeps feature/permission catalogs isolated and rejects cross-tenant foreign keys", async () => {
    const flag = (await pool.query(
      "SELECT default_enabled,global_enabled,kill_switch_enabled FROM feature_flag_definitions WHERE flag_key='tripz_ai_v1'"
    )).rows[0];
    expect(flag).toEqual({ default_enabled: false, global_enabled: null, kill_switch_enabled: false });
    expect((await pool.query<{ key: string }>(
      "SELECT key FROM permissions WHERE key LIKE 'tripz_ai.%' ORDER BY key"
    )).rows.map((row) => row.key)).toEqual(["tripz_ai.manage", "tripz_ai.use"]);

    const detail = await repository.createConversation(ownerScope, "Tenant FK");
    await expect(pool.query(
      `INSERT INTO tripz_ai_proposals(tenant_id,conversation_id,state)
       VALUES($1,$2,$3)`,
      [tenantB, detail.conversation.id, detail.proposal.state]
    )).rejects.toMatchObject({ code: "23503" });
    await repository.deleteConversation(ownerScope, detail.conversation.id);
  });
});

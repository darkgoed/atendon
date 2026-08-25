import { createHash } from "node:crypto";
import type pg from "pg";
import {
  createEmptyTripzProposalState,
  mergeTripzProposalPatch,
  TRIPZ_MAX_TOTAL_ATTACHMENT_BYTES_PER_TURN,
  TripzAiError,
  tripzConflict,
  tripzNotFound,
  type TripzAccessScope,
  type TripzAttachment,
  type TripzAttachmentProcessingStatus,
  type TripzConversation,
  type TripzConversationDetail,
  type TripzCursorPage,
  type TripzDocumentKind,
  type TripzGeneratedDocument,
  type TripzMessage,
  type TripzMessageProcessingStatus,
  type TripzProposal,
  type TripzProposalPatch,
  type TripzProposalState
} from "./domain.js";
import { tripzProposalStateSchema } from "./schemas.js";
import { validateTripzProposal } from "./ai/proposal-validator.js";

type TripzDatabase = Pick<pg.Pool, "query" | "connect">;

interface ConversationRow {
  id: string;
  title: string;
  title_manually_set: boolean;
  status: TripzConversation["status"];
  summary: string | null;
  state_revision: number;
  processing_status: TripzConversation["processingStatus"];
  processing_error_code: string | null;
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: TripzMessage["role"];
  content: string;
  metadata: Record<string, unknown>;
  processing_status: TripzMessage["processingStatus"];
  proposal_revision_before: number | null;
  proposal_revision_after: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  content_hash: string;
  processing_status: TripzAttachment["processingStatus"];
  extracted_text: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProposalRow {
  id: string;
  conversation_id: string;
  schema_version: number;
  revision: number;
  state: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DocumentRow {
  id: string;
  conversation_id: string;
  proposal_revision: number;
  kind: TripzDocumentKind;
  renderer_version: string;
  content_hash: string;
  size_bytes: number;
  mime_type: string;
  created_at: Date | string;
}

interface CursorValue {
  timestamp: string;
  id: string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function conversationFromRow(row: ConversationRow): TripzConversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    stateRevision: row.state_revision,
    processingStatus: row.processing_status,
    processingErrorCode: row.processing_error_code,
    createdByUserId: row.created_by_user_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function messageFromRow(row: MessageRow): TripzMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata,
    processingStatus: row.processing_status,
    proposalRevisionBefore: row.proposal_revision_before,
    proposalRevisionAfter: row.proposal_revision_after,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function attachmentFromRow(row: AttachmentRow): TripzAttachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    processingStatus: row.processing_status,
    metadata: row.metadata,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function proposalFromRow(row: ProposalRow): TripzProposal {
  const state = tripzProposalStateSchema.safeParse(row.state);
  if (!state.success) {
    throw new TripzAiError(500, "TRIPZ_STATE_INVALID", "Estado da proposta inválido");
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    state: state.data,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function documentFromRow(row: DocumentRow): TripzGeneratedDocument {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    proposalRevision: row.proposal_revision,
    kind: row.kind,
    rendererVersion: row.renderer_version,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    createdAt: timestamp(row.created_at)
  };
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value?: string): CursorValue | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorValue>;
    if (typeof decoded.timestamp !== "string" || !Number.isFinite(Date.parse(decoded.timestamp))
      || typeof decoded.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)) {
      throw new Error("invalid cursor");
    }
    return { timestamp: new Date(decoded.timestamp).toISOString(), id: decoded.id };
  } catch {
    throw new TripzAiError(400, "TRIPZ_CURSOR_INVALID", "Cursor inválido");
  }
}

const CONVERSATION_COLUMNS = `conversation.id,conversation.title,conversation.status,conversation.summary,
  conversation.title_manually_set,conversation.state_revision,conversation.processing_status,conversation.processing_error_code,
  conversation.created_by_user_id,conversation.created_at,conversation.updated_at`;
const MESSAGE_COLUMNS = `message.id,message.conversation_id,message.role,message.content,message.metadata,
  message.processing_status,message.proposal_revision_before,message.proposal_revision_after,
  message.created_at,message.updated_at`;
const ATTACHMENT_COLUMNS = `attachment.id,attachment.conversation_id,attachment.message_id,
  attachment.file_name,attachment.mime_type,attachment.extension,attachment.size_bytes,
  attachment.content_hash,attachment.processing_status,attachment.extracted_text,attachment.metadata,
  attachment.created_at,attachment.updated_at`;
const PROPOSAL_COLUMNS = `proposal.id,proposal.conversation_id,proposal.schema_version,proposal.revision,
  proposal.state,proposal.created_at,proposal.updated_at`;
const DOCUMENT_COLUMNS = `document.id,document.conversation_id,document.proposal_revision,document.kind,
  document.renderer_version,document.content_hash,document.size_bytes,document.mime_type,document.created_at`;

async function transaction<T>(database: TripzDatabase, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockVisibleConversation(
  client: Pick<pg.PoolClient, "query">,
  scope: TripzAccessScope,
  conversationId: string
): Promise<ConversationRow> {
  const result = await client.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
     FROM tripz_ai_conversations conversation
     WHERE conversation.tenant_id=$1 AND conversation.id=$2
       AND (conversation.created_by_user_id=$3 OR $4::boolean)
     FOR UPDATE`,
    [scope.tenantId, conversationId, scope.userId, scope.canManage]
  );
  if (!result.rows[0]) throw tripzNotFound("Conversa não encontrada");
  return result.rows[0];
}

async function syncProposalMedia(
  client: Pick<pg.PoolClient, "query">,
  scope: TripzAccessScope,
  proposal: TripzProposal,
  state: TripzProposalState
): Promise<void> {
  const attachmentIds = [...new Set(state.media.map((media) => media.attachmentId))];
  if (attachmentIds.length > 0) {
    const valid = await client.query<{ id: string }>(
      `SELECT id FROM tripz_ai_attachments
       WHERE tenant_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[])
         AND mime_type IN ('image/jpeg','image/png','image/webp')`,
      [scope.tenantId, proposal.conversationId, attachmentIds]
    );
    if (valid.rowCount !== attachmentIds.length) {
      throw new TripzAiError(400, "TRIPZ_MEDIA_ATTACHMENT_INVALID", "A proposta aceita somente imagens válidas na galeria");
    }
  }
  await client.query(
    `DELETE FROM tripz_ai_proposal_media
     WHERE tenant_id=$1 AND conversation_id=$2
       AND NOT (attachment_id=ANY($3::uuid[]))`,
    [scope.tenantId, proposal.conversationId, attachmentIds]
  );
  for (const media of state.media) {
    await client.query(
      `INSERT INTO tripz_ai_proposal_media(
         tenant_id,conversation_id,proposal_id,attachment_id,category,label,
         confidence,sort_order,selected_for_pdf,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(tenant_id,proposal_id,attachment_id) DO UPDATE SET
         category=EXCLUDED.category,label=EXCLUDED.label,confidence=EXCLUDED.confidence,
         sort_order=EXCLUDED.sort_order,selected_for_pdf=EXCLUDED.selected_for_pdf,
         metadata=EXCLUDED.metadata`,
      [scope.tenantId, proposal.conversationId, proposal.id, media.attachmentId,
        media.category, media.label ?? null, media.confidence ?? null, media.sortOrder,
        media.selectedForPdf, media.metadata ?? {}]
    );
  }
}

export interface TripzAttachmentBinary {
  attachment: TripzAttachment;
  data: Buffer;
  extractedText?: string;
}

export interface TripzDocumentContent {
  document: TripzGeneratedDocument;
  data: Buffer | string;
}

export interface TripzCreateMessageResult {
  message: TripzMessage;
  reused: boolean;
}

export interface TripzRetryMessageResult extends TripzCreateMessageResult {
  attachmentIds: string[];
}

export interface TripzQueuedTurnRecovery {
  scope: TripzAccessScope;
  conversationId: string;
  messageId: string;
  attachmentIds: string[];
}

export interface TripzRepositoryPort {
  createConversation(scope: TripzAccessScope, title?: string): Promise<TripzConversationDetail>;
  listConversations(scope: TripzAccessScope, input: { cursor?: string; limit: number }): Promise<TripzCursorPage<TripzConversation>>;
  getConversationDetail(scope: TripzAccessScope, conversationId: string): Promise<TripzConversationDetail | null>;
  renameConversation(scope: TripzAccessScope, conversationId: string, title: string): Promise<TripzConversation>;
  deleteConversation(scope: TripzAccessScope, conversationId: string): Promise<boolean>;
  listMessages(scope: TripzAccessScope, conversationId: string, input: { cursor?: string; limit: number }): Promise<TripzCursorPage<TripzMessage> | null>;
  createUserMessage(scope: TripzAccessScope, input: { conversationId: string; content: string; attachmentIds: string[]; idempotencyKey: string }): Promise<TripzCreateMessageResult>;
  retryUserMessage(scope: TripzAccessScope, conversationId: string, messageId: string): Promise<TripzRetryMessageResult>;
  getProposal(scope: TripzAccessScope, conversationId: string): Promise<TripzProposal | null>;
  patchProposal(scope: TripzAccessScope, input: { conversationId: string; expectedRevision: number; patch: TripzProposalPatch }): Promise<TripzProposal>;
  createAttachment(scope: TripzAccessScope, input: { conversationId: string; fileName: string; mimeType: string; extension: string; data: Buffer; contentHash: string; metadata?: Record<string, unknown> }): Promise<{ attachment: TripzAttachment; reused: boolean }>;
  getAttachmentContent(scope: TripzAccessScope, conversationId: string, attachmentId: string): Promise<TripzAttachmentBinary | null>;
  deleteAttachment(scope: TripzAccessScope, conversationId: string, attachmentId: string): Promise<boolean>;
  saveGeneratedDocument(scope: TripzAccessScope, input: { conversationId: string; expectedRevision: number; kind: TripzDocumentKind; rendererVersion: string; data: Buffer | string }): Promise<TripzGeneratedDocument>;
  getDocumentContent(scope: TripzAccessScope, conversationId: string, documentId: string): Promise<TripzDocumentContent | null>;
  markTurnTerminalFailure(input: { tenantId: string; conversationId: string; messageId: string; errorCode: string }): Promise<boolean>;
}

export class TripzAiRepository implements TripzRepositoryPort {
  constructor(private readonly database: TripzDatabase) {}

  async createConversation(scope: TripzAccessScope, title?: string): Promise<TripzConversationDetail> {
    return transaction(this.database, async (client) => {
      const normalizedTitle = title?.trim() || "Nova proposta";
      const conversationResult = await client.query<ConversationRow>(
        `INSERT INTO tripz_ai_conversations(tenant_id,created_by_user_id,title,title_manually_set)
         VALUES($1,$2,$3,$4)
         RETURNING id,title,status,summary,title_manually_set,state_revision,processing_status,processing_error_code,
                   created_by_user_id,created_at,updated_at`,
        [scope.tenantId, scope.userId, normalizedTitle, Boolean(title?.trim())]
      );
      const conversation = conversationFromRow(conversationResult.rows[0]);
      const proposalResult = await client.query<ProposalRow>(
        `INSERT INTO tripz_ai_proposals(tenant_id,conversation_id,state)
         VALUES($1,$2,$3)
         RETURNING id,conversation_id,schema_version,revision,state,created_at,updated_at`,
        [scope.tenantId, conversation.id, createEmptyTripzProposalState()]
      );
      return {
        conversation,
        proposal: proposalFromRow(proposalResult.rows[0]),
        messages: [],
        attachments: [],
        documents: []
      };
    });
  }

  async listConversations(
    scope: TripzAccessScope,
    input: { cursor?: string; limit: number }
  ): Promise<TripzCursorPage<TripzConversation>> {
    const cursor = decodeCursor(input.cursor);
    const result = await this.database.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM tripz_ai_conversations conversation
       WHERE conversation.tenant_id=$1
         AND (conversation.created_by_user_id=$2 OR $3::boolean)
         AND ($4::timestamptz IS NULL OR (conversation.updated_at,conversation.id) < ($4::timestamptz,$5::uuid))
       ORDER BY conversation.updated_at DESC,conversation.id DESC
       LIMIT $6`,
      [scope.tenantId, scope.userId, scope.canManage, cursor?.timestamp ?? null, cursor?.id ?? null, input.limit + 1]
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(conversationFromRow),
      nextCursor: hasNext && last ? encodeCursor({ timestamp: timestamp(last.updated_at), id: last.id }) : null
    };
  }

  async getConversationDetail(scope: TripzAccessScope, conversationId: string): Promise<TripzConversationDetail | null> {
    const conversationResult = await this.database.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM tripz_ai_conversations conversation
       WHERE conversation.tenant_id=$1 AND conversation.id=$2
         AND (conversation.created_by_user_id=$3 OR $4::boolean)`,
      [scope.tenantId, conversationId, scope.userId, scope.canManage]
    );
    if (!conversationResult.rows[0]) return null;
    const [proposalResult, messagesResult, attachmentsResult, documentsResult] = await Promise.all([
      this.database.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM tripz_ai_proposals proposal
         WHERE proposal.tenant_id=$1 AND proposal.conversation_id=$2`,
        [scope.tenantId, conversationId]
      ),
      this.database.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM tripz_ai_messages message
         WHERE message.tenant_id=$1 AND message.conversation_id=$2
         ORDER BY message.created_at DESC,message.id DESC LIMIT 200`,
        [scope.tenantId, conversationId]
      ),
      this.database.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS} FROM tripz_ai_attachments attachment
         WHERE attachment.tenant_id=$1 AND attachment.conversation_id=$2
         ORDER BY attachment.created_at ASC,attachment.id ASC`,
        [scope.tenantId, conversationId]
      ),
      this.database.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM tripz_ai_generated_documents document
         JOIN tripz_ai_proposals proposal
           ON proposal.tenant_id=document.tenant_id AND proposal.conversation_id=document.conversation_id
          AND proposal.revision=document.proposal_revision
         WHERE document.tenant_id=$1 AND document.conversation_id=$2
         ORDER BY document.created_at DESC,document.id DESC LIMIT 20`,
        [scope.tenantId, conversationId]
      )
    ]);
    const proposal = proposalResult.rows[0];
    if (!proposal) throw new TripzAiError(500, "TRIPZ_PROPOSAL_MISSING", "Proposta não encontrada");
    return {
      conversation: conversationFromRow(conversationResult.rows[0]),
      proposal: proposalFromRow(proposal),
      messages: messagesResult.rows.reverse().map(messageFromRow),
      attachments: attachmentsResult.rows.map(attachmentFromRow),
      documents: documentsResult.rows.map(documentFromRow)
    };
  }

  async deleteConversation(scope: TripzAccessScope, conversationId: string): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, conversationId);
      if (conversation.processing_status === "queued" || conversation.processing_status === "processing") {
        throw new TripzAiError(409, "TRIPZ_TURN_IN_PROGRESS", "Aguarde a análise atual antes de excluir a proposta");
      }
      const result = await client.query(
        `DELETE FROM tripz_ai_conversations
         WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, conversationId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async renameConversation(
    scope: TripzAccessScope,
    conversationId: string,
    title: string
  ): Promise<TripzConversation> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, conversationId);
      const result = await client.query<ConversationRow>(
        `UPDATE tripz_ai_conversations conversation
         SET title=$3,title_manually_set=true
         WHERE conversation.tenant_id=$1 AND conversation.id=$2
         RETURNING ${CONVERSATION_COLUMNS}`,
        [scope.tenantId, conversationId, title]
      );
      return conversationFromRow(result.rows[0]);
    });
  }

  async listMessages(
    scope: TripzAccessScope,
    conversationId: string,
    input: { cursor?: string; limit: number }
  ): Promise<TripzCursorPage<TripzMessage> | null> {
    const visible = await this.getConversationRow(scope, conversationId);
    if (!visible) return null;
    const cursor = decodeCursor(input.cursor);
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM tripz_ai_messages message
       WHERE message.tenant_id=$1 AND message.conversation_id=$2
         AND ($3::timestamptz IS NULL OR (message.created_at,message.id) < ($3::timestamptz,$4::uuid))
       ORDER BY message.created_at DESC,message.id DESC LIMIT $5`,
      [scope.tenantId, conversationId, cursor?.timestamp ?? null, cursor?.id ?? null, input.limit + 1]
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      items: rows.reverse().map(messageFromRow),
      nextCursor: hasNext && last ? encodeCursor({ timestamp: timestamp(last.created_at), id: last.id }) : null
    };
  }

  async createUserMessage(scope: TripzAccessScope, input: {
    conversationId: string;
    content: string;
    attachmentIds: string[];
    idempotencyKey: string;
  }): Promise<TripzCreateMessageResult> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ content: input.content, attachmentIds: input.attachmentIds }))
      .digest("hex");
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, input.conversationId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${scope.tenantId}:${input.conversationId}:${input.idempotencyKey}`
      ]);
      const existing = await client.query<MessageRow & { payload_fingerprint: string }>(
        `SELECT ${MESSAGE_COLUMNS},message.payload_fingerprint
         FROM tripz_ai_messages message
         WHERE message.tenant_id=$1 AND message.conversation_id=$2 AND message.idempotency_key=$3`,
        [scope.tenantId, input.conversationId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_fingerprint !== fingerprint) {
          throw tripzConflict("TRIPZ_IDEMPOTENCY_CONFLICT", "Idempotency-Key já foi usada com outro conteúdo");
        }
        return { message: messageFromRow(existing.rows[0]), reused: true };
      }

      if (conversation.processing_status === "queued" || conversation.processing_status === "processing") {
        throw tripzConflict("TRIPZ_TURN_IN_PROGRESS", "Aguarde a análise atual antes de enviar outra mensagem");
      }

      if (input.attachmentIds.length > 0) {
        const attachments = await client.query<{ id: string; size_bytes: number }>(
          `SELECT attachment.id,attachment.size_bytes FROM tripz_ai_attachments attachment
           WHERE attachment.tenant_id=$1 AND attachment.conversation_id=$2
             AND attachment.id=ANY($3::uuid[]) AND attachment.message_id IS NULL
           FOR UPDATE`,
          [scope.tenantId, input.conversationId, input.attachmentIds]
        );
        if (attachments.rowCount !== input.attachmentIds.length) {
          throw new TripzAiError(400, "TRIPZ_ATTACHMENT_INVALID", "Um ou mais anexos não estão disponíveis");
        }
        const totalBytes = attachments.rows.reduce((total, attachment) => total + attachment.size_bytes, 0);
        if (totalBytes > TRIPZ_MAX_TOTAL_ATTACHMENT_BYTES_PER_TURN) {
          throw new TripzAiError(413, "TRIPZ_TOTAL_ATTACHMENT_SIZE", "Os anexos da mensagem excedem o limite total de 40 MB");
        }
      }
      const proposal = await client.query<{ revision: number }>(
        `SELECT revision FROM tripz_ai_proposals
         WHERE tenant_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [scope.tenantId, input.conversationId]
      );
      if (!proposal.rows[0]) throw new TripzAiError(500, "TRIPZ_PROPOSAL_MISSING", "Proposta não encontrada");
      const result = await client.query<MessageRow>(
        `INSERT INTO tripz_ai_messages(
           tenant_id,conversation_id,created_by_user_id,role,content,processing_status,
           idempotency_key,payload_fingerprint,proposal_revision_before
         ) VALUES($1,$2,$3,'user',$4,'queued',$5,$6,$7)
         RETURNING id,conversation_id,role,content,metadata,processing_status,
                   proposal_revision_before,proposal_revision_after,created_at,updated_at`,
        [scope.tenantId, input.conversationId, scope.userId, input.content,
          input.idempotencyKey, fingerprint, proposal.rows[0].revision]
      );
      if (input.attachmentIds.length > 0) {
        await client.query(
          `UPDATE tripz_ai_attachments SET message_id=$4
           WHERE tenant_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[])`,
          [scope.tenantId, input.conversationId, input.attachmentIds, result.rows[0].id]
        );
      }
      await client.query(
        `UPDATE tripz_ai_conversations
         SET processing_status='queued',processing_error_code=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, input.conversationId]
      );
      return { message: messageFromRow(result.rows[0]), reused: false };
    });
  }

  async retryUserMessage(
    scope: TripzAccessScope,
    conversationId: string,
    messageId: string
  ): Promise<TripzRetryMessageResult> {
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, conversationId);
      const messageResult = await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM tripz_ai_messages message
         WHERE message.tenant_id=$1 AND message.conversation_id=$2
           AND message.id=$3 AND message.role='user' FOR UPDATE`,
        [scope.tenantId, conversationId, messageId]
      );
      const current = messageResult.rows[0];
      if (!current) throw tripzNotFound("Mensagem não encontrada");
      const attachments = await client.query<{ id: string }>(
        `SELECT id FROM tripz_ai_attachments
         WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3
         ORDER BY created_at,id`,
        [scope.tenantId, conversationId, messageId]
      );
      const attachmentIds = attachments.rows.map((attachment) => attachment.id);
      if (current.processing_status === "queued" || current.processing_status === "processing") {
        return { message: messageFromRow(current), attachmentIds, reused: true };
      }
      if (current.processing_status !== "failed" || conversation.processing_status !== "failed") {
        throw tripzConflict("TRIPZ_MESSAGE_NOT_RETRYABLE", "A mensagem não está disponível para nova tentativa");
      }
      const updated = await client.query<MessageRow>(
        `UPDATE tripz_ai_messages message SET
           processing_status='queued',last_error_code=NULL,available_at=now(),
           processing_started_at=NULL,lease_expires_at=NULL
         WHERE message.tenant_id=$1 AND message.conversation_id=$2 AND message.id=$3
         RETURNING ${MESSAGE_COLUMNS}`,
        [scope.tenantId, conversationId, messageId]
      );
      await client.query(
        `UPDATE tripz_ai_attachments SET processing_status='pending',metadata=metadata - 'errorCode'
         WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3`,
        [scope.tenantId, conversationId, messageId]
      );
      await client.query(
        `UPDATE tripz_ai_conversations SET processing_status='queued',processing_error_code=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, conversationId]
      );
      return { message: messageFromRow(updated.rows[0]), attachmentIds, reused: false };
    });
  }

  async getProposal(scope: TripzAccessScope, conversationId: string): Promise<TripzProposal | null> {
    const result = await this.database.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM tripz_ai_proposals proposal
       JOIN tripz_ai_conversations conversation
         ON conversation.tenant_id=proposal.tenant_id AND conversation.id=proposal.conversation_id
       WHERE proposal.tenant_id=$1 AND proposal.conversation_id=$2
         AND (conversation.created_by_user_id=$3 OR $4::boolean)`,
      [scope.tenantId, conversationId, scope.userId, scope.canManage]
    );
    return result.rows[0] ? proposalFromRow(result.rows[0]) : null;
  }

  async patchProposal(scope: TripzAccessScope, input: {
    conversationId: string;
    expectedRevision: number;
    patch: TripzProposalPatch;
  }): Promise<TripzProposal> {
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, input.conversationId);
      const currentResult = await client.query<ProposalRow>(
        `SELECT id,conversation_id,schema_version,revision,state,created_at,updated_at
         FROM tripz_ai_proposals WHERE tenant_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [scope.tenantId, input.conversationId]
      );
      if (!currentResult.rows[0]) throw new TripzAiError(500, "TRIPZ_PROPOSAL_MISSING", "Proposta não encontrada");
      const current = proposalFromRow(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw tripzConflict("TRIPZ_REVISION_CONFLICT", "A proposta foi alterada; recarregue antes de salvar");
      }
      const merged = tripzProposalStateSchema.parse(mergeTripzProposalPatch(current.state, input.patch));
      const state = validateTripzProposal(merged, { requiredFields: merged.generationRequirements }).proposal;
      const attachmentIds = [...new Set(state.media.map((media) => media.attachmentId))];
      if (attachmentIds.length > 0) {
        const validMedia = await client.query<{ count: number }>(
          `SELECT count(*)::int count FROM tripz_ai_attachments
           WHERE tenant_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[])`,
          [scope.tenantId, input.conversationId, attachmentIds]
        );
        if (validMedia.rows[0].count !== attachmentIds.length) {
          throw new TripzAiError(400, "TRIPZ_MEDIA_INVALID", "Uma ou mais mídias não pertencem à conversa");
        }
      }
      const updated = await client.query<ProposalRow>(
        `UPDATE tripz_ai_proposals SET
           revision=revision+1,state=$3,missing_information=$4,issues=$5
         WHERE tenant_id=$1 AND conversation_id=$2
         RETURNING id,conversation_id,schema_version,revision,state,created_at,updated_at`,
        [scope.tenantId, input.conversationId, state,
          JSON.stringify(state.missingInformation), JSON.stringify(state.inconsistencies)]
      );
      await client.query(
        `UPDATE tripz_ai_conversations SET
           title=$3,status=$4,state_revision=$5
         WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, input.conversationId,
          conversation.title_manually_set ? conversation.title : state.title ?? state.destination ?? conversation.title,
          state.status, updated.rows[0].revision]
      );
      await syncProposalMedia(client, scope, proposalFromRow(updated.rows[0]), state);
      await client.query(
        "DELETE FROM tripz_ai_generated_documents WHERE tenant_id=$1 AND conversation_id=$2",
        [scope.tenantId, input.conversationId]
      );
      return proposalFromRow(updated.rows[0]);
    });
  }

  async createAttachment(scope: TripzAccessScope, input: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    extension: string;
    data: Buffer;
    contentHash: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ attachment: TripzAttachment; reused: boolean }> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, input.conversationId);
      const existing = await client.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS} FROM tripz_ai_attachments attachment
         WHERE attachment.tenant_id=$1 AND attachment.conversation_id=$2
           AND attachment.content_hash=$3 AND attachment.message_id IS NULL`,
        [scope.tenantId, input.conversationId, input.contentHash]
      );
      if (existing.rows[0]) return { attachment: attachmentFromRow(existing.rows[0]), reused: true };
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM tripz_ai_attachments WHERE tenant_id=$1 AND conversation_id=$2",
        [scope.tenantId, input.conversationId]
      );
      if (count.rows[0].count >= 30) {
        throw new TripzAiError(413, "TRIPZ_ATTACHMENT_LIMIT", "A conversa aceita no máximo 30 anexos");
      }
      const result = await client.query<AttachmentRow>(
        `INSERT INTO tripz_ai_attachments(
           tenant_id,conversation_id,uploaded_by_user_id,file_name,mime_type,extension,
           size_bytes,content_hash,file_data,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id,conversation_id,message_id,file_name,mime_type,extension,size_bytes,
                   content_hash,processing_status,metadata,created_at,updated_at`,
        [scope.tenantId, input.conversationId, scope.userId, input.fileName, input.mimeType,
          input.extension, input.data.length, input.contentHash, input.data, input.metadata ?? {}]
      );
      return { attachment: attachmentFromRow(result.rows[0]), reused: false };
    });
  }

  async getAttachmentContent(
    scope: TripzAccessScope,
    conversationId: string,
    attachmentId: string
  ): Promise<TripzAttachmentBinary | null> {
    const result = await this.database.query<AttachmentRow & { file_data: Buffer }>(
      `SELECT ${ATTACHMENT_COLUMNS},attachment.file_data
       FROM tripz_ai_attachments attachment
       JOIN tripz_ai_conversations conversation
         ON conversation.tenant_id=attachment.tenant_id AND conversation.id=attachment.conversation_id
       WHERE attachment.tenant_id=$1 AND attachment.conversation_id=$2 AND attachment.id=$3
         AND (conversation.created_by_user_id=$4 OR $5::boolean)`,
      [scope.tenantId, conversationId, attachmentId, scope.userId, scope.canManage]
    );
    const row = result.rows[0];
    return row ? {
      attachment: attachmentFromRow(row),
      data: row.file_data,
      ...(row.extracted_text ? { extractedText: row.extracted_text } : {})
    } : null;
  }

  async deleteAttachment(scope: TripzAccessScope, conversationId: string, attachmentId: string): Promise<boolean> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, conversationId);
      const result = await client.query(
        `DELETE FROM tripz_ai_attachments
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 AND message_id IS NULL`,
        [scope.tenantId, conversationId, attachmentId]
      );
      if ((result.rowCount ?? 0) > 0) return true;
      const linked = await client.query<{ linked: boolean }>(
        `SELECT message_id IS NOT NULL linked FROM tripz_ai_attachments
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
        [scope.tenantId, conversationId, attachmentId]
      );
      if (linked.rows[0]?.linked) {
        throw tripzConflict("TRIPZ_ATTACHMENT_LINKED", "Anexo já enviado não pode ser removido isoladamente");
      }
      return false;
    });
  }

  async saveGeneratedDocument(scope: TripzAccessScope, input: {
    conversationId: string;
    expectedRevision: number;
    kind: TripzDocumentKind;
    rendererVersion: string;
    data: Buffer | string;
  }): Promise<TripzGeneratedDocument> {
    const bytes = typeof input.data === "string" ? Buffer.from(input.data, "utf8") : input.data;
    const maxBytes = input.kind === "preview" ? 5 * 1024 * 1024 : 50 * 1024 * 1024;
    if (!bytes.length || bytes.length > maxBytes) {
      throw new TripzAiError(413, "TRIPZ_DOCUMENT_SIZE", "Documento gerado excede o limite permitido");
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, input.conversationId);
      if (conversation.processing_status === "queued" || conversation.processing_status === "processing") {
        throw tripzConflict("TRIPZ_TURN_IN_PROGRESS", "Aguarde a análise atual antes de gerar o documento");
      }
      const proposal = await client.query<{ revision: number }>(
        "SELECT revision FROM tripz_ai_proposals WHERE tenant_id=$1 AND conversation_id=$2 FOR UPDATE",
        [scope.tenantId, input.conversationId]
      );
      if (!proposal.rows[0]) throw new TripzAiError(500, "TRIPZ_PROPOSAL_MISSING", "Proposta não encontrada");
      if (proposal.rows[0].revision !== input.expectedRevision) {
        throw tripzConflict("TRIPZ_REVISION_CONFLICT", "A proposta foi alterada; gere o documento novamente");
      }
      if (input.kind === "pdf") {
        const preview = await client.query<{ id: string }>(
          `SELECT id FROM tripz_ai_generated_documents
           WHERE tenant_id=$1 AND conversation_id=$2 AND proposal_revision=$3 AND kind='preview'`,
          [scope.tenantId, input.conversationId, input.expectedRevision]
        );
        if (!preview.rows[0]) {
          throw tripzConflict("TRIPZ_PREVIEW_REQUIRED", "Gere e revise a prévia desta versão antes do PDF");
        }
      }
      const mimeType = input.kind === "preview" ? "text/html; charset=utf-8" : "application/pdf";
      const result = await client.query<DocumentRow>(
        `INSERT INTO tripz_ai_generated_documents(
           tenant_id,conversation_id,proposal_revision,kind,renderer_version,content_hash,
           mime_type,size_bytes,html_data,pdf_data
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(tenant_id,conversation_id,proposal_revision,kind)
         DO UPDATE SET renderer_version=EXCLUDED.renderer_version,
           content_hash=EXCLUDED.content_hash,mime_type=EXCLUDED.mime_type,
           size_bytes=EXCLUDED.size_bytes,html_data=EXCLUDED.html_data,
           pdf_data=EXCLUDED.pdf_data,created_at=now()
         RETURNING id,conversation_id,proposal_revision,kind,renderer_version,content_hash,
                   size_bytes,mime_type,created_at`,
        [scope.tenantId, input.conversationId, input.expectedRevision, input.kind,
          input.rendererVersion, contentHash, mimeType, bytes.length,
          input.kind === "preview" ? input.data as string : null,
          input.kind === "pdf" ? bytes : null]
      );
      if (input.kind === "pdf") {
        await client.query(
          `UPDATE tripz_ai_proposals
           SET state=jsonb_set(state,'{status}','"pdf_generated"'::jsonb,true)
           WHERE tenant_id=$1 AND conversation_id=$2`,
          [scope.tenantId, input.conversationId]
        );
        await client.query(
          `UPDATE tripz_ai_conversations SET status='pdf_generated'
           WHERE tenant_id=$1 AND id=$2`,
          [scope.tenantId, input.conversationId]
        );
      }
      return documentFromRow(result.rows[0]);
    });
  }

  async getDocumentContent(
    scope: TripzAccessScope,
    conversationId: string,
    documentId: string
  ): Promise<TripzDocumentContent | null> {
    const result = await this.database.query<DocumentRow & { html_data: string | null; pdf_data: Buffer | null }>(
      `SELECT ${DOCUMENT_COLUMNS},document.html_data,document.pdf_data
       FROM tripz_ai_generated_documents document
       JOIN tripz_ai_conversations conversation
         ON conversation.tenant_id=document.tenant_id AND conversation.id=document.conversation_id
       JOIN tripz_ai_proposals proposal
         ON proposal.tenant_id=document.tenant_id AND proposal.conversation_id=document.conversation_id
        AND proposal.revision=document.proposal_revision
       WHERE document.tenant_id=$1 AND document.conversation_id=$2 AND document.id=$3
         AND (conversation.created_by_user_id=$4 OR $5::boolean)`,
      [scope.tenantId, conversationId, documentId, scope.userId, scope.canManage]
    );
    const row = result.rows[0];
    if (!row) return null;
    const data = row.kind === "preview" ? row.html_data : row.pdf_data;
    if (data === null) throw new TripzAiError(500, "TRIPZ_DOCUMENT_INVALID", "Documento inválido");
    return { document: documentFromRow(row), data };
  }

  async appendAssistantMessage(scope: TripzAccessScope, input: {
    conversationId: string;
    content: string;
    metadata?: Record<string, unknown>;
    proposalRevisionBefore: number;
    proposalRevisionAfter: number;
  }): Promise<TripzMessage> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, input.conversationId);
      const result = await client.query<MessageRow>(
        `INSERT INTO tripz_ai_messages(
           tenant_id,conversation_id,role,content,metadata,processing_status,
           proposal_revision_before,proposal_revision_after
         ) VALUES($1,$2,'assistant',$3,$4,'completed',$5,$6)
         RETURNING id,conversation_id,role,content,metadata,processing_status,
                   proposal_revision_before,proposal_revision_after,created_at,updated_at`,
        [scope.tenantId, input.conversationId, input.content, input.metadata ?? {},
          input.proposalRevisionBefore, input.proposalRevisionAfter]
      );
      return messageFromRow(result.rows[0]);
    });
  }

  async markMessageProcessing(scope: TripzAccessScope, input: {
    conversationId: string;
    messageId: string;
    status: TripzMessageProcessingStatus;
    errorCode?: string | null;
  }): Promise<boolean> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, input.conversationId);
      const result = await client.query(
        `UPDATE tripz_ai_messages SET processing_status=$4,last_error_code=$5,
           processing_started_at=CASE WHEN $4='processing' THEN now() ELSE processing_started_at END,
           lease_expires_at=CASE
             WHEN $4='processing' THEN now()+interval '15 minutes'
             WHEN $4 IN ('completed','failed') THEN NULL
             ELSE lease_expires_at
           END,
           attempt_count=attempt_count+CASE WHEN $4='processing' THEN 1 ELSE 0 END
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3
           AND ($4 <> 'processing' OR processing_status IN ('queued','failed'))`,
        [scope.tenantId, input.conversationId, input.messageId, input.status, input.errorCode ?? null]
      );
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE tripz_ai_conversations SET processing_status=$3,processing_error_code=$4
           WHERE tenant_id=$1 AND id=$2`,
          [scope.tenantId, input.conversationId,
            input.status === "completed" ? "idle" : input.status === "pending" ? "queued" : input.status,
            input.errorCode ?? null]
        );
      }
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Terminalizes an exact persisted turn after the worker has already revalidated access.
   * This deliberately does not depend on the job creator retaining conversation visibility:
   * feature/permission revocation must stop the job without leaving it queued forever.
   */
  async markTurnTerminalFailure(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    errorCode: string;
  }): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const conversation = await client.query<{ id: string }>(
        `SELECT id FROM tripz_ai_conversations
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.conversationId]
      );
      if (!conversation.rows[0]) return false;
      const message = await client.query<{ id: string }>(
        `UPDATE tripz_ai_messages SET processing_status='failed',last_error_code=$4,
           lease_expires_at=NULL
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3
           AND role='user' AND processing_status IN ('queued','processing')
         RETURNING id`,
        [input.tenantId, input.conversationId, input.messageId, input.errorCode]
      );
      if (!message.rows[0]) return false;
      await client.query(
        `UPDATE tripz_ai_attachments SET processing_status='failed',
           metadata=metadata || jsonb_build_object('errorCode',$4::text)
         WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3
           AND processing_status IN ('pending','processing')`,
        [input.tenantId, input.conversationId, input.messageId, input.errorCode]
      );
      await client.query(
        `UPDATE tripz_ai_conversations SET processing_status='failed',processing_error_code=$3
         WHERE tenant_id=$1 AND id=$2 AND processing_status IN ('queued','processing')`,
        [input.tenantId, input.conversationId, input.errorCode]
      );
      return true;
    });
  }

  async updateAttachmentProcessing(scope: TripzAccessScope, input: {
    conversationId: string;
    attachmentId: string;
    status: TripzAttachmentProcessingStatus;
    extractedText?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    return transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, input.conversationId);
      const result = await client.query(
        `UPDATE tripz_ai_attachments SET processing_status=$4,
           extracted_text=COALESCE($5,extracted_text),metadata=COALESCE($6,metadata)
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
        [scope.tenantId, input.conversationId, input.attachmentId, input.status,
          input.extractedText ?? null, input.metadata ?? null]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async recordUsage(scope: TripzAccessScope, input: {
    conversationId: string;
    messageId?: string;
    purpose: "conversation" | "attachment" | "proposal";
    model: string;
    provider?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    requestIndex?: number;
    finishReason?: string;
  }): Promise<void> {
    await transaction(this.database, async (client) => {
      await lockVisibleConversation(client, scope, input.conversationId);
      await client.query(
        `INSERT INTO tripz_ai_usage_logs(
           tenant_id,conversation_id,message_id,purpose,model,provider,input_tokens,
           output_tokens,cost_usd,duration_ms,request_index,finish_reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [scope.tenantId, input.conversationId, input.messageId ?? null, input.purpose,
          input.model, input.provider ?? null, input.inputTokens, input.outputTokens,
          input.costUsd, input.durationMs, input.requestIndex ?? 1, input.finishReason ?? null]
      );
    });
  }

  async getUsageBudget(scope: TripzAccessScope, input: {
    conversationId: string;
    messageId: string;
  }): Promise<{ providerRequests: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const result = await this.database.query<{
      provider_requests: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: string | number;
    }>(
      `SELECT count(usage.id)::int provider_requests,
              COALESCE(sum(usage.input_tokens),0)::int input_tokens,
              COALESCE(sum(usage.output_tokens),0)::int output_tokens,
              COALESCE(sum(usage.cost_usd),0) cost_usd
       FROM tripz_ai_conversations conversation
       LEFT JOIN tripz_ai_usage_logs usage
         ON usage.tenant_id=conversation.tenant_id
        AND usage.conversation_id=conversation.id AND usage.message_id=$5
       WHERE conversation.tenant_id=$1 AND conversation.id=$2
         AND (conversation.created_by_user_id=$3 OR $4::boolean)
       GROUP BY conversation.id`,
      [scope.tenantId, input.conversationId, scope.userId, scope.canManage, input.messageId]
    );
    if (!result.rows[0]) throw tripzNotFound("Conversa não encontrada");
    return {
      providerRequests: result.rows[0].provider_requests,
      inputTokens: result.rows[0].input_tokens,
      outputTokens: result.rows[0].output_tokens,
      costUsd: Number(result.rows[0].cost_usd)
    };
  }

  async listMessageAttachmentIds(scope: TripzAccessScope, input: {
    conversationId: string;
    messageId: string;
  }): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT attachment.id
       FROM tripz_ai_attachments attachment
       JOIN tripz_ai_conversations conversation
         ON conversation.tenant_id=attachment.tenant_id AND conversation.id=attachment.conversation_id
       WHERE attachment.tenant_id=$1 AND attachment.conversation_id=$2
         AND attachment.message_id=$5
         AND (conversation.created_by_user_id=$3 OR $4::boolean)
       ORDER BY attachment.created_at,attachment.id`,
      [scope.tenantId, input.conversationId, scope.userId, scope.canManage, input.messageId]
    );
    return result.rows.map((row) => row.id);
  }

  async completeAiTurn(scope: TripzAccessScope, input: {
    conversationId: string;
    userMessageId: string;
    expectedRevision: number;
    proposal: TripzProposalState;
    assistantMessage: string;
    summary: string;
    attachmentResults: Array<{
      attachmentId: string;
      status: TripzAttachmentProcessingStatus;
      extractedText?: string;
      metadata?: Record<string, unknown>;
    }>;
  }): Promise<{ proposal: TripzProposal; assistantMessage: TripzMessage }> {
    return transaction(this.database, async (client) => {
      const conversation = await lockVisibleConversation(client, scope, input.conversationId);
      const currentResult = await client.query<ProposalRow>(
        `SELECT id,conversation_id,schema_version,revision,state,created_at,updated_at
         FROM tripz_ai_proposals WHERE tenant_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [scope.tenantId, input.conversationId]
      );
      if (!currentResult.rows[0]) throw new TripzAiError(500, "TRIPZ_PROPOSAL_MISSING", "Proposta não encontrada");
      const current = proposalFromRow(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw tripzConflict("TRIPZ_REVISION_CONFLICT", "A proposta foi alterada durante o processamento; tente novamente");
      }
      const state = tripzProposalStateSchema.parse(input.proposal);
      const attachmentIds = [...new Set(state.media.map((media) => media.attachmentId))];
      if (attachmentIds.length > 0) {
        const validMedia = await client.query<{ count: number }>(
          `SELECT count(*)::int count FROM tripz_ai_attachments
           WHERE tenant_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[])`,
          [scope.tenantId, input.conversationId, attachmentIds]
        );
        if (validMedia.rows[0].count !== attachmentIds.length) {
          throw new TripzAiError(400, "TRIPZ_MEDIA_INVALID", "Uma ou mais mídias não pertencem à conversa");
        }
      }
      const userMessage = await client.query<{ id: string }>(
        `SELECT id FROM tripz_ai_messages
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 AND role='user'
           AND processing_status='processing'
         FOR UPDATE`,
        [scope.tenantId, input.conversationId, input.userMessageId]
      );
      if (!userMessage.rows[0]) {
        throw tripzConflict("TRIPZ_TURN_STALE", "O turno não está mais ativo para conclusão");
      }
      const processedAttachmentIds = [...new Set(input.attachmentResults.map((attachment) => attachment.attachmentId))];
      if (processedAttachmentIds.length > 0) {
        const ownedAttachments = await client.query<{ count: number }>(
          `SELECT count(*)::int count FROM tripz_ai_attachments
           WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3
             AND id=ANY($4::uuid[])`,
          [scope.tenantId, input.conversationId, input.userMessageId, processedAttachmentIds]
        );
        if (ownedAttachments.rows[0].count !== processedAttachmentIds.length) {
          throw new TripzAiError(400, "TRIPZ_ATTACHMENT_INVALID", "Resultado de anexo não pertence à mensagem");
        }
      }

      const updated = await client.query<ProposalRow>(
        `UPDATE tripz_ai_proposals SET
           revision=revision+1,state=$3,missing_information=$4,issues=$5
         WHERE tenant_id=$1 AND conversation_id=$2
         RETURNING id,conversation_id,schema_version,revision,state,created_at,updated_at`,
        [scope.tenantId, input.conversationId, state,
          JSON.stringify(state.missingInformation), JSON.stringify(state.inconsistencies)]
      );
      const proposal = proposalFromRow(updated.rows[0]);

      await syncProposalMedia(client, scope, proposal, state);

      await client.query(
        `UPDATE tripz_ai_messages SET
           processing_status='completed',proposal_revision_after=$4,last_error_code=NULL,
           lease_expires_at=NULL
         WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
        [scope.tenantId, input.conversationId, input.userMessageId, proposal.revision]
      );
      const assistantResult = await client.query<MessageRow>(
        `INSERT INTO tripz_ai_messages(
           tenant_id,conversation_id,role,content,metadata,processing_status,
           proposal_revision_before,proposal_revision_after
         ) VALUES($1,$2,'assistant',$3,$4,'completed',$5,$6)
         RETURNING id,conversation_id,role,content,metadata,processing_status,
                   proposal_revision_before,proposal_revision_after,created_at,updated_at`,
        [scope.tenantId, input.conversationId, input.assistantMessage,
          { source: "tripz_ai", proposalRevision: proposal.revision },
          input.expectedRevision, proposal.revision]
      );
      for (const attachment of input.attachmentResults) {
        await client.query(
          `UPDATE tripz_ai_attachments SET processing_status=$4,
             extracted_text=COALESCE($5,extracted_text),
             metadata=metadata || COALESCE($6::jsonb,'{}'::jsonb)
           WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
          [scope.tenantId, input.conversationId, attachment.attachmentId,
            attachment.status, attachment.extractedText ?? null,
            attachment.metadata ? JSON.stringify(attachment.metadata) : null]
        );
      }
      await client.query(
        `UPDATE tripz_ai_conversations SET
           title=$3,status=$4,summary=$5,state_revision=$6,
           processing_status='idle',processing_error_code=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, input.conversationId,
          conversation.title_manually_set ? conversation.title : state.title ?? state.destination ?? conversation.title,
          state.status,
          input.summary.trim().slice(0, 5_000) || null, proposal.revision]
      );
      await client.query(
        "DELETE FROM tripz_ai_generated_documents WHERE tenant_id=$1 AND conversation_id=$2",
        [scope.tenantId, input.conversationId]
      );
      return { proposal, assistantMessage: messageFromRow(assistantResult.rows[0]) };
    });
  }

  async listQueuedTurnsForRecovery(input: {
    olderThanMs?: number;
    limit?: number;
  } = {}): Promise<TripzQueuedTurnRecovery[]> {
    const olderThanMs = Math.max(5_000, Math.min(300_000, Math.trunc(input.olderThanMs ?? 30_000)));
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const result = await this.database.query<{
      tenant_id: string;
      conversation_id: string;
      message_id: string;
      created_by_user_id: string;
      attachment_ids: string[];
    }>(
      `SELECT message.tenant_id,message.conversation_id,message.id message_id,
              message.created_by_user_id,
              COALESCE(array_agg(attachment.id ORDER BY attachment.created_at,attachment.id)
                FILTER (WHERE attachment.id IS NOT NULL),'{}'::uuid[]) attachment_ids
       FROM tripz_ai_messages message
       JOIN tripz_ai_conversations conversation
         ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
       LEFT JOIN tripz_ai_attachments attachment
         ON attachment.tenant_id=message.tenant_id
        AND attachment.conversation_id=message.conversation_id AND attachment.message_id=message.id
       WHERE message.role='user' AND message.processing_status='queued'
         AND conversation.processing_status='queued'
         AND message.created_at <= now() - ($1::int * interval '1 millisecond')
       GROUP BY message.tenant_id,message.conversation_id,message.id,message.created_by_user_id,message.created_at
       ORDER BY message.created_at,message.id
       LIMIT $2`,
      [olderThanMs, limit]
    );
    return result.rows.map((row) => ({
      scope: { tenantId: row.tenant_id, userId: row.created_by_user_id, canManage: false },
      conversationId: row.conversation_id,
      messageId: row.message_id,
      attachmentIds: row.attachment_ids
    }));
  }

  async failStaleProcessingTurns(input: { limit?: number } = {}): Promise<number> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const stale = await this.database.query<{ id: string; tenant_id: string; conversation_id: string }>(
      `SELECT id,tenant_id,conversation_id FROM tripz_ai_messages
       WHERE role='user' AND processing_status='processing'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
       ORDER BY lease_expires_at,id LIMIT $1`,
      [limit]
    );
    let failed = 0;
    for (const row of stale.rows) {
      const didFail = await transaction(this.database, async (client) => {
        const conversation = await client.query<{ id: string }>(
          `SELECT id FROM tripz_ai_conversations
           WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [row.tenant_id, row.conversation_id]
        );
        if (!conversation.rows[0]) return false;
        const message = await client.query<{ id: string }>(
          `UPDATE tripz_ai_messages SET processing_status='failed',
             last_error_code='TRIPZ_AI_WORKER_INTERRUPTED',lease_expires_at=NULL
           WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3
             AND role='user' AND processing_status='processing'
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
           RETURNING id`,
          [row.tenant_id, row.conversation_id, row.id]
        );
        if (!message.rows[0]) return false;
        await client.query(
          `UPDATE tripz_ai_attachments SET processing_status='failed',
             metadata=metadata || '{"errorCode":"TRIPZ_AI_WORKER_INTERRUPTED"}'::jsonb
           WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3
             AND processing_status IN ('pending','processing')`,
          [row.tenant_id, row.conversation_id, row.id]
        );
        await client.query(
          `UPDATE tripz_ai_conversations SET processing_status='failed',
             processing_error_code='TRIPZ_AI_WORKER_INTERRUPTED'
           WHERE tenant_id=$1 AND id=$2 AND processing_status='processing'`,
          [row.tenant_id, row.conversation_id]
        );
        return true;
      });
      if (didFail) failed += 1;
    }
    return failed;
  }

  private async getConversationRow(scope: TripzAccessScope, conversationId: string): Promise<ConversationRow | null> {
    const result = await this.database.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM tripz_ai_conversations conversation
       WHERE conversation.tenant_id=$1 AND conversation.id=$2
         AND (conversation.created_by_user_id=$3 OR $4::boolean)`,
      [scope.tenantId, conversationId, scope.userId, scope.canManage]
    );
    return result.rows[0] ?? null;
  }
}

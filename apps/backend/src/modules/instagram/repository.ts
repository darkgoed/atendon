import type { Pool, PoolClient } from "pg";
import type { SecretKeyring } from "../ai-router/secret-box.js";
import { decryptSecret, encryptSecret } from "../ai-router/secret-box.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import type { NormalizedInstagramEvent } from "./types.js";

interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

export interface InstagramConnectionRow {
  id: string;
  tenant_id: string;
  label: string;
  channel: "instagram";
  status: string;
  provider_account_id: string;
  provider_username: string | null;
  credentials_encrypted: string | null;
  token_expires_at: Date | string | null;
  reconnect_required: boolean;
  archived_at: Date | string | null;
}

export interface InstagramAccountOwner {
  tenantId: string;
  sessionId: string;
}

export interface InstagramConversationWindow {
  expiresAt: Date | null;
  conversationId: string;
}

export interface DueInstagramToken {
  tenantId: string;
  connectionId: string;
  expiresAt: Date;
}

export interface InstagramTokenSnapshot {
  token: string;
  encrypted: string;
}

export interface PublicInstagramMedia {
  id: string;
  bytes: Buffer;
  contentType: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface SaveInstagramConnectionInput {
  tenantId: string;
  id?: string;
  label: string;
  accountId: string;
  username?: string | null;
  accessToken: string;
  expiresAt: Date;
}

export interface SavePublicInstagramMediaInput {
  tenantId: string;
  sessionId: string;
  conversationId?: string | null;
  bytes: Buffer;
  contentType: string;
  expiresAt: Date;
  sourceUrl?: string | null;
  storageKey?: string | null;
}

function repositoryError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalizeKeyring(keyring: string | SecretKeyring): SecretKeyring {
  const normalized = typeof keyring === "string" ? { current: keyring } : keyring;
  if (!normalized.current?.trim()) {
    throw new Error("Instagram encryption key is required");
  }
  return normalized;
}

function isUniqueViolation(error: unknown): error is DatabaseError {
  return error instanceof Error && (error as DatabaseError).code === "23505";
}

export class InstagramRepository {
  private readonly keyring: SecretKeyring;

  constructor(
    private readonly db: Pick<Pool, "connect" | "query">,
    keyring: string | SecretKeyring,
    private readonly maxConnections = 10
  ) {
    this.keyring = normalizeKeyring(keyring);
    if (!Number.isInteger(maxConnections) || maxConnections < 1) {
      throw new Error("Instagram max connections must be a positive integer");
    }
  }

  async findConnection(tenantId: string, connectionId: string): Promise<InstagramConnectionRow | null> {
    const result = await this.db.query<InstagramConnectionRow>(
      `SELECT id,tenant_id,label,channel,status,provider_account_id,provider_username,
              credentials_encrypted,token_expires_at,reconnect_required,archived_at
       FROM whatsapp_sessions
       WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false
         AND provider_account_id IS NOT NULL AND credentials_encrypted IS NOT NULL`,
      [tenantId, connectionId]
    );
    return result.rows[0] ?? null;
  }

  async resolveAccount(accountId: string): Promise<InstagramAccountOwner | null> {
    const result = await this.db.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id,id
       FROM whatsapp_sessions
       WHERE provider_account_id=$1 AND channel='instagram' AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false`,
      [accountId]
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, sessionId: row.id } : null;
  }

  async saveConnection(input: SaveInstagramConnectionInput): Promise<InstagramConnectionRow> {
    const encrypted = encryptSecret(input.accessToken, this.keyring.current);
    try {
      return await withTenantTransaction(this.db, input.tenantId, async (client) => {
        const tenant = await client.query<{ id: string }>(
          "SELECT id FROM tenants WHERE id=$1 FOR UPDATE",
          [input.tenantId]
        );
        if (!tenant.rows[0]) throw repositoryError("Tenant not found", 404, "TENANT_NOT_FOUND");

        // Active ownership is global: one ACTIVE row per Meta account, so a
        // second tenant can never claim a live webhook stream. Archived rows
        // hold no credentials and are never routed, so they no longer block —
        // otherwise a disconnect would lock the account to this tenant forever.
        const activeOwner = await client.query<{ id: string; tenant_id: string; archived_at: Date | string | null }>(
          `SELECT id,tenant_id,archived_at FROM whatsapp_sessions
           WHERE channel='instagram' AND provider_account_id=$1 AND archived_at IS NULL
           FOR UPDATE`,
          [input.accountId]
        );
        if (activeOwner.rows[0] && activeOwner.rows[0].tenant_id !== input.tenantId) {
          throw repositoryError(
            "Instagram account already belongs to another tenant",
            409,
            "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED"
          );
        }

        let target: { id: string; archived_at: Date | string | null } | undefined;
        if (input.id) {
          const requested = await client.query<{ id: string; tenant_id: string; provider_account_id: string; archived_at: Date | string | null }>(
            `SELECT id,tenant_id,provider_account_id,archived_at
             FROM whatsapp_sessions
             WHERE id=$1 AND tenant_id=$2 AND channel='instagram'
             FOR UPDATE`,
            [input.id, input.tenantId]
          );
          const row = requested.rows[0];
          if (!row) throw repositoryError("Instagram connection not found", 404, "INSTAGRAM_CONNECTION_NOT_FOUND");
          if (row.provider_account_id !== input.accountId) {
            throw repositoryError(
              "Reauthorization returned another Instagram account",
              409,
              "INSTAGRAM_REAUTH_ACCOUNT_MISMATCH"
            );
          }
          target = row;
        } else if (activeOwner.rows[0]) {
          target = activeOwner.rows[0];
        } else {
          // Account is free everywhere: revive this tenant's most recent
          // archived row when one exists, so reconnecting keeps conversation
          // history linked to the same session.
          const archivedMine = await client.query<{ id: string; archived_at: Date | string | null }>(
            `SELECT id,archived_at FROM whatsapp_sessions
             WHERE tenant_id=$1 AND channel='instagram' AND provider_account_id=$2
               AND archived_at IS NOT NULL
             ORDER BY archived_at DESC LIMIT 1
             FOR UPDATE`,
            [input.tenantId, input.accountId]
          );
          target = archivedMine.rows[0];
        }

        const activatesConnection = !target || target.archived_at !== null;
        if (activatesConnection) {
          const count = await client.query<{ count: number }>(
            `SELECT count(*)::int count FROM whatsapp_sessions
             WHERE tenant_id=$1 AND channel='instagram' AND archived_at IS NULL`,
            [input.tenantId]
          );
          if (count.rows[0].count >= this.maxConnections) {
            throw repositoryError(
              "Instagram connection limit reached",
              409,
              "INSTAGRAM_CONNECTION_LIMIT"
            );
          }
        }

        const values = [
          input.tenantId,
          input.label,
          input.accountId,
          input.username ?? null,
          encrypted,
          input.expiresAt
        ];
        const result = target
          ? await client.query<InstagramConnectionRow>(
            `UPDATE whatsapp_sessions
             SET label=$2,provider_account_id=$3,provider_username=$4,
                 credentials_encrypted=$5,token_expires_at=$6,
                 status='connected',reconnect_required=false,disconnected_reason=NULL,
                 archived_at=NULL,is_primary=false,phone_number=NULL
             WHERE tenant_id=$1 AND id=$7 AND channel='instagram'
             RETURNING id,tenant_id,label,channel,status,provider_account_id,provider_username,
                       credentials_encrypted,token_expires_at,reconnect_required,archived_at`,
            [...values, target.id]
          )
          : await client.query<InstagramConnectionRow>(
            `INSERT INTO whatsapp_sessions(
               tenant_id,label,channel,is_primary,status,phone_number,provider_account_id,
               provider_username,credentials_encrypted,token_expires_at,reconnect_required
             ) VALUES($1,$2,'instagram',false,'connected',NULL,$3,$4,$5,$6,false)
             RETURNING id,tenant_id,label,channel,status,provider_account_id,provider_username,
                       credentials_encrypted,token_expires_at,reconnect_required,archived_at`,
            values
          );
        return result.rows[0];
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw repositoryError(
          "Instagram account already belongs to another tenant",
          409,
          "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED"
        );
      }
      throw error;
    }
  }

  async getToken(tenantId: string, connectionId: string): Promise<string> {
    return (await this.getTokenSnapshot(tenantId, connectionId)).token;
  }

  async getTokenSnapshot(tenantId: string, connectionId: string): Promise<InstagramTokenSnapshot> {
    const result = await this.db.query<{ credentials_encrypted: string | null }>(
      `SELECT credentials_encrypted FROM whatsapp_sessions
       WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false
         AND provider_account_id IS NOT NULL`,
      [tenantId, connectionId]
    );
    const encrypted = result.rows[0]?.credentials_encrypted;
    if (!encrypted) {
      throw repositoryError("Instagram connection not found", 404, "INSTAGRAM_CONNECTION_NOT_FOUND");
    }
    return {
      token: decryptSecret(encrypted, this.keyring),
      encrypted
    };
  }

  async finalizeOAuthConnection(
    tenantId: string,
    connectionId: string,
    expectedEncrypted: string
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE whatsapp_sessions
       SET last_connected_at=now()
       WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false
         AND credentials_encrypted=$3
       RETURNING id`,
      [tenantId, connectionId, expectedEncrypted]
    );
    return result.rows[0] !== undefined;
  }

  async disconnect(tenantId: string, connectionId: string): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE whatsapp_sessions
         SET archived_at=now(),status='disconnected',credentials_encrypted=NULL,
             token_expires_at=NULL,reconnect_required=true,disconnected_reason='manual',is_primary=false
         WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
         RETURNING id`,
        [tenantId, connectionId]
      );
      if (!result.rows[0]) return false;
      await this.invalidatePendingSends(client, tenantId, connectionId, "connection_disconnected");
      await client.query(
        `UPDATE instagram_oauth_states SET consumed_at=COALESCE(consumed_at,now())
         WHERE tenant_id=$1 AND connection_id=$2 AND consumed_at IS NULL`,
        [tenantId, connectionId]
      );
      return true;
    });
  }

  async markConnectionRevoked(
    tenantId: string,
    connectionId: string,
    reason = "token_revoked",
    expectedEncrypted?: string
  ): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE whatsapp_sessions
         SET status='disconnected',credentials_encrypted=NULL,token_expires_at=NULL,
             reconnect_required=true,disconnected_reason=$3
         WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
           AND ($4::text IS NULL OR credentials_encrypted=$4)
         RETURNING id`,
        [tenantId, connectionId, reason, expectedEncrypted ?? null]
      );
      if (!result.rows[0]) return false;
      await this.invalidatePendingSends(client, tenantId, connectionId, reason);
      return true;
    });
  }

  async updateToken(
    tenantId: string,
    connectionId: string,
    token: string,
    expiresAt: Date,
    expectedEncrypted?: string
  ): Promise<boolean> {
    const encrypted = encryptSecret(token, this.keyring.current);
    const result = await this.db.query<{ id: string }>(
      `UPDATE whatsapp_sessions
       SET credentials_encrypted=$3,token_expires_at=$4,status='connected',
           reconnect_required=false,disconnected_reason=NULL
       WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false AND credentials_encrypted IS NOT NULL
         AND ($5::text IS NULL OR credentials_encrypted=$5)
       RETURNING id`,
      [tenantId, connectionId, encrypted, expiresAt, expectedEncrypted ?? null]
    );
    if (!result.rows[0] && expectedEncrypted === undefined) {
      throw repositoryError("Revoked Instagram connection cannot be refreshed", 409, "INSTAGRAM_REAUTH_REQUIRED");
    }
    return result.rows[0] !== undefined;
  }

  async listActiveTenants(): Promise<string[]> {
    const result = await this.db.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM whatsapp_sessions
       WHERE channel='instagram' AND archived_at IS NULL AND status='connected'
         AND reconnect_required=false AND credentials_encrypted IS NOT NULL
       ORDER BY tenant_id`
    );
    return result.rows.map((row) => row.tenant_id);
  }

  async refreshDueTokens(cutoff: Date): Promise<DueInstagramToken[]> {
    const result = await this.db.query<{ tenant_id: string; id: string; token_expires_at: Date | string }>(
      `SELECT tenant_id,id,token_expires_at FROM whatsapp_sessions
       WHERE channel='instagram' AND archived_at IS NULL AND status='connected'
         AND reconnect_required=false AND credentials_encrypted IS NOT NULL
         AND token_expires_at IS NOT NULL AND token_expires_at <= $1
       ORDER BY token_expires_at,id`,
      [cutoff]
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      connectionId: row.id,
      expiresAt: new Date(row.token_expires_at)
    }));
  }

  async getConversationWindow(
    tenantId: string,
    connectionId: string,
    instagramContactId: string
  ): Promise<InstagramConversationWindow | null> {
    const result = await this.db.query<{ id: string; messaging_window_expires_at: Date | string | null }>(
      `SELECT id,messaging_window_expires_at FROM conversations
       WHERE tenant_id=$1 AND session_id=$2 AND instagram_contact_id=$3`,
      [tenantId, connectionId, instagramContactId]
    );
    const row = result.rows[0];
    return row ? {
      conversationId: row.id,
      expiresAt: row.messaging_window_expires_at ? new Date(row.messaging_window_expires_at) : null
    } : null;
  }

  async persistEvent(
    tenantId: string,
    sessionId: string,
    event: NormalizedInstagramEvent,
    rawBody: Buffer
  ): Promise<{ duplicate: boolean; conversationId: string | null }> {
    return withTenantTransaction(this.db, tenantId, async (client) => {
      const connection = await client.query<{ provider_account_id: string }>(
        `SELECT provider_account_id FROM whatsapp_sessions
         WHERE tenant_id=$1 AND id=$2 AND channel='instagram' AND archived_at IS NULL
           AND status='connected' AND reconnect_required=false
         FOR UPDATE`,
        [tenantId, sessionId]
      );
      if (!connection.rows[0]) {
        throw repositoryError("Instagram connection not found", 404, "INSTAGRAM_CONNECTION_NOT_FOUND");
      }
      if (connection.rows[0].provider_account_id !== event.accountId) {
        throw repositoryError("Instagram webhook account mismatch", 409, "INSTAGRAM_ACCOUNT_MISMATCH");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO instagram_webhook_inbox(
           tenant_id,session_id,provider_event_id,account_id,raw_body,payload
         ) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(tenant_id,session_id,provider_event_id) DO NOTHING
         RETURNING id`,
        [tenantId, sessionId, event.eventId, event.accountId, rawBody, event.raw]
      );
      if (!inserted.rows[0]) return { duplicate: true, conversationId: null };
      if (event.kind !== "message" || event.isEcho || !event.providerUserId) {
        return { duplicate: false, conversationId: null };
      }

      const eventTimestamp = event.timestamp.getTime();
      if (!Number.isFinite(eventTimestamp) || eventTimestamp > Date.now()) {
        return { duplicate: false, conversationId: null };
      }
      const receivedAt = new Date(eventTimestamp);
      const lead = await client.query<{ id: string }>(
        `INSERT INTO scheduling_leads(
           tenant_id,phone,name,source,instagram_contact_id,instagram_session_id
         ) VALUES($1,NULL,NULL,'instagram',$2,$3)
         ON CONFLICT(tenant_id,instagram_session_id,instagram_contact_id)
           WHERE instagram_contact_id IS NOT NULL
         DO UPDATE SET updated_at=now()
         RETURNING id`,
        [tenantId, event.providerUserId, sessionId]
      );
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO conversations(
           tenant_id,session_id,contact_phone,instagram_contact_id,lead_id,contact_thread_id,
           last_message_at,provider_last_user_message_at,messaging_window_expires_at,status
         ) VALUES($1,$2,NULL,$3,$4,$5,$6::timestamptz,$6::timestamptz,$6::timestamptz+interval '24 hours','open')
         ON CONFLICT(tenant_id,session_id,instagram_contact_id)
           WHERE instagram_contact_id IS NOT NULL
         DO UPDATE SET
           last_message_at=GREATEST(conversations.last_message_at,EXCLUDED.last_message_at),
           provider_last_user_message_at=GREATEST(
             conversations.provider_last_user_message_at,
             EXCLUDED.provider_last_user_message_at
           ),
           messaging_window_expires_at=GREATEST(
             conversations.messaging_window_expires_at,
             EXCLUDED.messaging_window_expires_at
           ),
           contact_thread_id=COALESCE(EXCLUDED.contact_thread_id,conversations.contact_thread_id)
         RETURNING id`,
        [
          tenantId,
          sessionId,
          event.providerUserId,
          lead.rows[0].id,
          event.providerThreadId ?? null,
          receivedAt
        ]
      );
      return { duplicate: false, conversationId: conversation.rows[0].id };
    });
  }

  async claimInbox(tenantId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    return withTenantTransaction(this.db, tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE instagram_webhook_inbox SET claimed_at=now(),attempts=attempts+1
         WHERE id IN (
           SELECT id FROM instagram_webhook_inbox
           WHERE tenant_id=$1 AND processed_at IS NULL
             AND (claimed_at IS NULL OR claimed_at<now()-interval '5 minutes')
           ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         RETURNING *`,
        [tenantId, limit]
      );
      return result.rows;
    });
  }

  async markProcessed(tenantId: string, id: string, error?: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (client) => {
      await client.query(
        `UPDATE instagram_webhook_inbox
         SET processed_at=CASE WHEN $3::text IS NULL THEN now() ELSE processed_at END,
             claimed_at=CASE WHEN $3::text IS NULL THEN claimed_at ELSE NULL END,
             last_error=$3::text
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, id, error ?? null]
      );
    });
  }

  async savePublicMedia(input: SavePublicInstagramMediaInput): Promise<{ id: string }> {
    return withTenantTransaction(this.db, input.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO instagram_media(
           tenant_id,session_id,conversation_id,external_url,storage_key,media_data,
           content_type,size_bytes,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          input.tenantId,
          input.sessionId,
          input.conversationId ?? null,
          input.sourceUrl ?? null,
          input.storageKey ?? null,
          input.bytes,
          input.contentType,
          input.bytes.length,
          input.expiresAt
        ]
      );
      return result.rows[0];
    });
  }

  async getPublicMedia(id: string): Promise<PublicInstagramMedia | null> {
    const result = await this.db.query<{
      id: string;
      media_data: Buffer;
      content_type: string;
      size_bytes: string | number;
      expires_at: Date | string;
    }>(
      `SELECT id,media_data,content_type,size_bytes,expires_at
       FROM get_signed_instagram_public_media($1)`,
      [id]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      bytes: row.media_data,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      expiresAt: new Date(row.expires_at)
    } : null;
  }

  private async invalidatePendingSends(
    client: PoolClient,
    tenantId: string,
    connectionId: string,
    failureCode: string
  ): Promise<void> {
    await client.query(
      `UPDATE instagram_webhook_outbox
       SET status='rejected',failure_code=$3,invalidated_at=now()
       WHERE tenant_id=$1 AND session_id=$2 AND status='pending'`,
      [tenantId, connectionId, failureCode]
    );
  }
}

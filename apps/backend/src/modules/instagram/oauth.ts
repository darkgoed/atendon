import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTenantTransaction } from "../../db/tenant-transaction.js";

export function hashOAuthBrowserNonce(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOAuthState(): { state: string; browserNonce: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    browserNonce: randomBytes(32).toString("base64url")
  };
}

export interface CreateInstagramOAuthStateInput {
  tenantId: string;
  userId: string;
  sessionVersion: number;
  state: string;
  browserNonce: string;
  redirectUri: string;
  label: string;
  connectionId?: string;
  forceReauth?: boolean;
  expiresSeconds?: number;
}

export interface ConsumeInstagramOAuthStateInput {
  tenantId: string;
  userId: string;
  sessionVersion: number;
  state: string;
  browserNonce: string;
  redirectUri: string;
}

export interface ConsumedInstagramOAuthState {
  tenantId: string;
  userId: string;
  label: string;
  connectionId: string | null;
  forceReauth: boolean;
}

function oauthError(): Error {
  return Object.assign(new Error("OAuth state inválido ou expirado"), {
    statusCode: 400,
    code: "INSTAGRAM_OAUTH_STATE_INVALID"
  });
}

export class InstagramOAuthStore {
  constructor(private readonly db: Pick<Pool, "connect" | "query">) {}

  async create(input: CreateInstagramOAuthStateInput): Promise<void> {
    await withTenantTransaction(this.db, input.tenantId, async (client) => {
      if (input.connectionId) {
        const connection = await client.query<{ id: string }>(
          `SELECT id FROM whatsapp_sessions
           WHERE tenant_id=$1 AND id=$2 AND channel='instagram'
           FOR UPDATE`,
          [input.tenantId, input.connectionId]
        );
        if (!connection.rows[0]) throw oauthError();
      }
      await client.query(
        `INSERT INTO instagram_oauth_states(
           state,tenant_id,user_id,session_version,browser_nonce_hash,redirect_uri,
           label,connection_id,force_reauth,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(secs => $10))`,
        [
          input.state,
          input.tenantId,
          input.userId,
          input.sessionVersion,
          hashOAuthBrowserNonce(input.browserNonce),
          input.redirectUri,
          input.label,
          input.connectionId ?? null,
          input.forceReauth ?? false,
          input.expiresSeconds ?? 600
        ]
      );
    });
  }

  async consume(input: ConsumeInstagramOAuthStateInput): Promise<ConsumedInstagramOAuthState> {
    return withTenantTransaction(this.db, input.tenantId, async (client) => {
      const result = await client.query<{
        tenant_id: string;
        user_id: string;
        label: string;
        connection_id: string | null;
        force_reauth: boolean;
      }>(
        `UPDATE instagram_oauth_states
         SET consumed_at=now()
         WHERE state=$1 AND tenant_id=$2 AND user_id=$3 AND session_version=$4
           AND redirect_uri=$5 AND browser_nonce_hash=$6
           AND consumed_at IS NULL AND expires_at>now()
         RETURNING tenant_id,user_id,label,connection_id,force_reauth`,
        [
          input.state,
          input.tenantId,
          input.userId,
          input.sessionVersion,
          input.redirectUri,
          hashOAuthBrowserNonce(input.browserNonce)
        ]
      );
      const row = result.rows[0];
      if (!row) throw oauthError();
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        label: row.label,
        connectionId: row.connection_id,
        forceReauth: row.force_reauth
      };
    });
  }
}

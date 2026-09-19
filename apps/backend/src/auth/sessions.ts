import type { Pool } from "pg";
import { db } from "../db/client.js";
import { randomUUID } from "node:crypto";

/**
 * B2 Security (b): sessões ativas revogáveis (workspace_sessions, migration
 * 0178). O cookie continua sendo o JWT de 12h; a revogação real acontece
 * porque requireIdentity consulta a linha pelo `sid` embutido no payload.
 * Tokens emitidos ANTES desta migration não têm sid — seguem válidos até o
 * TTL (compatibilidade com logins existentes, spec: nunca quebrar o login).
 */

const SESSION_TTL_SECONDS = 43_200; // 12h — mesmo TTL do cookie.

export type WorkspaceSessionRow = {
  id: string;
  user_id: string;
  tenant_id: string | null;
  kind: "session" | "totp_challenge";
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

export async function createWorkspaceSessionRow(
  input: {
    userId: string;
    tenantId?: string | null;
    kind?: "session" | "totp_challenge";
    ttlSeconds?: number;
    ip?: string;
    userAgent?: string;
    client?: Pick<Pool, "query">;
  }
): Promise<string> {
  const id = randomUUID();
  const executor = input.client ?? db;
  await executor.query(
    `INSERT INTO workspace_sessions(id,user_id,tenant_id,kind,ip_address,user_agent,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,now() + make_interval(secs => $7::double precision))`,
    [
      id,
      input.userId,
      input.tenantId ?? null,
      input.kind ?? "session",
      input.ip ?? null,
      input.userAgent ?? null,
      input.ttlSeconds ?? SESSION_TTL_SECONDS
    ]
  );
  return id;
}

export type WorkspaceSessionListItem = {
  id: string;
  created_at: string;
  expires_at: string;
  current: boolean;
  ip_address: string | null;
  user_agent: string | null;
};

export async function listWorkspaceSessions(
  userId: string,
  currentSid: string | null
): Promise<WorkspaceSessionListItem[]> {
  const result = await db.query<WorkspaceSessionRow>(
    `SELECT id,user_id,tenant_id,kind,ip_address,user_agent,created_at,expires_at,revoked_at
     FROM workspace_sessions
     WHERE user_id=$1 AND kind='session' AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC,id`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    current: row.id === currentSid,
    ip_address: row.ip_address,
    user_agent: row.user_agent
  }));
}

export async function revokeWorkspaceSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `UPDATE workspace_sessions
     SET revoked_at=now()
     WHERE user_id=$1 AND id=$2 AND kind='session' AND revoked_at IS NULL
     RETURNING id`,
    [userId, sessionId]
  );
  return Boolean(result.rows[0]);
}

export async function revokeOtherSessions(userId: string, currentSid: string): Promise<number> {
  const result = await db.query<{ id: string }>(
    `UPDATE workspace_sessions
     SET revoked_at=now()
     WHERE user_id=$1 AND kind='session' AND revoked_at IS NULL AND id<>$2
     RETURNING id`,
    [userId, currentSid]
  );
  return result.rows.length;
}

export async function isWorkspaceSessionRevoked(
  userId: string,
  sid: string
): Promise<boolean> {
  const result = await db.query<{ kind: string; revoked_at: Date | string | null; expires_at: Date | string }>(
    "SELECT kind,revoked_at,expires_at FROM workspace_sessions WHERE id=$1 AND user_id=$2",
    [sid, userId]
  );
  const row = result.rows[0];
  if (!row) return true; // linha ausente: sessão não registrada/limpa — trate como revogada.
  if (row.kind !== "session") return true;
  if (row.revoked_at) return true;
  return new Date(row.expires_at).getTime() <= Date.now();
}

export async function insertSecurityAudit(
  executor: Pick<Pool, "query">,
  input: {
    actorUserId: string;
    workspaceId?: string | null;
    actorScope: "root" | "workspace";
    action: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  await executor.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'user',$5,$6,$7,$8)`,
    [
      input.actorUserId,
      input.workspaceId ?? null,
      input.actorScope,
      input.action,
      input.resourceId ?? input.actorUserId,
      input.metadata ?? {},
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );
}

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  API_KEY_SCOPE_DESCRIPTIONS,
  API_KEY_SCOPES,
  hashApiKey,
  type ApiKeyScope
} from "../../auth/api-key.js";
import { requireRootWorkspace, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";

const apiKeyIdParams = z.object({ keyId: z.string().uuid() });
const scope = z.enum(API_KEY_SCOPES);
const scopes = z.array(scope).min(1).max(API_KEY_SCOPES.length)
  .refine((value) => new Set(value).size === value.length, "Não repita scopes");
const expiresAt = z.string().datetime({ offset: true }).nullable();
const createApiKeyBody = z.object({
  name: z.string().trim().min(2).max(100),
  scopes,
  expiresAt: expiresAt.optional()
});
const rotateApiKeyBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  scopes: scopes.optional(),
  expiresAt: expiresAt.optional()
}).default({});

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string | null;
  scopes: ApiKeyScope[];
  active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  rotated_from_id: string | null;
  created_by_email?: string | null;
  revoked_by_email?: string | null;
}

function apiError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function createSecret() {
  return `atd_${randomBytes(32).toString("base64url")}`;
}

function validateExpiration(value: string | null | undefined) {
  if (value && new Date(value).getTime() <= Date.now()) {
    throw apiError(400, "A expiração deve estar no futuro");
  }
  return value ?? null;
}

function mapApiKey(row: ApiKeyRow) {
  const expired = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  const status = row.revoked_at ? "revoked" : expired ? "expired" : row.active ? "active" : "inactive";
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    status,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedFromId: row.rotated_from_id,
    createdByEmail: row.created_by_email ?? null,
    revokedByEmail: row.revoked_by_email ?? null
  };
}

function requestContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
  };
}

async function insertAudit(
  client: PoolClient,
  session: WorkspaceSession,
  request: FastifyRequest,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>
) {
  const context = requestContext(request);
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'tenant_api_key',$5,$6,$7,$8)`,
    [session.userId, session.tenantId, session.actorScope, action, resourceId, metadata, context.ipAddress, context.userAgent]
  );
}

async function insertKey(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    scopes: ApiKeyScope[];
    expiresAt: string | null;
    rotatedFromId?: string;
  }
) {
  const secret = createSecret();
  const key = await client.query<ApiKeyRow>(
    `INSERT INTO tenant_api_keys(tenant_id,name,key_hash,key_prefix,scopes,expires_at,created_by_user_id,rotated_from_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,name,key_prefix,scopes,active,expires_at,revoked_at,last_used_at,created_at,updated_at,rotated_from_id`,
    [
      input.tenantId,
      input.name,
      hashApiKey(secret),
      secret.slice(0, 12),
      input.scopes,
      input.expiresAt,
      input.userId,
      input.rotatedFromId ?? null
    ]
  );
  return { secret, row: key.rows[0] };
}

export function registerWorkspaceApiKeyRoutes(app: FastifyInstance) {
  app.get("/workspaces/current/api-keys", async (request) => {
    const session = await requireRootWorkspace(request);
    const result = await db.query<ApiKeyRow>(
      `SELECT k.id,k.name,k.key_prefix,k.scopes,k.active,k.expires_at,k.revoked_at,k.last_used_at,k.created_at,k.updated_at,
              k.rotated_from_id,creator.email created_by_email,revoker.email revoked_by_email
       FROM tenant_api_keys k
       LEFT JOIN users creator ON creator.id=k.created_by_user_id
       LEFT JOIN users revoker ON revoker.id=k.revoked_by_user_id
       WHERE k.tenant_id=$1
       ORDER BY k.created_at DESC,k.id DESC`,
      [session.tenantId]
    );
    return {
      apiKeys: result.rows.map(mapApiKey),
      availableScopes: API_KEY_SCOPES.map((key) => ({ key, description: API_KEY_SCOPE_DESCRIPTIONS[key] }))
    };
  });

  app.post("/workspaces/current/api-keys", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = createApiKeyBody.parse(request.body);
    const expiration = validateExpiration(body.expiresAt);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const created = await insertKey(client, {
        tenantId: session.tenantId,
        userId: session.userId,
        name: body.name,
        scopes: body.scopes,
        expiresAt: expiration
      });
      await insertAudit(client, session, request, "api_keys.create", created.row.id, {
        name: body.name,
        scopes: body.scopes,
        expiresAt: expiration,
        keyPrefix: created.row.key_prefix
      });
      await client.query("COMMIT");
      return reply.status(201).send({ apiKey: mapApiKey(created.row), secret: created.secret });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/workspaces/current/api-keys/:keyId/rotate", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { keyId } = apiKeyIdParams.parse(request.params);
    const body = rotateApiKeyBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<ApiKeyRow>(
        `SELECT id,name,key_prefix,scopes,active,expires_at,revoked_at,last_used_at,created_at,updated_at,rotated_from_id
         FROM tenant_api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [session.tenantId, keyId]
      );
      const previous = existing.rows[0];
      if (!previous) throw apiError(404, "Chave de API não encontrada");
      if (!previous.active || previous.revoked_at) throw apiError(409, "Chave de API já está revogada");
      const pendingReplacement = await client.query<{ id: string }>(
        `SELECT id FROM tenant_api_keys
         WHERE tenant_id=$1 AND rotated_from_id=$2 AND active=true AND revoked_at IS NULL
         LIMIT 1`,
        [session.tenantId, previous.id]
      );
      if (pendingReplacement.rows[0]) throw apiError(409, "Esta chave já possui uma rotação pendente");
      const expiration = validateExpiration(body.expiresAt === undefined ? previous.expires_at : body.expiresAt);
      const nextName = body.name ?? previous.name;
      const nextScopes = body.scopes ?? previous.scopes;
      const created = await insertKey(client, {
        tenantId: session.tenantId,
        userId: session.userId,
        name: nextName,
        scopes: nextScopes,
        expiresAt: expiration,
        rotatedFromId: previous.id
      });
      await insertAudit(client, session, request, "api_keys.rotate.stage", previous.id, {
        newKeyId: created.row.id,
        previousKeyRemainsActive: true,
        name: nextName,
        scopes: nextScopes,
        expiresAt: expiration,
        keyPrefix: created.row.key_prefix
      });
      await client.query("COMMIT");
      return reply.status(201).send({
        apiKey: mapApiKey(created.row),
        secret: created.secret,
        rotation: { previousKeyId: previous.id, previousKeyRemainsActive: true }
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/workspaces/current/api-keys/:keyId", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { keyId } = apiKeyIdParams.parse(request.params);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string; revoked_at: string | null }>(
        "SELECT id,revoked_at FROM tenant_api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [session.tenantId, keyId]
      );
      if (!existing.rows[0]) throw apiError(404, "Chave de API não encontrada");
      if (!existing.rows[0].revoked_at) {
        const replacements = await client.query<{ id: string }>(
          "SELECT id FROM tenant_api_keys WHERE tenant_id=$1 AND rotated_from_id=$2 ORDER BY created_at",
          [session.tenantId, keyId]
        );
        await client.query(
          `UPDATE tenant_api_keys
           SET active=false,revoked_at=now(),revoked_by_user_id=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [session.tenantId, keyId, session.userId]
        );
        await insertAudit(client, session, request, "api_keys.revoke", keyId, {
          stagedReplacementIds: replacements.rows.map((row) => row.id)
        });
      }
      await client.query("COMMIT");
      return reply.status(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

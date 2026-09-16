import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import type {
  InstagramAccountOwner,
  InstagramRepository,
  InstagramTokenSnapshot
} from "./repository.js";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const CALLBACK_PATH = "/instagram/deauthorize";
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_FUTURE_TOLERANCE_SECONDS = 5 * 60;
const META_ALGORITHM = "HMAC-SHA256";
const ACCOUNT_ID_PATTERN = /^[0-9]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type DeauthorizationDatabase = Pick<Pool, "connect" | "query">;
type DeauthorizationRepository = Pick<
  InstagramRepository,
  "resolveAccount" | "getTokenSnapshot"
>;

type SignedRequestPayload = {
  algorithm: typeof META_ALGORITHM;
  issuedAt: number;
  accountId: string;
};

type CurrentAuthorizationRow = {
  credentials_encrypted: string;
  created_at: Date | string;
  last_connected_at: Date | string | null;
  latest_oauth_at: Date | string | null;
};

export type InstagramDeauthorizationPluginOptions = {
  appSecret: string;
  database: DeauthorizationDatabase;
  repository: DeauthorizationRepository;
  now?: () => Date;
  maxAgeSeconds?: number;
  futureToleranceSeconds?: number;
};

class InvalidCallbackError extends Error {
  constructor(readonly statusCode: 400 | 401) {
    super("invalid Instagram deauthorization callback");
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new InvalidCallbackError(400);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new InvalidCallbackError(400);
  }
  return decoded;
}

function parseCanonicalForm(body: unknown): string {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_BODY_BYTES) {
    throw new InvalidCallbackError(400);
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidCallbackError(400);
  }
  const form = new URLSearchParams(raw);
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== "signed_request") {
    throw new InvalidCallbackError(400);
  }
  const value = entries[0][1];
  if (raw !== `signed_request=${value}`) throw new InvalidCallbackError(400);
  return value;
}

function verifyAndParseSignedRequest(
  signedRequest: string,
  appSecret: string,
  nowSeconds: number,
  maxAgeSeconds: number,
  futureToleranceSeconds: number
): SignedRequestPayload {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) throw new InvalidCallbackError(400);
  const [encodedSignature, encodedPayload] = parts;
  const suppliedSignature = decodeCanonicalBase64Url(encodedSignature);
  if (suppliedSignature.length !== 32) throw new InvalidCallbackError(401);
  decodeCanonicalBase64Url(encodedPayload);

  const expectedSignature = createHmac("sha256", appSecret)
    .update(encodedPayload, "ascii")
    .digest();
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new InvalidCallbackError(401);
  }

  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.from(encodedPayload, "base64url"));
    value = JSON.parse(json);
  } catch {
    throw new InvalidCallbackError(400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCallbackError(400);
  }
  const payload = value as Record<string, unknown>;
  if (payload.algorithm !== META_ALGORITHM) throw new InvalidCallbackError(400);
  if (!Number.isSafeInteger(payload.issued_at) || Number(payload.issued_at) <= 0) {
    throw new InvalidCallbackError(400);
  }
  if (typeof payload.user_id !== "string" || !ACCOUNT_ID_PATTERN.test(payload.user_id)) {
    throw new InvalidCallbackError(400);
  }

  const issuedAt = Number(payload.issued_at);
  if (issuedAt > nowSeconds + futureToleranceSeconds) throw new InvalidCallbackError(400);
  if (issuedAt < nowSeconds - maxAgeSeconds) throw new InvalidCallbackError(400);
  return {
    algorithm: META_ALGORITHM,
    issuedAt,
    accountId: payload.user_id
  };
}

function timestampSecondsCeil(value: Date | string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("invalid authorization timestamp");
  return Math.ceil(timestamp / 1000);
}

function latestAuthorizationSeconds(row: CurrentAuthorizationRow): number {
  return Math.max(
    timestampSecondsCeil(row.created_at),
    ...(row.last_connected_at ? [timestampSecondsCeil(row.last_connected_at)] : []),
    ...(row.latest_oauth_at ? [timestampSecondsCeil(row.latest_oauth_at)] : [])
  );
}

async function loadOwnerAndCredential(
  repository: DeauthorizationRepository,
  accountId: string
): Promise<{ owner: InstagramAccountOwner; snapshot: InstagramTokenSnapshot } | null> {
  const owner = await repository.resolveAccount(accountId);
  if (!owner) return null;
  try {
    const snapshot = await repository.getTokenSnapshot(owner.tenantId, owner.sessionId);
    return { owner, snapshot };
  } catch (error) {
    if (error instanceof Error
      && "code" in error
      && (error as Error & { code?: unknown }).code === "INSTAGRAM_CONNECTION_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

async function revokeIfCurrent(
  database: DeauthorizationDatabase,
  owner: InstagramAccountOwner,
  accountId: string,
  expectedEncrypted: string,
  issuedAt: number
): Promise<boolean> {
  return withTenantTransaction(database, owner.tenantId, async (client) => {
    const current = await client.query<CurrentAuthorizationRow>(
      `SELECT session.credentials_encrypted,session.created_at,session.last_connected_at,
              (
                SELECT max(state.consumed_at)
                FROM instagram_oauth_states state
                WHERE state.tenant_id=session.tenant_id
                  AND state.connection_id=session.id
                  AND state.consumed_at IS NOT NULL
              ) latest_oauth_at
       FROM whatsapp_sessions session
       WHERE session.tenant_id=$1 AND session.id=$2 AND session.channel='instagram'
         AND session.provider_account_id=$3 AND session.archived_at IS NULL
         AND session.status='connected' AND session.reconnect_required=false
         AND session.credentials_encrypted=$4
       FOR UPDATE`,
      [owner.tenantId, owner.sessionId, accountId, expectedEncrypted]
    );
    const authorization = current.rows[0];
    if (!authorization || issuedAt < latestAuthorizationSeconds(authorization)) return false;

    const revoked = await client.query<{ id: string }>(
      `UPDATE whatsapp_sessions
       SET status='disconnected',credentials_encrypted=NULL,token_expires_at=NULL,
           reconnect_required=true,disconnected_reason='meta_deauthorized'
       WHERE tenant_id=$1 AND id=$2 AND channel='instagram'
         AND provider_account_id=$3 AND archived_at IS NULL
         AND status='connected' AND reconnect_required=false
         AND credentials_encrypted=$4
       RETURNING id`,
      [owner.tenantId, owner.sessionId, accountId, expectedEncrypted]
    );
    if (!revoked.rows[0]) return false;

    await client.query(
      `UPDATE instagram_webhook_outbox
       SET status='rejected',failure_code='meta_deauthorized',invalidated_at=now()
       WHERE tenant_id=$1 AND session_id=$2 AND status='pending'`,
      [owner.tenantId, owner.sessionId]
    );
    await client.query(
      `UPDATE instagram_oauth_states
       SET consumed_at=COALESCE(consumed_at,now())
       WHERE tenant_id=$1 AND connection_id=$2 AND consumed_at IS NULL`,
      [owner.tenantId, owner.sessionId]
    );
    return true;
  });
}

function genericReply(reply: FastifyReply, statusCode: number, ok: boolean): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .code(statusCode)
    .send({ ok });
}

async function handleDeauthorization(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Required<Pick<
    InstagramDeauthorizationPluginOptions,
    "appSecret" | "database" | "repository" | "now" | "maxAgeSeconds" | "futureToleranceSeconds"
  >>
): Promise<FastifyReply> {
  try {
    const signedRequest = parseCanonicalForm(request.body);
    const now = options.now();
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds)) throw new Error("invalid callback clock");
    const payload = verifyAndParseSignedRequest(
      signedRequest,
      options.appSecret,
      Math.floor(nowMilliseconds / 1000),
      options.maxAgeSeconds,
      options.futureToleranceSeconds
    );
    const current = await loadOwnerAndCredential(options.repository, payload.accountId);
    if (current) {
      await revokeIfCurrent(
        options.database,
        current.owner,
        payload.accountId,
        current.snapshot.encrypted,
        payload.issuedAt
      );
    }
    return genericReply(reply, 200, true);
  } catch (error) {
    if (error instanceof InvalidCallbackError) {
      return genericReply(reply, error.statusCode, false);
    }
    return genericReply(reply, 503, false);
  }
}

export const instagramDeauthorizationPlugin: FastifyPluginAsync<InstagramDeauthorizationPluginOptions> = async (
  app,
  pluginOptions
) => {
  const appSecret = pluginOptions.appSecret;
  if (typeof appSecret !== "string" || appSecret.length === 0) {
    throw new Error("Instagram App Secret is required for deauthorization callbacks");
  }
  const maxAgeSeconds = pluginOptions.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const futureToleranceSeconds = pluginOptions.futureToleranceSeconds ?? DEFAULT_FUTURE_TOLERANCE_SECONDS;
  requirePositiveInteger(maxAgeSeconds, "Instagram deauthorization max age");
  requirePositiveInteger(futureToleranceSeconds, "Instagram deauthorization future tolerance");
  const options = {
    appSecret,
    database: pluginOptions.database,
    repository: pluginOptions.repository,
    now: pluginOptions.now ?? (() => new Date()),
    maxAgeSeconds,
    futureToleranceSeconds
  };

  app.addContentTypeParser(
    FORM_CONTENT_TYPE,
    { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES },
    (_request, body, done) => done(null, body)
  );
  app.post(CALLBACK_PATH, { bodyLimit: MAX_BODY_BYTES }, (request, reply) => (
    handleDeauthorization(request, reply, options)
  ));
};

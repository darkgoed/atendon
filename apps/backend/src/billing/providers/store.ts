import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { config } from "../../config.js";
import { encryptCredentials, credentialsHint } from "./credentials.js";
import { providerNotHomologated } from "./homologation.js";

export type ProviderEnvironment = "sandbox" | "production";
export type ProviderStatus = "NOT_CONFIGURED" | "CONNECTED" | "TOKEN_EXPIRING" | "AUTH_ERROR" | "DISCONNECTED" | "DISABLED";
export type Provider = {
  id: string; code: string; name: string; enabled: boolean; environment: ProviderEnvironment; status: ProviderStatus;
  homologated: boolean;
  credentials_hint: string | null; accepted_methods: string[] | null; commercial_config: Record<string, unknown>;
  account_metadata: Record<string, unknown>; connected_at: Date | null; last_validated_at: Date | null;
  last_error_code: string | null; last_error_at: Date | null; token_expires_at: Date | null;
  last_event_at: Date | null; created_at: Date; updated_at: Date;
};
const SAFE_COLUMNS = `id,code,name,enabled,environment,status,homologated,credentials_hint,accepted_methods,commercial_config,account_metadata,connected_at,last_validated_at,last_error_code,last_error_at,token_expires_at,last_event_at,created_at,updated_at,credentials_encrypted,webhook_secret_encrypted`;
/**
 * A homologação é DADO (coluna `billing_providers.homologated`), não uma lista
 * fixa no código: promover um gateway novo é um UPDATE, sem schema change.
 *
 * A checagem acontece DENTRO da transação, sobre a linha já travada, e só depois
 * de confirmar que a linha existe — assim "provedor inexistente" continua
 * devolvendo o erro de não encontrado, e não o de homologação.
 */
async function lockHomologated(c: PoolClient, code: string, environment: ProviderEnvironment, requireHomologation: boolean): Promise<Record<string, unknown>> {
  const existing = await c.query(`SELECT ${SAFE_COLUMNS} FROM billing_providers WHERE code=$1 AND environment=$2 FOR UPDATE`, [code, environment]);
  if (!existing.rowCount) throw new Error("billing provider not found");
  const row = existing.rows[0];
  if (requireHomologation && row.homologated !== true) throw providerNotHomologated(code);
  return row;
}
function sanitized(row: Record<string, unknown>): Provider { const safe = { ...row }; delete safe.credentials_encrypted; delete safe.webhook_secret_encrypted; return safe as Provider; }
function requireActor(actor: string): void { if (!actor.trim()) throw new Error("actor is required"); }
async function audit(c: PoolClient, actor: string, action: string, providerId: string, metadata: Record<string, unknown>): Promise<void> { requireActor(actor); await c.query(`INSERT INTO audit_logs(actor_user_id,actor_scope,action,resource_type,resource_id,metadata) VALUES($1,'root',$2,'billing_provider',$3,$4)`, [actor, action, providerId, metadata]); }
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> { const c = await db.connect(); try { await c.query("BEGIN"); const out = await fn(c); await c.query("COMMIT"); return out; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }

export async function listProviders(): Promise<Provider[]> { const r = await db.query(`SELECT ${SAFE_COLUMNS} FROM billing_providers ORDER BY code,environment`); return r.rows.map(sanitized); }
export async function getProvider(code: string, environment: ProviderEnvironment): Promise<Provider | null> { const r = await db.query(`SELECT ${SAFE_COLUMNS} FROM billing_providers WHERE code=$1 AND environment=$2`, [code, environment]); return r.rows[0] ? sanitized(r.rows[0]) : null; }
export async function saveEncryptedCredentials(code: string, environment: ProviderEnvironment, plainCredentials: string | Record<string, unknown>, actor: string): Promise<Provider> { return tx(async c => { await lockHomologated(c, code, environment, true); const enc = encryptCredentials(plainCredentials, config.DATA_ENCRYPTION_KEY); const hint = credentialsHint(typeof plainCredentials === "string" ? plainCredentials : JSON.stringify(plainCredentials)); const r = await c.query(`UPDATE billing_providers SET credentials_encrypted=$1,credentials_hint=$2,status='CONNECTED',connected_at=COALESCE(connected_at,now()),last_error_code=NULL,last_error_at=NULL,updated_at=now() WHERE code=$3 AND environment=$4 RETURNING ${SAFE_COLUMNS}`, [enc,hint,code,environment]); if (!r.rowCount) throw new Error("billing provider not found"); const p=r.rows[0]; await audit(c, actor, "CREDENTIAL_ROTATED", p.id, { code, environment }); await audit(c, actor, "GATEWAY_CONNECTED", p.id, { code, environment }); return sanitized(p); }); }
export async function updateCommercialConfig(code: string, environment: ProviderEnvironment, commercialConfig: Record<string, unknown>): Promise<Provider> { return tx(async c => { await lockHomologated(c, code, environment, true); const r=await c.query(`UPDATE billing_providers SET commercial_config=$1,updated_at=now() WHERE code=$2 AND environment=$3 RETURNING ${SAFE_COLUMNS}`,[commercialConfig,code,environment]); if(!r.rowCount) throw new Error("billing provider not found"); return sanitized(r.rows[0]); }); }
export async function disconnect(code: string, environment: ProviderEnvironment, actor: string): Promise<Provider> { return tx(async c => { await lockHomologated(c, code, environment, false); const r=await c.query(`UPDATE billing_providers SET credentials_encrypted=NULL,credentials_hint=NULL,webhook_secret_encrypted=NULL,status='DISCONNECTED',updated_at=now() WHERE code=$1 AND environment=$2 RETURNING ${SAFE_COLUMNS}`,[code,environment]); if(!r.rowCount) throw new Error("billing provider not found"); const p=r.rows[0]; await audit(c, actor, "DISCONNECTED", p.id, {code,environment}); return sanitized(p); }); }
export async function markValidationSuccess(code: string, environment: ProviderEnvironment, tokenExpiresAt: Date | undefined, actor: string): Promise<Provider> { return tx(async c => { const r=await c.query(`UPDATE billing_providers SET status=CASE WHEN $3::timestamptz IS NOT NULL AND $3::timestamptz <= now()+interval '7 days' THEN 'TOKEN_EXPIRING' ELSE 'CONNECTED' END,last_validated_at=now(),token_expires_at=$3,last_error_code=NULL,last_error_at=NULL,updated_at=now() WHERE code=$1 AND environment=$2 RETURNING ${SAFE_COLUMNS}`,[code,environment,tokenExpiresAt??null]); if(!r.rowCount) throw new Error("billing provider not found"); const p=r.rows[0]; await audit(c,actor,"VALIDATION_SUCCEEDED",p.id,{code,environment}); return sanitized(p); }); }
export async function markValidationFailure(code: string, environment: ProviderEnvironment, errorCode: string, actor: string): Promise<Provider> { return tx(async c => { const r=await c.query(`UPDATE billing_providers SET status='AUTH_ERROR',last_validated_at=now(),last_error_code=$3,last_error_at=now(),updated_at=now() WHERE code=$1 AND environment=$2 RETURNING ${SAFE_COLUMNS}`,[code,environment,errorCode]); if(!r.rowCount) throw new Error("billing provider not found"); const p=r.rows[0]; await audit(c,actor,"AUTH_FAILED",p.id,{code,environment,errorCode}); return sanitized(p); }); }
export async function setEnabled(code: string, environment: ProviderEnvironment, enabled: boolean, actor: string): Promise<Provider> { return tx(async c => { const existing = await lockHomologated(c, code, environment, enabled); if (enabled && !existing.credentials_encrypted) throw new Error("cannot enable a gateway without configured credentials"); const r = await c.query(`UPDATE billing_providers SET enabled=$3,updated_at=now() WHERE code=$1 AND environment=$2 RETURNING ${SAFE_COLUMNS}`, [code, environment, enabled]); const p = r.rows[0]; await audit(c, actor, enabled ? "GATEWAY_ENABLED" : "GATEWAY_DISABLED", p.id, { code, environment }); return sanitized(p); }); }

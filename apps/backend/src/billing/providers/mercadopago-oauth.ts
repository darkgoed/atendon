import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { credentialsHint, decryptCredentials, encryptCredentials } from "./credentials.js";
import type { Provider, ProviderEnvironment } from "./store.js";

const AUTHORIZATION_URL = "https://auth.mercadopago.com/authorization";
const TOKEN_URL = "https://api.mercadopago.com/oauth/token";
const API_URL = "https://api.mercadopago.com";
type Fetcher = typeof fetch;
type Credentials = Record<string, unknown>;
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  public_key?: string;
  user_id?: string | number;
  live_mode?: boolean;
  expires_in?: number;
};
type OAuthState = { provider_code: string; environment: ProviderEnvironment; code_verifier: string };
type ConnectionResponse = { id?: string | number; email?: string; country_id?: string };

const columns = "id,code,name,enabled,environment,status,credentials_hint,accepted_methods,commercial_config,account_metadata,connected_at,last_validated_at,last_error_code,last_error_at,token_expires_at,last_event_at,created_at,updated_at,credentials_encrypted,webhook_secret_encrypted";

function validateEnvironment(value: string): ProviderEnvironment {
  if (value !== "sandbox" && value !== "production") throw new Error("invalid environment");
  return value;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<TokenResponse>;
  return typeof token.access_token === "string" && token.access_token.length > 0;
}

function configuredValue(credentials: Credentials, camel: string, snake: string): string | undefined {
  const value = credentials[camel] ?? credentials[snake];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeProvider(row: Record<string, unknown>): Provider {
  const safe = { ...row };
  delete safe.credentials_encrypted;
  delete safe.webhook_secret_encrypted;
  return safe as Provider;
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
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

export async function beginMercadoPagoOAuth(code: string, environment: string, actorUserId: string, redirectUri: string, fetchImpl: Fetcher = fetch) {
  void fetchImpl;
  const env = validateEnvironment(environment);
  const result = await db.query<{ credentials_encrypted: string | null }>("SELECT credentials_encrypted FROM billing_providers WHERE code=$1 AND environment=$2", [code, env]);
  if (!result.rowCount || !result.rows[0].credentials_encrypted) throw new Error("Mercado Pago app credentials are not configured");
  const credentials = decryptCredentials<Credentials>(result.rows[0].credentials_encrypted, config.DATA_ENCRYPTION_KEY);
  const clientId = configuredValue(credentials, "clientId", "client_id");
  const clientSecret = configuredValue(credentials, "clientSecret", "client_secret");
  const configuredRedirect = configuredValue(credentials, "redirectUri", "redirect_uri");
  if (!clientId || !clientSecret) throw new Error("Mercado Pago app credentials are not configured");
  if (configuredRedirect && configuredRedirect !== redirectUri) throw new Error("redirect URI does not match provider configuration");

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateResult = await db.query<{ expires_at: Date }>(
    "INSERT INTO oauth_states(state,provider_code,environment,code_verifier,created_by_user_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') RETURNING expires_at",
    [state, code, env, verifier, actorUserId],
  );
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", configuredRedirect ?? redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (env === "sandbox") url.searchParams.set("test_token", "true");
  return { authorizationUrl: url.toString(), state, expiresAt: stateResult.rows[0].expires_at };
}

async function claimOAuthState(state: string): Promise<OAuthState> {
  return transaction(async (client) => {
    const claimed = await client.query<OAuthState>("UPDATE oauth_states SET consumed_at=now() WHERE state=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING provider_code,environment,code_verifier", [state]);
    if (!claimed.rowCount) throw new Error("OAuth state is invalid, expired, or already used");
    return claimed.rows[0];
  });
}

export async function completeMercadoPagoOAuth(state: string, code: string, fetchImpl: Fetcher = fetch) {
  const oauthState = await claimOAuthState(state);
  const providerResult = await db.query<Record<string, unknown>>(`SELECT ${columns} FROM billing_providers WHERE code=$1 AND environment=$2`, [oauthState.provider_code, oauthState.environment]);
  if (!providerResult.rowCount) throw new Error("billing provider not found");
  const provider = providerResult.rows[0];
  const app = decryptCredentials<Credentials>(String(provider.credentials_encrypted), config.DATA_ENCRYPTION_KEY);
  const redirectUri = configuredValue(app, "redirectUri", "redirect_uri");
  const body: Record<string, string | boolean> = { client_id: configuredValue(app, "clientId", "client_id") ?? "", client_secret: configuredValue(app, "clientSecret", "client_secret") ?? "", code, grant_type: "authorization_code", code_verifier: oauthState.code_verifier };
  if (redirectUri) body.redirect_uri = redirectUri;
  if (oauthState.environment === "sandbox") body.test_token = true;
  const response = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok || !isTokenResponse(data)) throw new Error("Mercado Pago OAuth exchange failed");
  const token = data;
  const merged: Credentials = { ...app, accessToken: token.access_token, refreshToken: token.refresh_token, publicKey: token.public_key, userId: token.user_id, liveMode: token.live_mode };
  return transaction(async (client) => {
    const result = await client.query(`UPDATE billing_providers SET credentials_encrypted=$1,credentials_hint=$2,status='CONNECTED',connected_at=COALESCE(connected_at,now()),token_expires_at=CASE WHEN $3::int IS NULL THEN NULL ELSE now()+($3::int * interval '1 second') END,account_metadata=$4,last_error_code=NULL,last_error_at=NULL,updated_at=now() WHERE code=$5 AND environment=$6 RETURNING ${columns}`, [encryptCredentials(merged, config.DATA_ENCRYPTION_KEY), credentialsHint(String(token.user_id ?? token.public_key ?? "mercado_pago")), token.expires_in ?? null, { userId: token.user_id, liveMode: token.live_mode }, oauthState.provider_code, oauthState.environment]);
    if (!result.rowCount) throw new Error("billing provider not found");
    return safeProvider(result.rows[0]);
  });
}

class ProviderCredentialsChangedDuringRefreshError extends Error {
  readonly code = "PROVIDER_CREDENTIALS_CHANGED_DURING_REFRESH";

  constructor() {
    super("provider credentials changed during token refresh");
    this.name = "ProviderCredentialsChangedDuringRefreshError";
  }
}

export async function refreshMercadoPagoToken(code: string, environment: string, fetchImpl: Fetcher = fetch) {
  const env = validateEnvironment(environment);
  try {
    const snapshot = await db.query<{ credentials_encrypted: string | null }>("SELECT credentials_encrypted FROM billing_providers WHERE code=$1 AND environment=$2", [code, env]);
    if (!snapshot.rowCount || !snapshot.rows[0].credentials_encrypted) throw new Error("billing provider not found");
    const oldCiphertext = snapshot.rows[0].credentials_encrypted;
    const old = decryptCredentials<Credentials>(oldCiphertext, config.DATA_ENCRYPTION_KEY);
    const refreshToken = configuredValue(old, "refreshToken", "refresh_token");
    if (!refreshToken) throw new Error("refresh token is not configured");
    const response = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: configuredValue(old, "clientId", "client_id"), client_secret: configuredValue(old, "clientSecret", "client_secret"), grant_type: "refresh_token", refresh_token: refreshToken, scope: "offline_access" }) });
    const data: unknown = await response.json();
    if (!response.ok || !isTokenResponse(data)) throw new Error("Mercado Pago token refresh failed");
    const token = data;
    const merged: Credentials = { ...old, accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken };
    return await transaction(async (client) => {
      const result = await client.query(`UPDATE billing_providers SET credentials_encrypted=$1,status='CONNECTED',token_expires_at=CASE WHEN $2::int IS NULL THEN NULL ELSE now()+($2::int * interval '1 second') END,last_error_code=NULL,last_error_at=NULL,updated_at=now() WHERE code=$3 AND environment=$4 AND credentials_encrypted=$5 RETURNING ${columns}`, [encryptCredentials(merged, config.DATA_ENCRYPTION_KEY), token.expires_in ?? null, code, env, oldCiphertext]);
      if (!result.rowCount) throw new ProviderCredentialsChangedDuringRefreshError();
      return safeProvider(result.rows[0]);
    });
  } catch (error) {
    if (String(error) === "ProviderCredentialsChangedDuringRefreshError: provider credentials changed during token refresh" || (error as { code?: unknown } | null)?.code === "PROVIDER_CREDENTIALS_CHANGED_DURING_REFRESH" || String((error as { message?: unknown } | null)?.message) === "provider credentials changed during token refresh") {
      const current = await db.query(`SELECT ${columns} FROM billing_providers WHERE code=$1 AND environment=$2`, [code, env]);
      if (!current.rowCount) throw new Error("Mercado Pago token refresh failed");
      return safeProvider(current.rows[0]);
    }
    await db.query("UPDATE billing_providers SET status='AUTH_ERROR',last_error_code='TOKEN_REFRESH_FAILED',last_error_at=now(),updated_at=now() WHERE code=$1 AND environment=$2", [code, env]);
    throw new Error("Mercado Pago token refresh failed");
  }
}

export async function testMercadoPagoConnection(code: string, environment: string, fetchImpl: Fetcher = fetch) {
  const env = validateEnvironment(environment);
  const result = await db.query<{ credentials_encrypted: string | null }>("SELECT credentials_encrypted FROM billing_providers WHERE code=$1 AND environment=$2", [code, env]);
  if (!result.rowCount || !result.rows[0].credentials_encrypted) throw new Error("Mercado Pago credentials are not configured");
  const credentials = decryptCredentials<Credentials>(result.rows[0].credentials_encrypted, config.DATA_ENCRYPTION_KEY);
  const token = configuredValue(credentials, "accessToken", "access_token");
  if (!token) throw new Error("Mercado Pago credentials are not configured");
  const response = await fetchImpl(`${API_URL}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
  const data: unknown = await response.json();
  if (!response.ok) {
    await db.query("UPDATE billing_providers SET status='AUTH_ERROR',last_error_code='CONNECTION_FAILED',last_error_at=now(),updated_at=now() WHERE code=$1 AND environment=$2", [code, env]);
    throw new Error("Mercado Pago connection failed");
  }
  const account = data as ConnectionResponse;
  const metadata = { accountId: account.id == null ? undefined : String(account.id), email: account.email, country: account.country_id, endpointLimitation: "/users/me is used; it does not validate all account capabilities" };
  await db.query("UPDATE billing_providers SET status='CONNECTED',last_validated_at=now(),account_metadata=$1,last_error_code=NULL,last_error_at=NULL,updated_at=now() WHERE code=$2 AND environment=$3", [metadata, code, env]);
  return metadata;
}

export { safeProvider };

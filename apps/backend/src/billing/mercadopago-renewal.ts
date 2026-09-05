import { db } from "../db/client.js";
import { logger } from "../logger.js";
import { refreshMercadoPagoToken } from "./providers/mercadopago-oauth.js";

export const OAUTH_TOKEN_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OAUTH_TOKEN_RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Queryable = { query: (...args: unknown[]) => Promise<{ rows: ProviderRow[] }> };
type ProviderRow = { code: string; environment: string };
type Refresh = (code: string, environment: string, fetchImpl: typeof fetch) => Promise<unknown>;

export async function runOAuthTokenRenewalBatch(
  pool: Queryable = db,
  fetchImpl: typeof fetch = fetch,
  refreshImpl: Refresh = refreshMercadoPagoToken,
): Promise<void> {
  const windowMs = Number(process.env.OAUTH_TOKEN_RENEWAL_WINDOW_MS ?? OAUTH_TOKEN_RENEWAL_WINDOW_MS);
  const providers = await pool.query(
    `SELECT code,environment FROM billing_providers
      WHERE status='CONNECTED' AND token_expires_at IS NOT NULL
        AND token_expires_at <= now() + ($1 || ' milliseconds')::interval`,
    [windowMs],
  );
  for (const provider of providers.rows) {
    try {
      await refreshImpl(provider.code, provider.environment, fetchImpl);
    } catch (error) {
      logger.error({ error, providerCode: provider.code, environment: provider.environment }, "Mercado Pago OAuth token renewal failed");
    }
  }
}

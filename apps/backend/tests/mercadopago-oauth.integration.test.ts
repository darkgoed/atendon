import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { encryptCredentials, decryptCredentials } from "../src/billing/providers/credentials.js";
import { beginMercadoPagoOAuth, completeMercadoPagoOAuth, refreshMercadoPagoToken } from "../src/billing/providers/mercadopago-oauth.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const code = `oauth-${randomUUID()}`;
const user = randomUUID();
const fetchOk = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
const fetchFail = (body: unknown) => (async () => ({ ok: false, json: async () => body })) as unknown as typeof fetch;

async function seed(credentials: Record<string, unknown> = { clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/callback", refreshToken: "old-refresh", accessToken: "old-access" }) {
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active')", [user, `${user}@oauth.test`]);
  await pool.query("INSERT INTO billing_providers(code,name,enabled,environment,credentials_encrypted) VALUES($1,'OAuth',true,'sandbox',$2)", [code, encryptCredentials(credentials, config.DATA_ENCRYPTION_KEY)]);
}
async function cleanup() { await pool.query("DELETE FROM oauth_states WHERE provider_code=$1", [code]); await pool.query("DELETE FROM billing_providers WHERE code=$1", [code]); await pool.query("DELETE FROM users WHERE id=$1", [user]); }
async function state() { return (await beginMercadoPagoOAuth(code, "sandbox", user, "http://localhost/callback")).state; }
async function creds() { const r = await pool.query<{ credentials_encrypted: string }>("SELECT credentials_encrypted FROM billing_providers WHERE code=$1", [code]); return decryptCredentials(r.rows[0].credentials_encrypted, config.DATA_ENCRYPTION_KEY); }

beforeEach(async () => { await cleanup(); await seed(); });
afterAll(async () => { await cleanup(); await pool.end(); });

describe("Mercado Pago OAuth transaction boundaries", () => {
  it("claims a usable state before exchange", async () => { const s = await state(); await completeMercadoPagoOAuth(s, "code", fetchFail({ error: "stop" })).catch(() => undefined); expect((await pool.query("SELECT consumed_at FROM oauth_states WHERE state=$1", [s])).rows[0].consumed_at).not.toBeNull(); });
  it("rejects a replay", async () => { const s = await state(); await completeMercadoPagoOAuth(s, "code", fetchOk({ access_token: "a" })); await expect(completeMercadoPagoOAuth(s, "code", fetchOk({ access_token: "b" }))).rejects.toThrow("invalid"); });
  it("leaves state consumed after HTTP failure", async () => { const s = await state(); await expect(completeMercadoPagoOAuth(s, "code", fetchFail({ error: "bad" }))).rejects.toThrow(); expect((await pool.query("SELECT consumed_at FROM oauth_states WHERE state=$1", [s])).rows[0].consumed_at).not.toBeNull(); });
  it("does not replace credentials after exchange JSON failure", async () => { const before = await creds(); const s = await state(); await expect(completeMercadoPagoOAuth(s, "code", fetchOk({ nope: true }))).rejects.toThrow(); expect(await creds()).toEqual(before); });
  it("binds the token exchange redirect URI to the URI used to begin OAuth", async () => {
    const s = await state();
    let requestBody = "";
    const fetchExchange = (async (_url: string, init?: RequestInit) => { requestBody = String(init?.body); return { ok: true, json: async () => ({ access_token: "new" }) }; }) as typeof fetch;
    await completeMercadoPagoOAuth(s, "code", fetchExchange);
    expect(JSON.parse(requestBody)).toMatchObject({ redirect_uri: "http://localhost/callback" });
  });
  it("stores exchanged access and refresh credentials", async () => { const s = await state(); await completeMercadoPagoOAuth(s, "code", fetchOk({ access_token: "new", refresh_token: "new-r", user_id: 7 })); expect(await creds()).toMatchObject({ accessToken: "new", refreshToken: "new-r", userId: 7 }); });
  it("refreshes access while preserving refresh token when omitted", async () => { await refreshMercadoPagoToken(code, "sandbox", fetchOk({ access_token: "fresh" })); expect(await creds()).toMatchObject({ accessToken: "fresh", refreshToken: "old-refresh" }); });
  it("does not replace credentials after refresh failure", async () => { const before = await creds(); await expect(refreshMercadoPagoToken(code, "sandbox", fetchFail({ error: "bad" }))).rejects.toThrow(); const after = await creds(); expect(after.refreshToken).toBe(before.refreshToken); expect(after.accessToken).toBe(before.accessToken); });
  it("handles concurrent refresh CAS loss without marking the provider AUTH_ERROR", async () => {
    let fetches = 0;
    let release!: () => void;
    const bothFetched = new Promise<void>((resolve) => { release = resolve; });
    const concurrentFetch = (async () => {
      fetches += 1;
      if (fetches === 2) release();
      await bothFetched;
      return { ok: true, json: async () => ({ access_token: `fresh-${fetches}` }) };
    }) as unknown as typeof fetch;

    const results = await Promise.all([
      refreshMercadoPagoToken(code, "sandbox", concurrentFetch),
      refreshMercadoPagoToken(code, "sandbox", concurrentFetch),
    ]);

    expect(results).toHaveLength(2);
    expect((await pool.query("SELECT status FROM billing_providers WHERE code=$1", [code])).rows[0].status).toBe("CONNECTED");
  });
  it("rejects expired states without consuming them", async () => { const s = await state(); await pool.query("UPDATE oauth_states SET expires_at=now()-interval '1 second' WHERE state=$1", [s]); await expect(completeMercadoPagoOAuth(s, "code", fetchOk({ access_token: "a" }))).rejects.toThrow("invalid"); expect((await pool.query("SELECT consumed_at FROM oauth_states WHERE state=$1", [s])).rows[0].consumed_at).toBeNull(); });
});

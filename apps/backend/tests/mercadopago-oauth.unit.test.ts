import { describe, expect, it, vi } from "vitest";

const { db, config, decryptCredentials, encryptCredentials } = vi.hoisted(() => ({
  db: { query: vi.fn(), connect: vi.fn() },
  config: { DATA_ENCRYPTION_KEY: "x".repeat(32) },
  decryptCredentials: vi.fn((value: string) => JSON.parse(value)),
  encryptCredentials: vi.fn((value: unknown) => JSON.stringify(value)),
}));
vi.mock("../src/config.js", () => ({ config }));
vi.mock("../src/db/client.js", () => ({ db }));
vi.mock("../src/billing/providers/credentials.js", () => ({ decryptCredentials, encryptCredentials, credentialsHint: () => "hint" }));

import { beginMercadoPagoOAuth, completeMercadoPagoOAuth } from "../src/billing/providers/mercadopago-oauth.js";

const provider = (credentials: Record<string, unknown>) => ({ rowCount: 1, rows: [{ credentials_encrypted: JSON.stringify(credentials) }] });
const fetchOk = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body }) as Response);

function setup({ redirectUri = "http://localhost/callback", credentials = { clientId: "old-client", clientSecret: "old-secret" } } = {}) {
  let stateRow: { provider_code: string; environment: "sandbox"; code_verifier: string; redirect_uri: string | null } | undefined;
  db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT credentials_encrypted FROM billing_providers")) return provider(credentials);
    if (sql.startsWith("INSERT INTO oauth_states")) {
      stateRow = { provider_code: "mercadopago", environment: "sandbox", code_verifier: "verifier", redirect_uri: redirectUri };
      return { rowCount: 1, rows: [{ expires_at: new Date() }] };
    }
    if (sql.startsWith("UPDATE oauth_states")) return stateRow ? { rowCount: 1, rows: [stateRow] } : { rowCount: 0, rows: [] };
    if (sql.startsWith("SELECT id,code,name")) return { rowCount: 1, rows: [{ credentials_encrypted: JSON.stringify(credentials) }] };
    if (sql.startsWith("UPDATE billing_providers")) return { rowCount: 1, rows: [{}] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.startsWith("UPDATE oauth_states")) return stateRow ? { rowCount: 1, rows: [stateRow] } : { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{}] };
  });
  db.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
  return { setStateUri: (value: string | null) => { if (stateRow) stateRow.redirect_uri = value; } };
}

describe("Mercado Pago OAuth redirect binding", () => {
  it("uses the URI saved at begin even when app settings change afterward", async () => {
    setup();
    const begun = await beginMercadoPagoOAuth("mercadopago", "sandbox", "user", "http://localhost/callback");
    let requestBody = "";
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => { requestBody = String(init?.body); return { ok: true, json: async () => ({ access_token: "token" }) } as Response; });
    await completeMercadoPagoOAuth(begun.state, "code", fetch as unknown as typeof globalThis.fetch);
    expect(JSON.parse(requestBody)).toMatchObject({ redirect_uri: "http://localhost/callback" });
  });

  it("rejects a legacy null URI before fetching", async () => {
    const { setStateUri } = setup();
    const begun = await beginMercadoPagoOAuth("mercadopago", "sandbox", "user", "http://localhost/callback");
    setStateUri(null);
    const fetch = fetchOk({ access_token: "token" });
    await expect(completeMercadoPagoOAuth(begun.state, "code", fetch)).rejects.toThrow("redirect URI");
    expect(fetch).not.toHaveBeenCalled();
  });
});

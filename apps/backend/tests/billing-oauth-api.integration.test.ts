import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { encryptCredentials } from "../src/billing/providers/credentials.js";
import { acquireSharedProviderLock, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const password = "oauth-api-test";
const rootEmail = `oauth-root-${suffix}@test.local`;
const userEmail = `oauth-user-${suffix}@test.local`;
let tenant = "";
let rootCookie = "";
let userCookie = "";
const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", user_id: "123", expires_in: 3600 }), { status: 200 });
  if (url.endsWith("/users/me")) return new Response(JSON.stringify({ id: "123", email: "merchant@example.test", country_id: "BR" }), { status: 200 });
  void init;
  return new Response("not found", { status: 404 });
};
const app = buildApp({ billingOAuth: { fetchImpl } });

async function login(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}
async function provider(env: string) { return (await pool.query("SELECT * FROM billing_providers WHERE code='mercadopago' AND environment=$1", [env])).rows[0]; }

// Serializa com as outras suítes que mexem na linha global billing_providers(mercadopago).
let releaseSharedProviderLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseSharedProviderLock = await acquireSharedProviderLock(); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseSharedProviderLock?.(); });

beforeAll(async () => {
  await app.ready();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenant = (await c.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`OAuth ${suffix}`, `oauth-${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(c, tenant);
    const ph = await hash(password, 4);
    await c.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, ph]);
    const user = (await c.query("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [userEmail, ph])).rows[0].id;
    await c.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [tenant, user]);
    await c.query("DELETE FROM billing_providers WHERE code='mercadopago' AND environment IN ('sandbox','production')");
    await c.query("INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,credentials_encrypted) VALUES(true,'mercadopago','Mercado Pago',true,$1,'DISCONNECTED',$2),(true,'mercadopago','Mercado Pago',true,$3,'DISCONNECTED',$2)", ["sandbox", encryptCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", redirectUri: "https://panel.test/root/saas/gateways" }, config.DATA_ENCRYPTION_KEY), "production"]);
    await c.query("COMMIT"); rootCookie = await login(rootEmail); userCookie = await login(userEmail);
    for (const env of ["sandbox", "production"]) await app.inject({ method: "PUT", url: `/root/billing/providers/mercadopago/${env}/credentials`, headers: { cookie: rootCookie }, payload: { credentials: { clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", redirectUri: "https://panel.test/root/saas/gateways" } } });
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
afterAll(async () => { await pool.query("DELETE FROM oauth_states WHERE created_by_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [[rootEmail, userEmail]]); await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [[rootEmail, userEmail]]); await pool.query("DELETE FROM billing_providers WHERE code='mercadopago' AND environment IN ('sandbox','production')"); await pool.query("DELETE FROM workspace_members WHERE workspace_id=$1", [tenant]); await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]); await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[rootEmail, userEmail]]); await app.close(); await pool.end(); });

describe("billing OAuth HTTP API", () => {
  it.each(["begin", "refresh", "test-connection"])("non-root %s is forbidden and leaves DB unchanged", async (operation) => {
    const before = await provider("sandbox");
    const url = operation === "begin" ? "/root/billing/providers/sandbox/oauth/begin" : operation === "test-connection" ? "/root/billing/providers/sandbox/test-connection" : `/root/billing/providers/sandbox/oauth/${operation}`;
    const response = await app.inject({ method: "POST", url, headers: { cookie: userCookie }, payload: operation === "begin" ? { redirectUri: "https://panel.test/root/saas/gateways" } : {} });
    expect(response.statusCode).toBe(403);
    expect(await provider("sandbox")).toEqual(before);
  });
  it("root begin returns official URL/state and persists unused state", async () => {
    const response = await app.inject({ method: "POST", url: "/root/billing/providers/sandbox/oauth/begin", headers: { cookie: rootCookie }, payload: { redirectUri: "https://panel.test/root/saas/gateways" } });
    expect(response.statusCode).toBe(200); const body = response.json(); const url = new URL(body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.mercadopago.com/authorization"); expect(body.state).toBe(url.searchParams.get("state"));
    expect((await pool.query("SELECT consumed_at FROM oauth_states WHERE state=$1", [body.state])).rows[0].consumed_at).toBeNull();
  });
  it("callback success is a server-side fixed redirect", async () => { const state = (await app.inject({ method: "POST", url: "/root/billing/providers/production/oauth/begin", headers: { cookie: rootCookie }, payload: { redirectUri: "https://panel.test/root/saas/gateways" } })).json().state; const r = await app.inject({ url: `/billing/providers/mercadopago/oauth/callback?state=${state}&code=ok` }); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/root/saas/gateways?mercadopago=connected"); });
  it.each(["missing", "reused", "expired"])("%s callback is fixed error without secrets", async (kind) => { const r = await app.inject({ url: `/billing/providers/mercadopago/oauth/callback?state=${kind}&code=secret` }); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/root/saas/gateways?mercadopago=error"); expect(r.headers.location).not.toMatch(/state|code|token|secret/i); expect(r.body).not.toMatch(/secret|token/i); });
  it("ignores injected redirect query", async () => { const r = await app.inject({ url: "/billing/providers/mercadopago/oauth/callback?state=missing&code=x&redirect_uri=https://evil.test" }); expect(r.headers.location).toBe("/root/saas/gateways?mercadopago=error"); });
  it("separates sandbox and production provider rows", async () => { expect((await provider("sandbox")).environment).toBe("sandbox"); expect((await provider("production")).environment).toBe("production"); });
  it("test connection response is sanitized", async () => { const r = await app.inject({ method: "POST", url: "/root/billing/providers/sandbox/test-connection", headers: { cookie: rootCookie }, payload: {} }); expect(r.statusCode).toBe(200); expect(JSON.stringify(r.json())).not.toMatch(/access|refresh|secret|authorization/i); });
  it("disconnect reports unsupported remote revocation and preserves finance", async () => { const before = (await pool.query("SELECT count(*)::int AS count FROM invoices")).rows[0].count; const r = await app.inject({ method: "POST", url: "/root/billing/providers/mercadopago/sandbox/disconnect", headers: { cookie: rootCookie }, payload: { confirm: true } }); expect(r.statusCode).toBe(200); expect(r.json().remoteRevocation).toBe("Mercado Pago não oferece API para revogação remota. Para revogar totalmente o acesso, o vendedor deve fazê-lo manualmente em sua conta do Mercado Pago, em Configurações > Suas integrações."); expect((await pool.query("SELECT count(*)::int AS count FROM invoices")).rows[0].count).toBe(before); });
});

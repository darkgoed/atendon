import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { InstagramOAuthStore } from "../src/modules/instagram/oauth.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { registerInstagramRoutes } from "../src/modules/instagram/routes.js";
import { InstagramService } from "../src/modules/instagram/service.js";
import type { InstagramProvider, OAuthIdentity } from "../src/modules/instagram/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const encryptionKey = "instagram-oauth-test-key-000000000000000000";
const tenantIds: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];

async function createIdentity() {
  const email = `instagram-oauth-${randomUUID()}@test.local`;
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram OAuth ${randomUUID()}`]
  );
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [email]
  );
  tenantIds.push(tenant.rows[0].id);
  return { tenantId: tenant.rows[0].id, userId: user.rows[0].id, sessionVersion: 1 };
}

function providerFor(identity: OAuthIdentity): InstagramProvider {
  return {
    exchangeOAuthCode: vi.fn(async () => identity),
    refreshAccessToken: vi.fn(async () => ({ accessToken: "refreshed", expiresAt: new Date(Date.now() + 60_000) })),
    subscribeWebhook: vi.fn(async () => undefined),
    sendText: vi.fn(async () => ({ outcome: "accepted" as const, externalId: "message" })),
    sendMedia: vi.fn(async () => ({ outcome: "accepted" as const, externalId: "message" })),
    fetchUserProfile: vi.fn(async () => ({ username: null, name: null, profilePictureUrl: null })),
    fetchMedia: vi.fn(async () => ({
      bytes: Buffer.from("media"),
      contentType: "image/jpeg",
      sizeBytes: 5,
      finalUrl: "https://cdn.example.test/media"
    }))
  };
}

async function createRouteApp(input: {
  identity: Awaited<ReturnType<typeof createIdentity>>;
  provider: InstagramProvider;
  permissions?: string[];
}) {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const routeError = error as Error & { statusCode?: number };
    return reply
      .status(routeError.statusCode ?? 400)
      .send({ error: routeError.message });
  });
  const repository = new InstagramRepository(pool, encryptionKey, 10);
  const oauth = new InstagramOAuthStore(pool);
  const service = new InstagramService(repository, input.provider);
  await registerInstagramRoutes(app, {
    service,
    oauth,
    appId: "instagram-app-id",
    appSecret: "instagram-app-secret-which-is-long-enough",
    redirectUri: "https://panel.example.test/backend/instagram/oauth/callback",
    verifyToken: "instagram-webhook-verification-token",
    panelPublicUrl: "https://panel.example.test",
    graphVersion: "v26.0",
    maxConnections: 10,
    mediaSigningSecret: "instagram-media-signing-secret",
    authorize: async (_request, permission) => {
      const permissions = input.permissions ?? ["connection.read", "connection.manage"];
      if (!permissions.includes(permission)) {
        throw Object.assign(new Error("Permissão insuficiente"), { statusCode: 403 });
      }
      return { ...input.identity, permissions };
    }
  });
  await app.ready();
  return { app, repository, oauth };
}

describe("Instagram OAuth and Fastify routes", () => {
  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    if (tenantIds.length > 0) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
    await pool.end();
  });

  it("persists label, nonce, authenticated session and reauthorization target in single-use state", async () => {
    const identity = await createIdentity();
    const repository = new InstagramRepository(pool, encryptionKey);
    const existing = await repository.saveConnection({
      tenantId: identity.tenantId,
      label: "Existing",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const store = new InstagramOAuthStore(pool);
    await store.create({
      ...identity,
      state: `state-${randomUUID()}-${randomUUID()}`,
      browserNonce: "nonce-value",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback",
      label: "Vendas",
      connectionId: existing.id,
      forceReauth: true
    });
    const state = (await pool.query<{ state: string }>(
      "SELECT state FROM instagram_oauth_states WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",
      [identity.tenantId]
    )).rows[0].state;

    await expect(store.consume({
      ...identity,
      userId: randomUUID(),
      state,
      browserNonce: "nonce-value",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.consume({
      ...identity,
      state,
      browserNonce: "wrong-nonce",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    })).rejects.toMatchObject({ statusCode: 400 });
    const consumed = await store.consume({
      ...identity,
      state,
      browserNonce: "nonce-value",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    });
    expect(consumed).toMatchObject({
      label: "Vendas",
      connectionId: existing.id,
      forceReauth: true
    });
    await expect(store.consume({
      ...identity,
      state,
      browserNonce: "nonce-value",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("starts OAuth with validated label, nonce cookie, state and force_reauth for a tenant-owned connection", async () => {
    const identity = await createIdentity();
    const provider = providerFor({
      accountId: `account-${randomUUID()}`,
      username: "atendon",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    const { app, repository } = await createRouteApp({ identity, provider });
    const existing = await repository.saveConnection({
      tenantId: identity.tenantId,
      label: "Antiga",
      accountId: `account-${randomUUID()}`,
      accessToken: "old-token",
      expiresAt: new Date(Date.now() + 60_000)
    });

    const response = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      payload: { label: "  Atendimento VIP  ", connection_id: existing.id }
    });
    expect(response.statusCode).toBe(200);
    const authorization = new URL(response.json<{ authorization_url: string }>().authorization_url);
    expect(authorization.searchParams.get("force_reauth")).toBe("true");
    expect(authorization.searchParams.get("enable_fb_login")).toBe("false");
    expect(authorization.searchParams.get("state")).toBeTruthy();
    expect(response.headers["set-cookie"]).toContain("instagram_oauth_nonce=");
    expect((await pool.query(
      "SELECT label,connection_id,force_reauth FROM instagram_oauth_states WHERE state=$1",
      [authorization.searchParams.get("state")]
    )).rows[0]).toEqual({ label: "Atendimento VIP", connection_id: existing.id, force_reauth: true });
  });

  it("revalidates manage RBAC and completes callback without exposing provider errors", async () => {
    const identity = await createIdentity();
    const oauthIdentity: OAuthIdentity = {
      accountId: `account-${randomUUID()}`,
      username: "empresa",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    };
    const provider = providerFor(oauthIdentity);
    const { app, repository } = await createRouteApp({ identity, provider });
    const start = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      payload: { label: "Instagram oficial" }
    });
    const state = new URL(start.json<{ authorization_url: string }>().authorization_url).searchParams.get("state");
    const nonceCookie = String(start.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      method: "GET",
      url: `/instagram/oauth/callback?code=one-time-code&state=${encodeURIComponent(String(state))}`,
      headers: { cookie: nonceCookie }
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("https://panel.example.test/conexao?instagram=connected");
    expect(provider.exchangeOAuthCode).toHaveBeenCalledWith({
      code: "one-time-code",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    });
    expect(provider.subscribeWebhook).toHaveBeenCalledWith({
      instagramAccountId: oauthIdentity.accountId,
      accessToken: oauthIdentity.accessToken
    });
    await expect(repository.resolveAccount(oauthIdentity.accountId)).resolves.toMatchObject({ tenantId: identity.tenantId });
    expect((await pool.query<{ last_connected_at: Date | null }>(
      "SELECT last_connected_at FROM whatsapp_sessions WHERE tenant_id=$1 AND provider_account_id=$2",
      [identity.tenantId, oauthIdentity.accountId]
    )).rows[0].last_connected_at).not.toBeNull();
  });

  it.each([
    "instagram_business_basic",
    "instagram_business_manage_messages"
  ])("rejects the OAuth callback when %s was not granted", async (missingScope) => {
    const identity = await createIdentity();
    const accountId = `account-${randomUUID()}`;
    const requiredScopes = [
      "instagram_business_basic",
      "instagram_business_manage_messages"
    ];
    const provider = providerFor({
      accountId,
      username: "missing_scope",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: requiredScopes.filter((scope) => scope !== missingScope)
    });
    const { app, repository } = await createRouteApp({ identity, provider });
    const start = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      payload: { label: "Escopos obrigatórios" }
    });
    const authorization = new URL(start.json<{ authorization_url: string }>().authorization_url);
    const state = authorization.searchParams.get("state");
    const nonceCookie = String(start.headers["set-cookie"]).split(";", 1)[0];

    expect(authorization.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages"
    );
    const callback = await app.inject({
      method: "GET",
      url: `/instagram/oauth/callback?code=one-time-code&state=${encodeURIComponent(String(state))}`,
      headers: { cookie: nonceCookie }
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://panel.example.test/conexao?instagram=error&instagram_reason=INSTAGRAM_REQUIRED_SCOPE_MISSING"
    );
    expect(provider.exchangeOAuthCode).toHaveBeenCalledTimes(1);
    expect(provider.subscribeWebhook).not.toHaveBeenCalled();
    await expect(repository.resolveAccount(accountId)).resolves.toBeNull();
  });

  it("reauthorizes the selected connection without creating a second row", async () => {
    const identity = await createIdentity();
    const accountId = `account-${randomUUID()}`;
    const provider = providerFor({
      accountId,
      username: "reauthorized",
      accessToken: "new-oauth-token",
      tokenExpiresAt: new Date(Date.now() + 120_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    const { app, repository } = await createRouteApp({ identity, provider });
    const existing = await repository.saveConnection({
      tenantId: identity.tenantId,
      label: "Before",
      accountId,
      accessToken: "old-oauth-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await repository.markConnectionRevoked(identity.tenantId, existing.id);

    const start = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      payload: { label: "After", connection_id: existing.id }
    });
    const state = new URL(start.json<{ authorization_url: string }>().authorization_url).searchParams.get("state");
    const nonceCookie = String(start.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      method: "GET",
      url: `/instagram/oauth/callback?code=reauthorization-code&state=${encodeURIComponent(String(state))}`,
      headers: { cookie: nonceCookie }
    });

    expect(provider.exchangeOAuthCode).toHaveBeenCalledTimes(1);
    expect(provider.subscribeWebhook).toHaveBeenCalledTimes(1);
    await expect(repository.findConnection(identity.tenantId, existing.id)).resolves.toMatchObject({
      id: existing.id,
      label: "After",
      status: "connected",
      reconnect_required: false
    });
    expect(callback.headers.location).toBe("https://panel.example.test/conexao?instagram=connected");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND provider_account_id=$2",
      [identity.tenantId, accountId]
    )).rows[0].count).toBe(1);
    await expect(repository.getToken(identity.tenantId, existing.id)).resolves.toBe("new-oauth-token");
    expect((await pool.query<{ last_connected_at: Date | null }>(
      "SELECT last_connected_at FROM whatsapp_sessions WHERE id=$1",
      [existing.id]
    )).rows[0].last_connected_at).not.toBeNull();
  });

  it("invalidates the local credential when webhook subscription cannot complete", async () => {
    const identity = await createIdentity();
    const accountId = `account-${randomUUID()}`;
    const provider = providerFor({
      accountId,
      username: "subscription_failure",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    vi.mocked(provider.subscribeWebhook).mockRejectedValueOnce(new Error("network outcome unknown"));
    const repository = new InstagramRepository(pool, encryptionKey);
    const service = new InstagramService(repository, provider);

    await expect(service.connectOAuth({
      tenantId: identity.tenantId,
      label: "Incomplete",
      code: "one-time-code",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    })).rejects.toThrow("network outcome unknown");
    await expect(repository.resolveAccount(accountId)).resolves.toBeNull();
    const stored = (await pool.query<{
      status: string;
      reconnect_required: boolean;
      credentials_encrypted: string | null;
    }>(
      `SELECT status,reconnect_required,credentials_encrypted
       FROM whatsapp_sessions WHERE tenant_id=$1 AND provider_account_id=$2`,
      [identity.tenantId, accountId]
    )).rows[0];
    expect(stored).toEqual({
      status: "disconnected",
      reconnect_required: true,
      credentials_encrypted: null
    });
  });

  it("does not report OAuth success when disconnect wins during webhook subscription", async () => {
    const identity = await createIdentity();
    const accountId = `account-${randomUUID()}`;
    let notifySubscriptionStarted: (() => void) | undefined;
    let finishSubscription: (() => void) | undefined;
    const subscriptionStarted = new Promise<void>((resolve) => {
      notifySubscriptionStarted = resolve;
    });
    const subscriptionGate = new Promise<void>((resolve) => {
      finishSubscription = resolve;
    });
    const provider = providerFor({
      accountId,
      username: "disconnect_race",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    vi.mocked(provider.subscribeWebhook).mockImplementationOnce(async () => {
      notifySubscriptionStarted?.();
      await subscriptionGate;
    });
    const repository = new InstagramRepository(pool, encryptionKey);
    const service = new InstagramService(repository, provider);
    const connecting = service.connectOAuth({
      tenantId: identity.tenantId,
      label: "Concurrent disconnect",
      code: "one-time-code",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    });
    await subscriptionStarted;
    const connection = (await pool.query<{ id: string }>(
      "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND provider_account_id=$2",
      [identity.tenantId, accountId]
    )).rows[0];
    await repository.disconnect(identity.tenantId, connection.id);
    finishSubscription?.();

    await expect(connecting).rejects.toMatchObject({ code: "INSTAGRAM_OAUTH_STALE" });
    await expect(repository.resolveAccount(accountId)).resolves.toBeNull();
  });

  it("does not report stale OAuth success or revoke a concurrent reauthorization", async () => {
    const identity = await createIdentity();
    const accountId = `account-${randomUUID()}`;
    const repository = new InstagramRepository(pool, encryptionKey);
    const existing = await repository.saveConnection({
      tenantId: identity.tenantId,
      label: "Before",
      accountId,
      username: "before",
      accessToken: "old-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    let notifySubscriptionStarted: (() => void) | undefined;
    let finishSubscription: (() => void) | undefined;
    const subscriptionStarted = new Promise<void>((resolve) => {
      notifySubscriptionStarted = resolve;
    });
    const subscriptionGate = new Promise<void>((resolve) => {
      finishSubscription = resolve;
    });
    const provider = providerFor({
      accountId,
      username: "first_reauthorization",
      accessToken: "first-oauth-token",
      tokenExpiresAt: new Date(Date.now() + 120_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    vi.mocked(provider.subscribeWebhook).mockImplementationOnce(async () => {
      notifySubscriptionStarted?.();
      await subscriptionGate;
    });
    const connecting = new InstagramService(repository, provider).connectOAuth({
      tenantId: identity.tenantId,
      connectionId: existing.id,
      label: "First reauthorization",
      code: "one-time-code",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    });
    await subscriptionStarted;
    await repository.saveConnection({
      tenantId: identity.tenantId,
      id: existing.id,
      label: "Winning reauthorization",
      accountId,
      username: "winner",
      accessToken: "winning-oauth-token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    finishSubscription?.();

    await expect(connecting).rejects.toMatchObject({ code: "INSTAGRAM_OAUTH_STALE" });
    await expect(repository.getToken(identity.tenantId, existing.id)).resolves.toBe("winning-oauth-token");
    await expect(repository.findConnection(identity.tenantId, existing.id)).resolves.toMatchObject({
      label: "Winning reauthorization",
      provider_username: "winner",
      reconnect_required: false
    });
    expect((await pool.query<{ last_connected_at: Date | null }>(
      "SELECT last_connected_at FROM whatsapp_sessions WHERE id=$1",
      [existing.id]
    )).rows[0].last_connected_at).toBeNull();
  });

  it("uses the real workspace RBAC on start and callback", async () => {
    const email = `instagram-real-rbac-${randomUUID()}@test.local`;
    const client = await pool.connect();
    let tenantId = "";
    let userId = "";
    try {
      await client.query("BEGIN");
      tenantId = (await client.query<{ id: string }>(
        "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
        [`Instagram real RBAC ${randomUUID()}`]
      )).rows[0].id;
      userId = (await client.query<{ id: string }>(
        "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
        [email]
      )).rows[0].id;
      await ensureWorkspaceDefaultRoles(client, tenantId);
      const ownerRole = (await client.query<{ id: string }>(
        "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
        [tenantId]
      )).rows[0].id;
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status)
         VALUES($1,$2,$3,'active')`,
        [tenantId, userId, ownerRole]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    tenantIds.push(tenantId);

    const provider = providerFor({
      accountId: `account-${randomUUID()}`,
      username: "real_rbac",
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    const repository = new InstagramRepository(pool, encryptionKey);
    await registerInstagramRoutes(app, {
      service: new InstagramService(repository, provider),
      oauth: new InstagramOAuthStore(pool),
      appId: "instagram-app-id",
      appSecret: "instagram-app-secret-which-is-long-enough",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback",
      verifyToken: "instagram-webhook-verification-token",
      panelPublicUrl: "https://panel.example.test",
      graphVersion: "v26.0",
      maxConnections: 10,
      mediaSigningSecret: "instagram-media-signing-secret"
    });
    await app.ready();
    const sessionCookie = `atendon_session=${await createSessionToken({
      userId,
      tenantId,
      email,
      role: "OWNER"
    })}`;
    const start = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      headers: { cookie: sessionCookie },
      payload: { label: "RBAC real" }
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json<{ authorization_url: string }>().authorization_url).searchParams.get("state");
    const nonceCookie = String(start.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      method: "GET",
      url: `/instagram/oauth/callback?code=one-time-code&state=${encodeURIComponent(String(state))}`,
      headers: { cookie: `${sessionCookie}; ${nonceCookie}` }
    });

    expect(callback.headers.location).toBe("https://panel.example.test/conexao?instagram=connected");
    expect(provider.exchangeOAuthCode).toHaveBeenCalledTimes(1);
  });

  it("rejects callback when the current session lost connection.manage", async () => {
    const identity = await createIdentity();
    const provider = providerFor({
      accountId: `account-${randomUUID()}`,
      username: null,
      accessToken: "oauth-token",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
    });
    const allowed = await createRouteApp({ identity, provider });
    const start = await allowed.app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      payload: { label: "RBAC" }
    });
    const state = new URL(start.json<{ authorization_url: string }>().authorization_url).searchParams.get("state");
    const nonceCookie = String(start.headers["set-cookie"]).split(";", 1)[0];

    const denied = await createRouteApp({ identity, provider, permissions: ["connection.read"] });
    const callback = await denied.app.inject({
      method: "GET",
      url: `/instagram/oauth/callback?code=secret-provider-code&state=${encodeURIComponent(String(state))}`,
      headers: { cookie: nonceCookie }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("https://panel.example.test/conexao?instagram=error");
    expect(callback.body).not.toContain("secret-provider-code");
    expect(provider.exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("reports every required missing setting without leaking values", async () => {
    const identity = await createIdentity();
    const provider = providerFor({
      accountId: "unused",
      username: null,
      accessToken: "unused",
      tokenExpiresAt: new Date(),
      scopes: []
    });
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    await registerInstagramRoutes(app, {
      service: new InstagramService(new InstagramRepository(pool, encryptionKey), provider),
      oauth: new InstagramOAuthStore(pool),
      graphVersion: "v26.0",
      maxConnections: 10,
      panelPublicUrl: "https://panel.example.test",
      mediaSigningSecret: "media-signing-secret",
      authorize: async () => ({ ...identity, permissions: ["connection.read", "connection.manage"] })
    });
    const response = await app.inject({ method: "GET", url: "/instagram/status" });
    expect(response.json()).toEqual({
      configured: false,
      missing: [
        "INSTAGRAM_APP_ID",
        "INSTAGRAM_APP_SECRET",
        "INSTAGRAM_WEBHOOK_VERIFY_TOKEN",
        "INSTAGRAM_REDIRECT_URI"
      ],
      graph_version: "v26.0",
      max_connections: 10
    });
  });
});

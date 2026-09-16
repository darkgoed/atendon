import { createHmac, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { signMediaUrl } from "../src/modules/instagram/media.js";
import { InstagramOAuthStore } from "../src/modules/instagram/oauth.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { registerInstagramRoutes } from "../src/modules/instagram/routes.js";
import { InstagramService } from "../src/modules/instagram/service.js";
import type { InstagramProvider } from "../src/modules/instagram/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-routes-data-key-000000000000000000";
const appSecret = "instagram-app-secret-for-route-tests";
const mediaSecret = "instagram-media-secret-for-route-tests";
let tenantId = "";
let userId = "";
let app = Fastify();
let repository: InstagramRepository;
let provider: InstagramProvider;

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram routes ${randomUUID()}`]
  )).rows[0].id;
  userId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`instagram-routes-${randomUUID()}@test.local`]
  )).rows[0].id;
  provider = {
    exchangeOAuthCode: vi.fn(),
    refreshAccessToken: vi.fn(async () => ({ accessToken: "refreshed", expiresAt: new Date(Date.now() + 60_000) })),
    subscribeWebhook: vi.fn(),
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    fetchMedia: vi.fn()
  };
  repository = new InstagramRepository(pool, key);
  app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const routeError = error as Error & { statusCode?: number };
    return reply.status(routeError.statusCode ?? 500).send({ error: routeError.message });
  });
  await registerInstagramRoutes(app, {
    service: new InstagramService(repository, provider),
    oauth: new InstagramOAuthStore(pool),
    appId: "app-id",
    appSecret,
    verifyToken: "webhook-verify-token-long-enough",
    redirectUri: "https://panel.example.test/backend/instagram/oauth/callback",
    panelPublicUrl: "https://panel.example.test",
    graphVersion: "v26.0",
    maxConnections: 10,
    mediaSigningSecret: mediaSecret,
    authorize: async () => ({
      tenantId,
      userId,
      sessionVersion: 1,
      permissions: ["connection.read", "connection.manage"]
    })
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("Instagram operational Fastify routes", () => {
  it("accepts a signed raw webhook only after durably storing it", async () => {
    const connection = await repository.saveConnection({
      tenantId,
      label: "Webhook",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const raw = Buffer.from(JSON.stringify({
      object: "instagram",
      entry: [{
        id: connection.provider_account_id,
        time: Date.now() - 1_000,
        messaging: [{
          sender: { id: `igsid-${randomUUID()}` },
          recipient: { id: connection.provider_account_id },
          timestamp: Date.now() - 1_000,
          message: { mid: `message-${randomUUID()}`, text: "Oi" }
        }]
      }]
    }, null, 2));
    const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: raw
    });
    expect(response.statusCode).toBe(200);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM instagram_webhook_inbox WHERE session_id=$1",
      [connection.id]
    )).rows[0].count).toBe(1);
  });

  it("rejects a webhook signed for different raw bytes", async () => {
    const raw = Buffer.from('{"object":"instagram","entry":[]}');
    const signature = `sha256=${createHmac("sha256", appSecret).update(Buffer.from("{}")) .digest("hex")}`;
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: raw
    });
    expect(response.statusCode).toBe(401);
  });

  it("streams only media with a valid unexpired URL signature", async () => {
    const connection = await repository.saveConnection({
      tenantId,
      label: "Media",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const media = await repository.savePublicMedia({
      tenantId,
      sessionId: connection.id,
      bytes: Buffer.from("route-media"),
      contentType: "image/jpeg",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const signature = signMediaUrl(media.id, mediaSecret, 60);

    const response = await app.inject({
      method: "GET",
      url: `/instagram/media/${media.id}?signature=${encodeURIComponent(signature)}`
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.rawPayload.equals(Buffer.from("route-media"))).toBe(true);
    expect((await app.inject({
      method: "GET",
      url: `/instagram/media/${media.id}?signature=invalid`
    })).statusCode).toBe(403);
  });

  it("refreshes and disconnects only the tenant-owned Instagram connection", async () => {
    const connection = await repository.saveConnection({
      tenantId,
      label: "Lifecycle",
      accountId: `account-${randomUUID()}`,
      accessToken: "old-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const refreshed = await app.inject({
      method: "POST",
      url: `/instagram/connections/${connection.id}/refresh`
    });
    expect(refreshed.statusCode).toBe(200);
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("refreshed");

    const disconnected = await app.inject({
      method: "POST",
      url: `/instagram/connections/${connection.id}/disconnect`
    });
    expect(disconnected.statusCode).toBe(200);
    await expect(repository.resolveAccount(connection.provider_account_id)).resolves.toBeNull();
  });
});

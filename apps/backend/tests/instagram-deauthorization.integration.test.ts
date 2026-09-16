import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { instagramDeauthorizationPlugin } from "../src/modules/instagram/deauthorization.js";
import { InstagramOAuthStore } from "../src/modules/instagram/oauth.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const appSecret = "instagram-deauthorization-app-secret";
const encryptionKey = "instagram-deauthorization-data-key-0000000001";
const tenantIds: string[] = [];
const userIds: string[] = [];
const apps: FastifyInstance[] = [];

function signedRequest(
  payload: Record<string, unknown>,
  secret = appSecret
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload, "ascii").digest("base64url");
  return `${signature}.${encodedPayload}`;
}

async function createIdentity(label: string) {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram deauthorization ${label} ${randomUUID()}`]
  );
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`instagram-deauthorization-${randomUUID()}@test.local`]
  );
  tenantIds.push(tenant.rows[0].id);
  userIds.push(user.rows[0].id);
  return { tenantId: tenant.rows[0].id, userId: user.rows[0].id };
}

async function createApp(now: Date): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  const repository = new InstagramRepository(pool, encryptionKey);
  await app.register(instagramDeauthorizationPlugin, {
    appSecret,
    database: pool,
    repository,
    now: () => now
  });
  await app.ready();
  return app;
}

function formPayload(value: string): string {
  return `signed_request=${value}`;
}

describe("Instagram Meta deauthorization callback", () => {
  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    if (tenantIds.length > 0) {
      await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
    }
    if (userIds.length > 0) {
      await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    }
    await pool.end();
  });

  it("revokes only the OAuth-linked account and invalidates future work without deleting history", async () => {
    const now = new Date();
    const { tenantId, userId } = await createIdentity("valid");
    const repository = new InstagramRepository(pool, encryptionKey);
    const accountId = `${Math.floor(Math.random() * 8_000_000_000_000_000 + 1_000_000_000_000_000)}`;
    const connection = await repository.saveConnection({
      tenantId,
      label: "Conta oficial",
      accountId,
      accessToken: "token-that-must-be-invalidated",
      expiresAt: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000)
    });
    const authorizedAt = new Date(now.getTime() - 120_000);
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=$1",
      [connection.id, authorizedAt]
    );
    const oauthState = `state-${randomUUID()}-${randomUUID()}`;
    await pool.query(
      `INSERT INTO instagram_oauth_states(
         state,tenant_id,user_id,session_version,browser_nonce_hash,redirect_uri,label,
         connection_id,expires_at
       ) VALUES($1,$2,$3,1,$4,'https://example.test/callback','Conta oficial',$5,$6)`,
      [oauthState, tenantId, userId, "a".repeat(64), connection.id, new Date(now.getTime() + 60_000)]
    );
    await pool.query(
      `INSERT INTO instagram_webhook_outbox(tenant_id,session_id,kind,payload,idempotency_key)
       VALUES($1,$2,'message','{}',$3)`,
      [tenantId, connection.id, randomUUID()]
    );
    await pool.query(
      `INSERT INTO instagram_webhook_inbox(
         tenant_id,session_id,provider_event_id,account_id,raw_body,payload,processed_at
       ) VALUES($1,$2,$3,$4,$5,'{}',now())`,
      [tenantId, connection.id, `historical-${randomUUID()}`, accountId, Buffer.from("historical")]
    );
    const app = await createApp(now);

    const response = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formPayload(signedRequest({
        algorithm: "HMAC-SHA256",
        issued_at: Math.floor(now.getTime() / 1000),
        user_id: accountId
      }))
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.body).not.toContain(accountId);
    expect((await pool.query(
      `SELECT status,credentials_encrypted,token_expires_at,reconnect_required,
              disconnected_reason,last_connected_at
       FROM whatsapp_sessions WHERE id=$1`,
      [connection.id]
    )).rows[0]).toMatchObject({
      status: "disconnected",
      credentials_encrypted: null,
      token_expires_at: null,
      reconnect_required: true,
      disconnected_reason: "meta_deauthorized"
    });
    expect((await pool.query(
      "SELECT status,failure_code,invalidated_at IS NOT NULL invalidated FROM instagram_webhook_outbox WHERE session_id=$1",
      [connection.id]
    )).rows[0]).toEqual({
      status: "rejected",
      failure_code: "meta_deauthorized",
      invalidated: true
    });
    expect((await pool.query<{ consumed: boolean }>(
      "SELECT consumed_at IS NOT NULL consumed FROM instagram_oauth_states WHERE state=$1",
      [oauthState]
    )).rows[0].consumed).toBe(true);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM instagram_webhook_inbox WHERE session_id=$1",
      [connection.id]
    )).rows[0].count).toBe(1);
  });

  it("rejects missing, forged and non-canonical signed requests without exposing identifiers", async () => {
    const now = new Date();
    const accountId = "17841400000000001";
    const app = await createApp(now);
    const currentPayload = {
      algorithm: "HMAC-SHA256",
      issued_at: Math.floor(now.getTime() / 1000),
      user_id: accountId
    };
    const cases = [
      { payload: "", expected: 400 },
      { payload: formPayload(signedRequest(currentPayload, "forged-secret")), expected: 401 },
      { payload: `${formPayload(signedRequest(currentPayload))}&extra=1`, expected: 400 },
      {
        payload: `signed_request=${signedRequest(currentPayload).replace(".", "%2E")}`,
        expected: 400
      },
      { payload: formPayload(`${signedRequest(currentPayload)}.extra`), expected: 400 }
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/instagram/deauthorize",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: testCase.payload
      });
      expect(response.statusCode).toBe(testCase.expected);
      expect(response.json()).toEqual({ ok: false });
      expect(response.body).not.toContain(accountId);
    }
  });

  it("strictly validates algorithm, account identity and issued_at timestamp", async () => {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const app = await createApp(now);
    const invalidPayloads: Array<Record<string, unknown>> = [
      { algorithm: "none", issued_at: nowSeconds, user_id: "17841400000000002" },
      { algorithm: "HMAC-SHA256", issued_at: `${nowSeconds}`, user_id: "17841400000000002" },
      { algorithm: "HMAC-SHA256", issued_at: nowSeconds + 301, user_id: "17841400000000002" },
      { algorithm: "HMAC-SHA256", issued_at: nowSeconds - 7 * 24 * 60 * 60 - 1, user_id: "17841400000000002" },
      { algorithm: "HMAC-SHA256", issued_at: nowSeconds, user_id: 17841400000000002 },
      { algorithm: "HMAC-SHA256", issued_at: nowSeconds, user_id: "not-an-account-id" }
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/instagram/deauthorize",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        payload: formPayload(signedRequest(payload))
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false });
    }
  });

  it("acknowledges unknown accounts and exact replays idempotently with the same generic response", async () => {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const unknownId = "17841400000000003";
    const app = await createApp(now);
    const unknownRequest = formPayload(signedRequest({
      algorithm: "HMAC-SHA256",
      issued_at: nowSeconds,
      user_id: unknownId
    }));

    const unknown = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: unknownRequest
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ ok: true });

    const { tenantId } = await createIdentity("replay");
    const repository = new InstagramRepository(pool, encryptionKey);
    const accountId = "17841400000000004";
    const connection = await repository.saveConnection({
      tenantId,
      label: "Replay",
      accountId,
      accessToken: "replay-token",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=$1",
      [connection.id, new Date(now.getTime() - 60_000)]
    );
    const request = formPayload(signedRequest({
      algorithm: "HMAC-SHA256",
      issued_at: nowSeconds,
      user_id: accountId
    }));
    const first = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: request
    });
    const replay = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: request
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(first.body).toBe(replay.body);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM whatsapp_sessions
       WHERE id=$1 AND status='disconnected' AND credentials_encrypted IS NULL`,
      [connection.id]
    )).rows[0].count).toBe(1);
  });

  it("keeps other tenant accounts and their pending sends untouched", async () => {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const firstIdentity = await createIdentity("tenant-a");
    const secondIdentity = await createIdentity("tenant-b");
    const repository = new InstagramRepository(pool, encryptionKey);
    const first = await repository.saveConnection({
      tenantId: firstIdentity.tenantId,
      label: "Tenant A",
      accountId: "17841400000000005",
      accessToken: "tenant-a-token",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    const second = await repository.saveConnection({
      tenantId: secondIdentity.tenantId,
      label: "Tenant B",
      accountId: "17841400000000006",
      accessToken: "tenant-b-token",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=ANY($1::uuid[])",
      [[first.id, second.id], new Date(now.getTime() - 60_000)]
    );
    await pool.query(
      `INSERT INTO instagram_webhook_outbox(tenant_id,session_id,kind,payload,idempotency_key)
       VALUES($1,$2,'message','{}',$3),($4,$5,'message','{}',$6)`,
      [firstIdentity.tenantId, first.id, randomUUID(), secondIdentity.tenantId, second.id, randomUUID()]
    );
    const app = await createApp(now);

    const response = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formPayload(signedRequest({
        algorithm: "HMAC-SHA256",
        issued_at: nowSeconds,
        user_id: first.provider_account_id
      }))
    });

    expect(response.statusCode).toBe(200);
    await expect(repository.getToken(secondIdentity.tenantId, second.id)).resolves.toBe("tenant-b-token");
    expect((await pool.query(
      "SELECT status,failure_code FROM instagram_webhook_outbox WHERE session_id=$1",
      [second.id]
    )).rows[0]).toEqual({ status: "pending", failure_code: null });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM whatsapp_sessions WHERE id=$1",
      [first.id]
    )).rows[0].status).toBe("disconnected");
  });

  it("uses the credential snapshot as a compare-and-swap guard against concurrent reauthorization", async () => {
    const now = new Date();
    const { tenantId } = await createIdentity("credential-cas");
    const repository = new InstagramRepository(pool, encryptionKey);
    const accountId = "17841400000000008";
    const connection = await repository.saveConnection({
      tenantId,
      label: "Credential CAS",
      accountId,
      accessToken: "credential-before-callback",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=$1",
      [connection.id, new Date(now.getTime() - 60_000)]
    );
    const staleSnapshot = await repository.getTokenSnapshot(tenantId, connection.id);
    let swapped = false;
    const app = Fastify();
    apps.push(app);
    await app.register(instagramDeauthorizationPlugin, {
      appSecret,
      database: pool,
      repository: {
        resolveAccount: (id) => repository.resolveAccount(id),
        getTokenSnapshot: async () => {
          if (!swapped) {
            swapped = true;
            await repository.saveConnection({
              tenantId,
              id: connection.id,
              label: "Credential CAS reauthorized",
              accountId,
              accessToken: "credential-after-reauth",
              expiresAt: new Date(now.getTime() + 120_000)
            });
          }
          return staleSnapshot;
        }
      },
      now: () => now
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formPayload(signedRequest({
        algorithm: "HMAC-SHA256",
        issued_at: Math.floor(now.getTime() / 1000),
        user_id: accountId
      }))
    });

    expect(response.statusCode).toBe(200);
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("credential-after-reauth");
  });

  it("does not let an old callback revoke a reauthorization matched by account without connection_id", async () => {
    const now = new Date();
    const oldIssuedAt = Math.floor(now.getTime() / 1000) - 120;
    const { tenantId, userId } = await createIdentity("stale-after-implicit-reauth");
    const repository = new InstagramRepository(pool, encryptionKey);
    const accountId = "17841400000000009";
    const connection = await repository.saveConnection({
      tenantId,
      label: "Before implicit reauth",
      accountId,
      accessToken: "old-implicit-token",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=$1",
      [connection.id, new Date(now.getTime() - 300_000)]
    );

    const oauth = new InstagramOAuthStore(pool);
    const state = `state-${randomUUID()}-${randomUUID()}`;
    await oauth.create({
      tenantId,
      userId,
      sessionVersion: 1,
      state,
      browserNonce: "implicit-reauthorization-browser-nonce",
      redirectUri: "https://example.test/instagram/oauth/callback",
      label: "After implicit reauth"
    });
    await oauth.consume({
      tenantId,
      userId,
      sessionVersion: 1,
      state,
      browserNonce: "implicit-reauthorization-browser-nonce",
      redirectUri: "https://example.test/instagram/oauth/callback"
    });
    const reauthorized = await repository.saveConnection({
      tenantId,
      label: "After implicit reauth",
      accountId,
      accessToken: "new-implicit-token",
      expiresAt: new Date(now.getTime() + 120_000)
    });
    expect(reauthorized.id).toBe(connection.id);
    await expect(repository.finalizeOAuthConnection(
      tenantId,
      reauthorized.id,
      reauthorized.credentials_encrypted!
    )).resolves.toBe(true);
    const app = await createApp(now);

    const response = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formPayload(signedRequest({
        algorithm: "HMAC-SHA256",
        issued_at: oldIssuedAt,
        user_id: accountId
      }))
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("new-implicit-token");
  });

  it("does not let an old callback revoke credentials created by a later OAuth reauthorization", async () => {
    const now = new Date();
    const oldIssuedAt = Math.floor(now.getTime() / 1000) - 120;
    const { tenantId, userId } = await createIdentity("stale-after-reauth");
    const repository = new InstagramRepository(pool, encryptionKey);
    const accountId = "17841400000000007";
    const connection = await repository.saveConnection({
      tenantId,
      label: "Before reauth",
      accountId,
      accessToken: "old-token",
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await pool.query(
      "UPDATE whatsapp_sessions SET created_at=$2,last_connected_at=$2 WHERE id=$1",
      [connection.id, new Date(now.getTime() - 300_000)]
    );

    const oauth = new InstagramOAuthStore(pool);
    const state = `state-${randomUUID()}-${randomUUID()}`;
    await oauth.create({
      tenantId,
      userId,
      sessionVersion: 1,
      state,
      browserNonce: "reauthorization-browser-nonce",
      redirectUri: "https://example.test/instagram/oauth/callback",
      label: "After reauth",
      connectionId: connection.id,
      forceReauth: true
    });
    await oauth.consume({
      tenantId,
      userId,
      sessionVersion: 1,
      state,
      browserNonce: "reauthorization-browser-nonce",
      redirectUri: "https://example.test/instagram/oauth/callback"
    });
    const reauthorized = await repository.saveConnection({
      tenantId,
      id: connection.id,
      label: "After reauth",
      accountId,
      accessToken: "new-token",
      expiresAt: new Date(now.getTime() + 120_000)
    });
    await expect(repository.finalizeOAuthConnection(
      tenantId,
      reauthorized.id,
      reauthorized.credentials_encrypted!
    )).resolves.toBe(true);
    const finalizedAt = (await pool.query<{ last_connected_at: Date }>(
      "SELECT last_connected_at FROM whatsapp_sessions WHERE id=$1",
      [connection.id]
    )).rows[0].last_connected_at;
    expect(finalizedAt.getTime()).toBeGreaterThan(oldIssuedAt * 1000);
    const app = await createApp(now);

    const response = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formPayload(signedRequest({
        algorithm: "HMAC-SHA256",
        issued_at: oldIssuedAt,
        user_id: accountId
      }))
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("new-token");
    expect((await pool.query<{
      status: string;
      reconnect_required: boolean;
      disconnected_reason: string | null;
    }>(
      "SELECT status,reconnect_required,disconnected_reason FROM whatsapp_sessions WHERE id=$1",
      [connection.id]
    )).rows[0]).toEqual({
      status: "connected",
      reconnect_required: false,
      disconnected_reason: null
    });
  });
});

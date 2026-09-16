import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config, type AppConfig } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import type { InstagramProvider, NormalizedInstagramEvent } from "../src/modules/instagram/types.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const appSecret = "instagram-app-secret-for-build-app-tests";
const runtimeConfig: AppConfig = {
  ...config,
  INSTAGRAM_APP_ID: "instagram-app-id",
  INSTAGRAM_APP_SECRET: appSecret,
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "instagram-webhook-verify-token",
  INSTAGRAM_REDIRECT_URI: "https://panel.example.test/api/instagram/oauth/callback",
  PANEL_PUBLIC_URL: "https://panel.example.test"
};
const repository = new InstagramRepository(pool, runtimeConfig.DATA_ENCRYPTION_KEY);
const tenants: string[] = [];
const users: string[] = [];
let fixtureSequence = 0;
let app: ReturnType<typeof buildApp>;
let whatsappSendText: MockInstance<WhatsAppSessionManager["sendText"]>;
let whatsappSendMedia: MockInstance<WhatsAppSessionManager["sendMedia"]>;
let whatsappDownloadMedia: MockInstance<WhatsAppSessionManager["downloadMedia"]>;

const providerCalls = {
  text: [] as Array<Parameters<InstagramProvider["sendText"]>[0]>,
  media: [] as Array<Parameters<InstagramProvider["sendMedia"]>[0]>,
  fetch: [] as Array<Parameters<InstagramProvider["fetchMedia"]>[0]>
};

const provider: InstagramProvider = {
  exchangeOAuthCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  subscribeWebhook: vi.fn(),
  fetchUserProfile: vi.fn().mockResolvedValue({ username: null, name: null, profilePictureUrl: null }),
  async sendText(input) {
    providerCalls.text.push(input);
    if (input.text.includes("explicitamente rejeitada")) {
      return { outcome: "rejected", code: "meta_400", message: "Meta rejeitou a mensagem" };
    }
    if (input.text.includes("resultado ambíguo")) {
      return { outcome: "ambiguous", code: "ambiguous", message: "Resultado Meta desconhecido" };
    }
    return { outcome: "accepted", externalId: `ig-mid-${providerCalls.text.length}` };
  },
  async sendMedia(input) {
    providerCalls.media.push(input);
    return { outcome: "accepted", externalId: `ig-media-${providerCalls.media.length}` };
  },
  async fetchMedia(input) {
    providerCalls.fetch.push(input);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    return {
      bytes,
      contentType: "image/jpeg",
      sizeBytes: bytes.length,
      finalUrl: "https://lookaside.instagram.com/private.jpg"
    };
  }
};

type Fixture = {
  tenantId: string;
  ownerId: string;
  operatorId: string;
  ownerCookie: string;
  operatorCookie: string;
  whatsappSessionId: string;
  whatsappConversationId: string;
  instagramSessionId: string;
  instagramConversationId: string;
  instagramContactId: string;
  instagramAccountId: string;
};

async function createUser(client: pg.PoolClient, tenantId: string, role: "OWNER" | "OPERADOR") {
  const userId = (await client.query<{ id: string }>(
    "INSERT INTO users(email,status,session_version) VALUES($1,'active',1) RETURNING id",
    [`instagram-app-${role.toLowerCase()}-${randomUUID()}@test.local`]
  )).rows[0].id;
  users.push(userId);
  await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
    [tenantId, userId, role]
  );
  const token = await createSessionToken({
    userId,
    tenantId,
    email: `instagram-app-${userId}@test.local`,
    role,
    sessionVersion: 1
  });
  return { userId, cookie: `atendon_session=${token}` };
}

function event(accountId: string, contactId: string, mid: string, media = false): NormalizedInstagramEvent {
  return {
    kind: "message",
    eventId: `message:${mid}`,
    accountId,
    providerUserId: contactId,
    timestamp: new Date(),
    text: media ? "imagem" : "olá",
    media: media ? [{ type: "image", url: "https://lookaside.instagram.com/private.jpg" }] : [],
    isEcho: false,
    raw: {
      sender: { id: contactId },
      recipient: { id: accountId },
      message: {
        mid,
        text: media ? undefined : "olá",
        ...(media ? { attachments: [{ type: "image", payload: { url: "https://lookaside.instagram.com/private.jpg" } }] } : {})
      }
    }
  };
}

async function fixture(): Promise<Fixture> {
  fixtureSequence += 1;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Instagram app ${randomUUID()}`, `instagram-app-${randomUUID()}`]
    )).rows[0].id;
    tenants.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const planId = (await client.query<{ id: string }>("SELECT id FROM plans WHERE code='MEDIUM'")).rows[0].id;
    await client.query(
      "INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')",
      [tenantId, planId]
    );
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'workspace_admin_v1',true),($1,'conversations_delta_v2',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId]
    );
    const owner = await createUser(client, tenantId, "OWNER");
    const operator = await createUser(client, tenantId, "OPERADOR");
    const whatsappSessionId = (await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel,phone_number)
       VALUES($1,'WhatsApp',true,'connected','whatsapp','5511999991212') RETURNING id`,
      [tenantId]
    )).rows[0].id;
    const whatsappConversationId = (await client.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,ai_active,assigned_user_id)
       VALUES($1,$2,'5511888881212','Contato WhatsApp',false,$3) RETURNING id`,
      [tenantId, whatsappSessionId, operator.userId]
    )).rows[0].id;
    await client.query("COMMIT");

    const instagramAccountId = String(1_000_000_000_000_000n + BigInt(fixtureSequence));
    const connection = await repository.saveConnection({
      tenantId,
      label: "Instagram comercial",
      accountId: instagramAccountId,
      username: "atendon_comercial",
      accessToken: "test-access-token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const instagramContactId = `igsid-${randomUUID()}`;
    const persisted = await repository.persistEvent(
      tenantId,
      connection.id,
      event(instagramAccountId, instagramContactId, `initial-${randomUUID()}`),
      Buffer.from("{}")
    );
    await pool.query(
      `UPDATE conversations SET contact_name='Contato Instagram',instagram_username='cliente_ig',
         ai_active=false,assigned_user_id=$3
       WHERE id=$1 AND tenant_id=$2`,
      [persisted.conversationId, tenantId, operator.userId]
    );
    return {
      tenantId,
      ownerId: owner.userId,
      operatorId: operator.userId,
      ownerCookie: owner.cookie,
      operatorCookie: operator.cookie,
      whatsappSessionId,
      whatsappConversationId,
      instagramSessionId: connection.id,
      instagramConversationId: persisted.conversationId!,
      instagramContactId,
      instagramAccountId
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  whatsappSendText = vi.spyOn(WhatsAppSessionManager.prototype, "sendText").mockResolvedValue({ externalId: "wa-regression-mid" });
  whatsappSendMedia = vi.spyOn(WhatsAppSessionManager.prototype, "sendMedia").mockResolvedValue({ externalId: "wa-regression-media" });
  whatsappDownloadMedia = vi.spyOn(WhatsAppSessionManager.prototype, "downloadMedia").mockResolvedValue({
    base64: Buffer.from("wa-private").toString("base64"), mimeType: "image/jpeg", fileName: "wa.jpg"
  });
  app = buildApp({ instagramProvider: provider, instagramRuntimeConfig: runtimeConfig });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  whatsappSendText.mockRestore();
  whatsappSendMedia.mockRestore();
  whatsappDownloadMedia.mockRestore();
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (users.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end();
});

describe("Instagram wired into buildApp", () => {
  it("registers real runtime routes and exempts CSRF only for the signed webhook callback", async () => {
    const context = await fixture();
    const raw = Buffer.from(JSON.stringify({
      object: "instagram",
      entry: [{
        id: context.instagramAccountId,
        time: Date.now(),
        messaging: [{
          sender: { id: `igsid-${randomUUID()}` },
          recipient: { id: context.instagramAccountId },
          timestamp: Date.now(),
          message: { mid: `webhook-${randomUUID()}`, text: "Webhook real" }
        }]
      }]
    }));
    const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
    const signed = await app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        origin: "https://cross-site-meta.example",
        "sec-fetch-site": "cross-site"
      },
      payload: raw
    });
    expect(signed.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        origin: "https://cross-site-meta.example",
        "sec-fetch-site": "cross-site"
      },
      payload: raw
    });
    expect(invalid.statusCode).toBe(401);
    const ordinaryWrite = await app.inject({
      method: "POST",
      url: "/instagram/oauth/start",
      headers: {
        cookie: context.ownerCookie,
        origin: "https://cross-site-meta.example",
        "sec-fetch-site": "cross-site"
      },
      payload: { label: "Não permitido" }
    });
    expect(ordinaryWrite.statusCode).toBe(403);

    const encodedPayload = Buffer.from(JSON.stringify({
      algorithm: "HMAC-SHA256",
      issued_at: Math.floor(Date.now() / 1000) + 1,
      user_id: context.instagramAccountId
    })).toString("base64url");
    const signedRequest = `${createHmac("sha256", appSecret).update(encodedPayload, "ascii").digest("base64url")}.${encodedPayload}`;
    const deauthorized = await app.inject({
      method: "POST",
      url: "/instagram/deauthorize",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://cross-site-meta.example",
        "sec-fetch-site": "cross-site"
      },
      payload: Buffer.from(`signed_request=${signedRequest}`)
    });
    expect(deauthorized.statusCode).toBe(200);
    expect(deauthorized.json()).toEqual({ ok: true });
    expect((await pool.query(
      "SELECT status,reconnect_required,credentials_encrypted FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    )).rows[0]).toMatchObject({ status: "disconnected", reconnect_required: true, credentials_encrypted: null });
  });

  it("lists connection and conversation identity/window fields without exposing credentials", async () => {
    const context = await fixture();
    const connections = await app.inject({ url: "/connections", headers: { cookie: context.ownerCookie } });
    expect(connections.statusCode).toBe(200);
    const instagram = connections.json().connections.find((item: { id: string }) => item.id === context.instagramSessionId);
    expect(instagram).toMatchObject({
      channel: "instagram",
      is_primary: false,
      phone_number: null,
      instagram_username: "atendon_comercial",
      instagram_account_id: context.instagramAccountId,
      reconnect_required: false
    });
    expect(instagram.token_expires_at).toBeTruthy();
    expect(JSON.stringify(instagram)).not.toContain("test-access-token");
    expect(connections.json().limits.used).toBe(1);

    const list = await app.inject({ url: "/conversations", headers: { cookie: context.ownerCookie } });
    const listed = list.json().conversations.find((item: { id: string }) => item.id === context.instagramConversationId);
    expect(listed).toMatchObject({
      contact_phone: null,
      instagram_contact_id: context.instagramContactId,
      instagram_username: "cliente_ig",
      contact_identifier: "@cliente_ig",
      channel: "instagram"
    });
    expect(listed.messaging_window_expires_at).toBeTruthy();

    for (const suffix of ["messages", "messages/v2"]) {
      const thread = await app.inject({
        url: `/conversations/${context.instagramConversationId}/${suffix}`,
        headers: { cookie: context.ownerCookie }
      });
      expect(thread.statusCode).toBe(200);
      expect(thread.json().conversation).toMatchObject({
        contact_phone: null,
        instagram_contact_id: context.instagramContactId,
        instagram_username: "cliente_ig",
        contact_identifier: "@cliente_ig",
        channel: "instagram"
      });
      expect(thread.json().conversation.messaging_window_expires_at).toBeTruthy();
    }

    const create = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { cookie: context.ownerCookie },
      payload: { label: "Outra Instagram", channel: "instagram" }
    });
    expect(create.statusCode).toBe(409);
    expect(create.json()).toMatchObject({ code: "INSTAGRAM_OAUTH_REQUIRED", authorization_path: "/instagram/oauth/start" });
  });

  it("enforces tenant and operator conversation scope on channel capabilities", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const ownCapability = await app.inject({
      url: `/conversations/${own.instagramConversationId}/channel-capabilities`,
      headers: { cookie: own.operatorCookie }
    });
    expect(ownCapability.statusCode).toBe(200);
    expect(ownCapability.json()).toMatchObject({
      channel: "instagram",
      can_send: true,
      reason: null,
      text: true,
      image: true,
      audio: true,
      video: true,
      document: true,
      reactions: false,
      edit: false,
      delete: false,
      stickers: false
    });
    expect(ownCapability.json().window_expires_at).toBeTruthy();

    await pool.query(
      "UPDATE whatsapp_sessions SET token_expires_at=now()-interval '1 minute' WHERE id=$1",
      [own.instagramSessionId]
    );
    expect((await app.inject({
      url: `/conversations/${own.instagramConversationId}/channel-capabilities`,
      headers: { cookie: own.operatorCookie }
    })).json()).toMatchObject({ can_send: false, reason: expect.stringContaining("Reconecte") });
    await pool.query(
      "UPDATE whatsapp_sessions SET token_expires_at=now()+interval '1 hour' WHERE id=$1",
      [own.instagramSessionId]
    );
    await pool.query(
      "UPDATE conversations SET messaging_window_expires_at=now()-interval '1 minute' WHERE id=$1",
      [own.instagramConversationId]
    );
    expect((await app.inject({
      url: `/conversations/${own.instagramConversationId}/channel-capabilities`,
      headers: { cookie: own.operatorCookie }
    })).json()).toMatchObject({ can_send: false, reason: expect.stringContaining("24 horas") });
    await pool.query(
      "UPDATE conversations SET messaging_window_expires_at=now()+interval '1 hour' WHERE id=$1",
      [own.instagramConversationId]
    );

    await pool.query(
      "UPDATE conversations SET assigned_user_id=NULL WHERE id=$1 AND tenant_id=$2",
      [own.instagramConversationId, own.tenantId]
    );
    expect((await app.inject({
      url: `/conversations/${own.instagramConversationId}/channel-capabilities`,
      headers: { cookie: own.operatorCookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      url: `/conversations/${foreign.instagramConversationId}/channel-capabilities`,
      headers: { cookie: own.ownerCookie }
    })).statusCode).toBe(404);
  });

  it("uses the shared router for idempotent Instagram text/video and never falls back to Evolution", async () => {
    const context = await fixture();
    const textStart = providerCalls.text.length;
    whatsappSendText.mockClear();
    whatsappSendMedia.mockClear();
    const key = `instagram-text-${randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": key },
      payload: { text: "Resposta pelo Instagram" }
    });
    const replay = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": key },
      payload: { text: "Resposta pelo Instagram" }
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
    expect(providerCalls.text).toHaveLength(textStart + 1);
    expect(providerCalls.text.at(-1)?.recipientId).toBe(context.instagramContactId);
    expect(whatsappSendText).not.toHaveBeenCalled();

    const video = Buffer.from("00000018667479706d70343200000000", "hex");
    const media = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": `instagram-video-${randomUUID()}` },
      payload: {
        mediaType: "video",
        mimeType: "video/mp4",
        fileName: "video.mp4",
        dataBase64: video.toString("base64"),
        caption: "Vídeo"
      }
    });
    expect(media.statusCode).toBe(201);
    expect(providerCalls.media.at(-1)?.recipientId).toBe(context.instagramContactId);
    const publicMediaUrl = new URL(providerCalls.media.at(-1)!.media.url);
    expect(publicMediaUrl.pathname).toMatch(/^\/api\/instagram\/media\//);
    expect(publicMediaUrl.searchParams.get("signature")).toBeTruthy();
    const publicMedia = await app.inject({
      url: `${publicMediaUrl.pathname.replace(/^\/api/, "")}${publicMediaUrl.search}`
    });
    expect(publicMedia.statusCode).toBe(200);
    expect(publicMedia.headers["content-type"]).toContain("video/mp4");
    expect(publicMedia.rawPayload.equals(video)).toBe(true);
    publicMediaUrl.searchParams.set("signature", "tampered");
    expect((await app.inject({
      url: `${publicMediaUrl.pathname.replace(/^\/api/, "")}${publicMediaUrl.search}`
    })).statusCode).toBe(403);
    expect(whatsappSendMedia).not.toHaveBeenCalled();
  });

  it("journals explicit rejection and ambiguity distinctly and never dispatches their replay", async () => {
    const context = await fixture();
    const rejectedKey = `instagram-rejected-${randomUUID()}`;
    const beforeRejected = providerCalls.text.length;
    const rejected = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": rejectedKey },
      payload: { text: "Mensagem explicitamente rejeitada" }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("meta_400");
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2",
      [context.tenantId, rejectedKey]
    )).rows[0].status).toBe("failed");
    expect((await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": rejectedKey },
      payload: { text: "Mensagem explicitamente rejeitada" }
    })).statusCode).toBe(409);
    expect(providerCalls.text).toHaveLength(beforeRejected + 1);

    const ambiguousKey = `instagram-ambiguous-${randomUUID()}`;
    const beforeAmbiguous = providerCalls.text.length;
    const ambiguous = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": ambiguousKey },
      payload: { text: "Mensagem com resultado ambíguo" }
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().code).toBe("SEND_OUTCOME_AMBIGUOUS");
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2",
      [context.tenantId, ambiguousKey]
    )).rows[0].status).toBe("ambiguous");
    expect((await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": ambiguousKey },
      payload: { text: "Mensagem com resultado ambíguo" }
    })).statusCode).toBe(409);
    expect(providerCalls.text).toHaveLength(beforeAmbiguous + 1);
  });

  it("enforces the persisted 24h window before Meta and keeps the WhatsApp send path unchanged", async () => {
    const context = await fixture();
    await pool.query(
      "UPDATE conversations SET messaging_window_expires_at=now()-interval '1 second' WHERE id=$1",
      [context.instagramConversationId]
    );
    const before = providerCalls.text.length;
    const expired = await app.inject({
      method: "POST",
      url: `/conversations/${context.instagramConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": `instagram-expired-${randomUUID()}` },
      payload: { text: "Não pode sair fora da janela" }
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().code).toBe("window_expired");
    expect(providerCalls.text).toHaveLength(before);

    whatsappSendText.mockClear();
    const whatsapp = await app.inject({
      method: "POST",
      url: `/conversations/${context.whatsappConversationId}/messages`,
      headers: { cookie: context.ownerCookie, "idempotency-key": `whatsapp-regression-${randomUUID()}` },
      payload: { text: "Continua no Evolution" }
    });
    expect(whatsapp.statusCode).toBe(201);
    expect(whatsappSendText).toHaveBeenCalledWith(
      context.whatsappSessionId,
      "5511888881212",
      "Continua no Evolution",
      undefined
    );
  });

  it("serves private inbound media through the authenticated existing route with cache and scope", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const mid = `private-${randomUUID()}`;
    const persisted = await repository.persistEvent(
      own.tenantId,
      own.instagramSessionId,
      event(own.instagramAccountId, own.instagramContactId, mid, true),
      Buffer.from("{}")
    );
    expect(persisted.conversationId).toBe(own.instagramConversationId);
    const messageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,media_type,media_mime_type,external_message_id,provider_message_key)
       VALUES($1,'contact','imagem','image','image/jpeg',$2,$3) RETURNING id`,
      [own.instagramConversationId, mid, `${own.tenantId}:${own.instagramSessionId}:${mid}`]
    )).rows[0].id;
    const before = providerCalls.fetch.length;
    const first = await app.inject({
      url: `/conversations/${own.instagramConversationId}/messages/${messageId}/media`,
      headers: { cookie: own.ownerCookie }
    });
    const second = await app.inject({
      url: `/conversations/${own.instagramConversationId}/messages/${messageId}/media`,
      headers: { cookie: own.ownerCookie }
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/jpeg");
    expect(first.rawPayload.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(providerCalls.fetch).toHaveLength(before + 1);
    expect(whatsappDownloadMedia).not.toHaveBeenCalled();

    expect((await app.inject({
      url: `/conversations/${own.instagramConversationId}/messages/${messageId}/media`,
      headers: { cookie: foreign.ownerCookie }
    })).statusCode).toBe(404);
  });

  it("blocks unsupported Instagram operations before Evolution", async () => {
    const context = await fixture();
    whatsappSendText.mockClear();
    whatsappSendMedia.mockClear();
    const messageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key)
       VALUES($1,'human','enviada','mid-human',$2) RETURNING id`,
      [context.instagramConversationId, `${context.tenantId}:${context.instagramSessionId}:mid-human-${randomUUID()}`]
    )).rows[0].id;
    const response = await app.inject({
      method: "PATCH",
      url: `/conversations/${context.instagramConversationId}/messages/${messageId}`,
      headers: { cookie: context.ownerCookie },
      payload: { text: "editar" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CHANNEL_OPERATION_UNSUPPORTED");
    expect(whatsappSendText).not.toHaveBeenCalled();
  });

  it("rejects an Instagram account that is active in another tenant", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(repository.saveConnection({
      tenantId: second.tenantId,
      label: "Tentativa de invasão",
      accountId: first.instagramAccountId,
      username: first.instagramAccountId,
      accessToken: "stolen-token",
      expiresAt: new Date(Date.now() + 60_000)
    })).rejects.toMatchObject({ code: "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED" });
    expect((await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM whatsapp_sessions WHERE id=$1",
      [first.instagramSessionId]
    )).rows[0].tenant_id).toBe(first.tenantId);
  });

  it("lets a disconnected account be connected from another tenant", async () => {
    const previous = await fixture();
    const next = await fixture();
    await repository.disconnect(previous.tenantId, previous.instagramSessionId);
    const claimed = await repository.saveConnection({
      tenantId: next.tenantId,
      label: "Reconexão em outro workspace",
      accountId: previous.instagramAccountId,
      username: previous.instagramAccountId,
      accessToken: "fresh-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(claimed.tenant_id).toBe(next.tenantId);
    expect(claimed.status).toBe("connected");
    await expect(repository.resolveAccount(previous.instagramAccountId)).resolves.toMatchObject({
      tenantId: next.tenantId,
      sessionId: claimed.id
    });
    const previousRow = (await pool.query<{ archived_at: Date | null; credentials_encrypted: string | null }>(
      "SELECT archived_at,credentials_encrypted FROM whatsapp_sessions WHERE id=$1",
      [previous.instagramSessionId]
    )).rows[0];
    expect(previousRow.archived_at).not.toBeNull();
    expect(previousRow.credentials_encrypted).toBeNull();
  });

  it("revives the same tenant's archived row when the account reconnects there", async () => {
    const context = await fixture();
    await repository.disconnect(context.tenantId, context.instagramSessionId);
    const revived = await repository.saveConnection({
      tenantId: context.tenantId,
      label: "Reconexão no mesmo workspace",
      accountId: context.instagramAccountId,
      username: context.instagramAccountId,
      accessToken: "revived-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(revived.id).toBe(context.instagramSessionId);
    expect(revived.status).toBe("connected");
    expect(revived.archived_at).toBeNull();
    await expect(repository.getToken(context.tenantId, revived.id)).resolves.toBe("revived-token");
  });
});

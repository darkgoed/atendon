import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import type { NormalizedInstagramEvent } from "../src/modules/instagram/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const currentKey = "instagram-current-data-key-0000000000000001";
const previousKey = "instagram-previous-data-key-00000000000001";
const tenantIds: string[] = [];

async function createTenant(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`${name}-${randomUUID()}`]
  );
  tenantIds.push(result.rows[0].id);
  return result.rows[0].id;
}

function messageEvent(accountId: string, contactId: string, eventId: string): NormalizedInstagramEvent {
  return {
    kind: "message",
    eventId,
    accountId,
    providerUserId: contactId,
    timestamp: new Date(),
    text: "Olá",
    isEcho: false,
    raw: { message: { mid: eventId, text: "Olá" } }
  };
}

describe("Instagram PostgreSQL persistence", () => {
  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    if (tenantIds.length > 0) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
    await pool.end();
  });

  it("requires encrypted credentials and decrypts through the configured keyring", async () => {
    expect(() => new InstagramRepository(pool, "")).toThrow(/encryption key/i);
    const tenantId = await createTenant("instagram-encryption");
    const repository = new InstagramRepository(pool, {
      current: currentKey,
      previous: [previousKey]
    });

    const connection = await repository.saveConnection({
      tenantId,
      label: "Comercial",
      accountId: `account-${randomUUID()}`,
      username: "empresa",
      accessToken: "meta-token-must-never-be-plain",
      expiresAt: new Date(Date.now() + 3_600_000)
    });

    const stored = await pool.query<{ credentials_encrypted: string }>(
      "SELECT credentials_encrypted FROM whatsapp_sessions WHERE id=$1",
      [connection.id]
    );
    expect(stored.rows[0].credentials_encrypted).toMatch(/^v2\./);
    expect(stored.rows[0].credentials_encrypted).not.toContain("meta-token-must-never-be-plain");
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("meta-token-must-never-be-plain");
  });

  it("finds a connection by tenant and connection UUID and resolves an account globally", async () => {
    const tenantId = await createTenant("instagram-resolution");
    const repository = new InstagramRepository(pool, currentKey);
    const accountId = `account-${randomUUID()}`;
    const connection = await repository.saveConnection({
      tenantId,
      label: "Suporte",
      accountId,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });

    await expect(repository.findConnection(tenantId, connection.id)).resolves.toMatchObject({
      id: connection.id,
      tenant_id: tenantId,
      provider_account_id: accountId,
      channel: "instagram",
      status: "connected"
    });
    await expect(repository.findConnection(randomUUID(), connection.id)).resolves.toBeNull();
    await expect(repository.resolveAccount(accountId)).resolves.toEqual({
      tenantId,
      sessionId: connection.id
    });
  });

  it("enforces global account ownership and serializes the per-tenant active limit", async () => {
    const tenantA = await createTenant("instagram-owner-a");
    const tenantB = await createTenant("instagram-owner-b");
    const sharedAccount = `account-${randomUUID()}`;
    const repository = new InstagramRepository(pool, currentKey, 1);

    await repository.saveConnection({
      tenantId: tenantA,
      label: "Única",
      accountId: sharedAccount,
      accessToken: "token-a",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    await expect(repository.saveConnection({
      tenantId: tenantB,
      label: "Conta alheia",
      accountId: sharedAccount,
      accessToken: "token-b",
      expiresAt: new Date(Date.now() + 3_600_000)
    })).rejects.toMatchObject({ statusCode: 409 });

    const concurrentTenant = await createTenant("instagram-limit");
    const attempts = await Promise.allSettled([
      repository.saveConnection({
        tenantId: concurrentTenant,
        label: "Primeira",
        accountId: `account-${randomUUID()}`,
        accessToken: "first",
        expiresAt: new Date(Date.now() + 3_600_000)
      }),
      repository.saveConnection({
        tenantId: concurrentTenant,
        label: "Segunda",
        accountId: `account-${randomUUID()}`,
        accessToken: "second",
        expiresAt: new Date(Date.now() + 3_600_000)
      })
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='instagram' AND archived_at IS NULL",
      [concurrentTenant]
    )).rows[0].count).toBe(1);
  });

  it("keeps Instagram lead identity scoped to its connection and preserves WhatsApp uniqueness", async () => {
    const tenantId = await createTenant("instagram-identities");
    const repository = new InstagramRepository(pool, currentKey);
    const first = await repository.saveConnection({
      tenantId,
      label: "Marca A",
      accountId: `account-${randomUUID()}`,
      accessToken: "first",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const second = await repository.saveConnection({
      tenantId,
      label: "Marca B",
      accountId: `account-${randomUUID()}`,
      accessToken: "second",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    const firstPersisted = await repository.persistEvent(
      tenantId,
      first.id,
      messageEvent(first.provider_account_id, contactId, `message-${randomUUID()}`),
      Buffer.from('{"source":"first"}')
    );
    const secondPersisted = await repository.persistEvent(
      tenantId,
      second.id,
      messageEvent(second.provider_account_id, contactId, `message-${randomUUID()}`),
      Buffer.from('{"source":"second"}')
    );

    expect(firstPersisted.conversationId).not.toBe(secondPersisted.conversationId);
    const instagramLeads = await pool.query<{
      phone: string | null;
      instagram_session_id: string;
      instagram_contact_id: string;
    }>(
      `SELECT phone,instagram_session_id,instagram_contact_id
       FROM scheduling_leads
       WHERE tenant_id=$1 AND instagram_contact_id=$2
       ORDER BY instagram_session_id`,
      [tenantId, contactId]
    );
    expect(instagramLeads.rows).toHaveLength(2);
    expect(instagramLeads.rows.every((lead) => lead.phone === null)).toBe(true);

    const whatsapp = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,channel) VALUES($1,'WhatsApp','whatsapp') RETURNING id",
      [tenantId]
    )).rows[0];
    await pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999998888')",
      [tenantId, whatsapp.id]
    );
    await expect(pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999998888')",
      [tenantId, whatsapp.id]
    )).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,NULL)",
      [tenantId, whatsapp.id]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("disconnects atomically, cancels pending sends and cannot refresh a revoked row", async () => {
    const tenantId = await createTenant("instagram-disconnect");
    const repository = new InstagramRepository(pool, currentKey);
    const connection = await repository.saveConnection({
      tenantId,
      label: "Desconectar",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    await pool.query(
      `INSERT INTO instagram_webhook_outbox(tenant_id,session_id,kind,payload,idempotency_key)
       VALUES($1,$2,'message','{}',$3)`,
      [tenantId, connection.id, randomUUID()]
    );

    await expect(repository.disconnect(tenantId, connection.id)).resolves.toBe(true);
    await expect(repository.getToken(tenantId, connection.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.updateToken(
      tenantId,
      connection.id,
      "must-not-reactivate",
      new Date(Date.now() + 3_600_000)
    )).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query(
      "SELECT status,failure_code FROM instagram_webhook_outbox WHERE session_id=$1",
      [connection.id]
    )).rows[0]).toEqual({ status: "rejected", failure_code: "connection_disconnected" });
  });

  it("returns the authoritative conversation window for tenant, connection and IGSID", async () => {
    const tenantId = await createTenant("instagram-window");
    const repository = new InstagramRepository(pool, currentKey);
    const connection = await repository.saveConnection({
      tenantId,
      label: "Janela",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    const event = messageEvent(connection.provider_account_id, contactId, `message-${randomUUID()}`);
    const persisted = await repository.persistEvent(tenantId, connection.id, event, Buffer.from("{}"));

    await expect(repository.getConversationWindow(tenantId, connection.id, contactId)).resolves.toMatchObject({
      conversationId: persisted.conversationId
    });
    await expect(repository.getConversationWindow(tenantId, connection.id, "unknown")).resolves.toBeNull();
  });

  it("rejects cross-connection media and outbox associations inside one tenant", async () => {
    const tenantId = await createTenant("instagram-cross-connection");
    const repository = new InstagramRepository(pool, currentKey);
    const first = await repository.saveConnection({
      tenantId,
      label: "Conta A",
      accountId: `account-${randomUUID()}`,
      accessToken: "first",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const second = await repository.saveConnection({
      tenantId,
      label: "Conta B",
      accountId: `account-${randomUUID()}`,
      accessToken: "second",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const contactId = `igsid-${randomUUID()}`;
    const persisted = await repository.persistEvent(
      tenantId,
      first.id,
      messageEvent(first.provider_account_id, contactId, `message-${randomUUID()}`),
      Buffer.from("{}")
    );

    await expect(repository.savePublicMedia({
      tenantId,
      sessionId: second.id,
      conversationId: persisted.conversationId,
      bytes: Buffer.from("wrong-account-media"),
      contentType: "image/jpeg",
      expiresAt: new Date(Date.now() + 60_000)
    })).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `INSERT INTO instagram_webhook_outbox(
         tenant_id,session_id,conversation_id,kind,payload,idempotency_key
       ) VALUES($1,$2,$3,'message','{}',$4)`,
      [tenantId, second.id, persisted.conversationId, randomUUID()]
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps migration-era Instagram placeholders non-routable without weakening ciphertext rows", async () => {
    const tenantId = await createTenant("instagram-placeholder");
    const placeholder = (await pool.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel)
       VALUES($1,'Instagram schema-ready',false,'connected','instagram') RETURNING id`,
      [tenantId]
    )).rows[0];
    const repository = new InstagramRepository(pool, currentKey);

    await expect(repository.findConnection(tenantId, placeholder.id)).resolves.toBeNull();
    await expect(repository.getToken(tenantId, placeholder.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(pool.query(
      `UPDATE whatsapp_sessions SET provider_account_id=$2,credentials_encrypted='plain-text',
       token_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [placeholder.id, `account-${randomUUID()}`]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("stores public media bytes and only returns unexpired media", async () => {
    const tenantId = await createTenant("instagram-media");
    const repository = new InstagramRepository(pool, currentKey);
    const connection = await repository.saveConnection({
      tenantId,
      label: "Mídia",
      accountId: `account-${randomUUID()}`,
      accessToken: "token",
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    const media = await repository.savePublicMedia({
      tenantId,
      sessionId: connection.id,
      bytes: Buffer.from("real-media-bytes"),
      contentType: "image/jpeg",
      expiresAt: new Date(Date.now() + 60_000),
      sourceUrl: "https://cdn.example.test/photo.jpg"
    });

    await expect(repository.getPublicMedia(media.id)).resolves.toMatchObject({
      id: media.id,
      contentType: "image/jpeg",
      sizeBytes: 16
    });
    expect((await repository.getPublicMedia(media.id))?.bytes.equals(Buffer.from("real-media-bytes"))).toBe(true);
    await pool.query("UPDATE instagram_media SET expires_at=now()-interval '1 second' WHERE id=$1", [media.id]);
    await expect(repository.getPublicMedia(media.id)).resolves.toBeNull();
  });
});

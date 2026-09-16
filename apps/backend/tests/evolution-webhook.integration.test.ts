import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { inboundJobId, inboundQueue } from "../src/queue/message-queue.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const records: Array<{ tenantId: string; sessionId: string; instanceName: string }> = [];
const inboundJobIds = new Set<string>();

function equalProviderMessage(record: { tenantId: string; sessionId: string }) {
  return {
    externalId: "same-provider-id",
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    contactPhone: "5511999999999",
    contactJid: "5511999999999@s.whatsapp.net",
    text: "olá"
  };
}

async function removeInboundJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await inboundQueue.getJob(jobId);
    if (!job) return;
    try {
      await job.remove();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("locked by another worker")) throw error;
      await delay(100);
    }
  }
}

beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    const tenant = await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`evo-${suffix}-${randomUUID()}`]);
    const instanceName = `evo_test_${suffix}_${randomUUID().replaceAll("-", "")}`;
    const session = await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,instance_name) VALUES($1,$2) RETURNING id", [tenant.rows[0].id, instanceName]);
    records.push({ tenantId: tenant.rows[0].id, sessionId: session.rows[0].id, instanceName });
  }
});

afterAll(async () => {
  for (const jobId of inboundJobIds) await removeInboundJob(jobId);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [records.map((record) => record.tenantId)]);
  await app.close();
  await pool.end();
});

describe("Evolution webhook Redis buffer", () => {
  it("buffers equal provider IDs independently under the tenant resolved from each instance", async () => {
    const jobs = [];
    for (const record of records) {
      const expectedMessage = equalProviderMessage(record);
      const jobId = inboundJobId(expectedMessage);
      inboundJobIds.add(jobId);
      const payload = {
        event: "messages.upsert", instance: record.instanceName,
        data: { key: { id: "same-provider-id", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }, message: {
          extendedTextMessage:{text:"olá",contextInfo:{externalAdReply:{sourceType:"ad",sourceId:"ad-redis",headline:"Newave"}}}
        } }
      };
      const response = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload });
      expect(response.statusCode).toBe(204);
      const firstJob = await inboundQueue.getJob(jobId);
      expect(firstJob?.data).toMatchObject({ ...expectedMessage, referral:{sourceType:"ad",sourceId:"ad-redis",headline:"Newave"} });

      expect((await app.inject({ method:"POST",url:"/webhooks/evolution",headers:{"x-atendon-webhook-secret":config.EVOLUTION_WEBHOOK_SECRET},payload })).statusCode).toBe(204);
      const duplicateJob = await inboundQueue.getJob(jobId);
      expect(duplicateJob?.data.aiTurnId).toBe(firstJob?.data.aiTurnId);
      jobs.push(duplicateJob);
    }
    expect(jobs).toHaveLength(records.length);
    expect(new Set(jobs.map((job) => job?.id)).size).toBe(records.length);
  });

  it("rejects unknown instances before writing to Redis", async () => {
    const response = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.upsert", instance: `unknown_${randomUUID()}`, data: {}
    } });
    expect(response.statusCode).toBe(404);
  });

  it("rejects missing or invalid webhook credentials", async () => {
    const payload = { event: "messages.upsert", instance: records[0].instanceName, data: {} };
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": "invalid" }, payload })).statusCode).toBe(401);
  });

  it("reflects connection and mobile logout states in the persisted session", async () => {
    const record = records[0];
    const connected = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "connection.update", instance: record.instanceName,
      data: { state: "open", ownerJid: "5511988887777:4@s.whatsapp.net" }
    } });
    expect(connected.statusCode).toBe(204);
    expect((await pool.query("SELECT status,phone_number FROM whatsapp_sessions WHERE id=$1", [record.sessionId])).rows[0])
      .toMatchObject({ status: "connected", phone_number: "5511988887777" });

    const disconnected = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "connection.update", instance: record.instanceName,
      data: { state: "close", reason: "logged_out" }
    } });
    expect(disconnected.statusCode).toBe(204);
    expect((await pool.query("SELECT status,qr_code,disconnected_reason FROM whatsapp_sessions WHERE id=$1", [record.sessionId])).rows[0])
      .toMatchObject({ status: "disconnected", qr_code: null, disconnected_reason: "logged_out" });
  });

  it("advances an outbound message's tick status on messages.update, but never regresses it", async () => {
    const record = records[1];
    const externalId = `wamid-${randomUUID()}`;
    const providerMessageKey = `${record.tenantId}:${record.sessionId}:${externalId}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [record.tenantId, record.sessionId, "5511977776666"]
    );
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key) VALUES($1,'agent','Olá!',$2,$3)",
      [conversation.rows[0].id, externalId, providerMessageKey]
    );

    const delivered = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { key: { id: externalId }, update: { status: "DELIVERY_ACK" } }
    } });
    expect(delivered.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("delivered");

    const stalePending = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { key: { id: externalId }, update: { status: "SERVER_ACK" } }
    } });
    expect(stalePending.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("delivered");

    const staleError = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { key: { id: externalId, fromMe: true }, update: { status: "ERROR" } }
    } });
    expect(staleError.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("delivered");
    expect((await pool.query(
      "SELECT count(*)::int count FROM system_alerts WHERE tenant_id=$1 AND message LIKE '%ack ERROR%'",
      [record.tenantId]
    )).rows[0].count).toBe(0);

    const read = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { key: { id: externalId }, update: { status: "READ" } }
    } });
    expect(read.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("read");
  });

  it("persists an outbound ERROR ack and accepts a later successful ack", async () => {
    const record = records[1];
    const externalId = `wamid-error-${randomUUID()}`;
    const providerMessageKey = `${record.tenantId}:${record.sessionId}:${externalId}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [record.tenantId, record.sessionId, `55${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`]
    );
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key) VALUES($1,'agent','Olá!',$2,$3)",
      [conversation.rows[0].id, externalId, providerMessageKey]
    );

    const failed = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { keyId: externalId, fromMe: true, status: "ERROR" }
    } });
    expect(failed.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("failed");
    expect((await pool.query(
      "SELECT message FROM system_alerts WHERE tenant_id=$1 AND message LIKE 'O WhatsApp rejeitou uma mensagem.%'",
      [record.tenantId]
    )).rows).toEqual([{
      message: "O WhatsApp rejeitou uma mensagem. Revise a conversa antes de qualquer reenvio e não reconecte uma instância que esteja saudável."
    }]);
    expect((await pool.query(
      "SELECT count(*)::int count FROM messages WHERE conversation_id=$1",
      [conversation.rows[0].id]
    )).rows[0].count).toBe(1);

    const recovered = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET }, payload: {
      event: "messages.update", instance: record.instanceName, data: { keyId: externalId, fromMe: true, status: "SERVER_ACK" }
    } });
    expect(recovered.statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM messages WHERE provider_message_key=$1", [providerMessageKey])).rows[0].status).toBe("sent");
  });

  it("persists contact presence and last seen only inside the resolved tenant session", async () => {
    const record = records[0];
    const contactPhone = `55${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [record.tenantId, record.sessionId, contactPhone]
    );
    const lastSeen = 1_750_000_000;
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { "x-atendon-webhook-secret": config.EVOLUTION_WEBHOOK_SECRET },
      payload: {
        event: "presence.update",
        instance: record.instanceName,
        data: {
          id: `${contactPhone}@s.whatsapp.net`,
          presences: { [`${contactPhone}@s.whatsapp.net`]: { lastKnownPresence: "unavailable", lastSeen } }
        }
      }
    });
    expect(response.statusCode).toBe(204);
    const state = await pool.query<{ contact_presence: string; contact_last_seen_at: Date; contact_jid: string }>(
      "SELECT contact_presence,contact_last_seen_at,contact_jid FROM conversations WHERE id=$1",
      [conversation.rows[0].id]
    );
    expect(state.rows[0]).toMatchObject({
      contact_presence: "unavailable",
      contact_jid: `${contactPhone}@s.whatsapp.net`,
      contact_last_seen_at: new Date(lastSeen * 1_000)
    });
  });
});

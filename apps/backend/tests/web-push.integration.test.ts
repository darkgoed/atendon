import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { WebPushRepository } from "../src/modules/web-push/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repository = new WebPushRepository(pool);
const app = buildApp();
let tenantId = "";
let userId = "";
let cookie = "";

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Web Push ${randomUUID()}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const email = `web-push-${randomUUID()}@test.local`;
    userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [email]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, userId]
    );
    await client.query("COMMIT");
    cookie = `atendon_session=${await createSessionToken({ userId, tenantId, email, role: "OWNER" })}`;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await app.close();
  await pool.end();
});

describe("Web Push subscriptions and preferences", () => {
  it("rejects preference and subscription access without a valid session", async () => {
    expect((await app.inject({ url: "/me/push" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/me/push/subscriptions",
      payload: {
        endpoint: "https://push.example/unauthenticated",
        keys: { p256dh: "public-key-material", auth: "auth-secret" },
        deviceName: "Sem sessão"
      }
    })).statusCode).toBe(401);
  });

  it("exposes safe defaults and persists personal category preferences", async () => {
    const defaults = await app.inject({ url: "/me/push", headers: { cookie } });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      subscription_count: 0,
      preferences: {
        web_push_enabled: true,
        push_assigned_messages: true,
        push_assignments: true,
        push_appointments: true,
        push_critical_alerts: true,
        push_other: false
      }
    });

    const changed = await app.inject({
      method: "PATCH",
      url: "/me/push/preferences",
      headers: { cookie },
      payload: { push_other: true, push_critical_alerts: false }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().preferences).toMatchObject({ push_other: true, push_critical_alerts: false });
  });

  it("persists multiple devices per user/workspace and deletes only the selected endpoint", async () => {
    for (const suffix of ["a", "b"]) {
      await repository.upsertSubscription({
        tenantId,
        userId,
        endpoint: `https://push.example/${suffix}/${randomUUID()}`,
        p256dh: `public-key-${suffix}-material`,
        auth: `auth-${suffix}-secret`,
        deviceName: `Device ${suffix}`
      });
    }
    expect(await repository.subscriptionCount(tenantId, userId)).toBe(2);
    const endpoint = (await pool.query<{ endpoint: string }>(
      "SELECT endpoint FROM web_push_subscriptions WHERE tenant_id=$1 AND user_id=$2 ORDER BY endpoint LIMIT 1",
      [tenantId, userId]
    )).rows[0].endpoint;
    const removed = await app.inject({
      method: "DELETE",
      url: "/me/push/subscriptions",
      headers: { cookie },
      payload: { endpoint }
    });
    expect(removed.statusCode).toBe(204);
    expect(await repository.subscriptionCount(tenantId, userId)).toBe(1);
  });

  it("deduplicates outbox events and never persists message/contact content in the push payload", async () => {
    await repository.updatePreferences(tenantId, userId, {
      web_push_enabled: true,
      push_assigned_messages: true
    });
    const sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    const phone = `5511${String(Date.now()).slice(-9)}`;
    await pool.query(
      `INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'web-push','Web Push')
       ON CONFLICT(tenant_id,id) DO NOTHING`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
       ) VALUES($1,'web-push','Web Push','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)
       ON CONFLICT(tenant_id,id) DO NOTHING`,
      [tenantId]
    );
    const leadId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,interest_category_id,unit_id,source)
       VALUES($1,$2,'Nome confidencial','web-push','web-push','test') RETURNING id`,
      [tenantId, phone]
    )).rows[0].id;
    const conversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,assigned_user_id,lead_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, sessionId, phone, "Nome confidencial", userId, leadId]
    )).rows[0].id;
    const messageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content)
       VALUES($1,'contact','Trecho confidencial da mensagem') RETURNING id`,
      [conversationId]
    )).rows[0].id;

    const outbox = await pool.query<{
      event_type: string;
      target_path: string;
      dedupe_key: string;
    }>(
      `SELECT event_type,target_path,dedupe_key FROM web_push_outbox
       WHERE tenant_id=$1 AND user_id=$2 AND dedupe_key=$3`,
      [tenantId, userId, `assigned-message:${messageId}`]
    );
    expect(outbox.rows).toEqual([{
      event_type: "assigned_message",
      target_path: `/conversas?id=${conversationId}`,
      dedupe_key: `assigned-message:${messageId}`
    }]);
    expect(JSON.stringify(outbox.rows[0])).not.toContain("Nome confidencial");
    expect(JSON.stringify(outbox.rows[0])).not.toContain("Trecho confidencial");

    const first = await repository.createOutbox({
      tenantId,
      userId,
      eventType: "other",
      urgency: "low",
      targetPath: "/",
      resourceType: "test",
      dedupeKey: "same-event"
    });
    const second = await repository.createOutbox({
      tenantId,
      userId,
      eventType: "other",
      urgency: "low",
      targetPath: "/",
      resourceType: "test",
      dedupeKey: "same-event"
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await repository.prepareDeliveries(randomUUID(), first.id)).toBeNull();
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM web_push_outbox WHERE tenant_id=$1 AND id=$2",
      [tenantId, first.id]
    )).rows[0].status).toBe("pending");
  });

  it("suppresses queued delivery and removes tenant subscriptions when membership is revoked", async () => {
    const revokedUserId = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`web-push-revoked-${randomUUID()}@test.local`]
    )).rows[0].id;
    try {
      const memberId = (await pool.query<{ id: string }>(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles
         WHERE workspace_id=$1 AND name='OWNER' RETURNING id`,
        [tenantId, revokedUserId]
      )).rows[0].id;
      await repository.upsertSubscription({
        tenantId,
        userId: revokedUserId,
        endpoint: `https://push.example/revoked/${randomUUID()}`,
        p256dh: "public-key-revoked-material",
        auth: "auth-revoked-secret",
        deviceName: "Revoked device"
      });
      const dedupeKey = `revoke-after-queue:${randomUUID()}`;
      const outbox = await repository.createOutbox({
        tenantId,
        userId: revokedUserId,
        eventType: "critical_alert",
        urgency: "critical",
        targetPath: "/alertas",
        resourceType: "test",
        dedupeKey
      });

      await pool.query("DELETE FROM workspace_members WHERE id=$1", [memberId]);

      expect(await repository.subscriptionCount(tenantId, revokedUserId)).toBe(0);
      expect(await repository.prepareDeliveries(tenantId, outbox.id)).toBeNull();
      expect((await pool.query<{ status: string; last_error: string }>(
        "SELECT status,last_error FROM web_push_outbox WHERE tenant_id=$1 AND id=$2",
        [tenantId, outbox.id]
      )).rows[0]).toEqual({ status: "sent", last_error: "suppressed_by_membership" });
      await expect(repository.createOutbox({
        tenantId,
        userId: revokedUserId,
        eventType: "other",
        urgency: "low",
        targetPath: "/",
        resourceType: "test",
        dedupeKey
      })).rejects.toThrow(/active workspace access/i);
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [revokedUserId]);
    }
  });

  it("keeps explicit root workspace push access until root status is revoked", async () => {
    const rootUserId = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
      [`web-push-root-${randomUUID()}@test.local`]
    )).rows[0].id;
    try {
      await repository.upsertSubscription({
        tenantId,
        userId: rootUserId,
        endpoint: `https://push.example/root/${randomUUID()}`,
        p256dh: "public-key-root-material",
        auth: "auth-root-secret",
        deviceName: "Root device"
      });
      const outbox = await repository.createOutbox({
        tenantId,
        userId: rootUserId,
        eventType: "critical_alert",
        urgency: "critical",
        targetPath: "/alertas",
        resourceType: "test",
        dedupeKey: `root-access:${randomUUID()}`
      });
      const delivery = (await repository.prepareDeliveries(tenantId, outbox.id))?.[0];
      expect(delivery).toBeDefined();

      await pool.query("UPDATE users SET is_root=false WHERE id=$1", [rootUserId]);

      expect(await repository.subscriptionCount(tenantId, rootUserId)).toBe(0);
      expect(await repository.deliveryStillAuthorized(
        tenantId,
        outbox.id,
        delivery!.subscriptionId
      )).toBe(false);
      await repository.finishOutbox(outbox.id);
      expect((await pool.query<{ status: string; last_error: string }>(
        "SELECT status,last_error FROM web_push_outbox WHERE tenant_id=$1 AND id=$2",
        [tenantId, outbox.id]
      )).rows[0]).toEqual({ status: "sent", last_error: "suppressed_by_membership" });
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [rootUserId]);
    }
  });
});

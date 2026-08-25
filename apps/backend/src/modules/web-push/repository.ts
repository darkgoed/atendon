import type pg from "pg";
import { listAllTenantEffectiveFeatureFlags } from "../operations/feature-flags.js";

export type WebPushEventType =
  | "assigned_message"
  | "case_assignment"
  | "handoff"
  | "appointment_changed"
  | "appointment_reminder"
  | "critical_alert"
  | "other";

export type WebPushUrgency = "low" | "normal" | "high" | "critical";

export interface PushPreferences {
  web_push_enabled: boolean;
  push_assigned_messages: boolean;
  push_assignments: boolean;
  push_appointments: boolean;
  push_critical_alerts: boolean;
  push_other: boolean;
}

export interface PendingWebPushDelivery {
  outboxId: string;
  tenantId: string;
  eventType: WebPushEventType;
  urgency: WebPushUrgency;
  targetPath: string;
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const DEFAULT_PREFERENCES: PushPreferences = {
  web_push_enabled: true,
  push_assigned_messages: true,
  push_assignments: true,
  push_appointments: true,
  push_critical_alerts: true,
  push_other: false
};

export class WebPushRepository {
  constructor(private readonly pool: pg.Pool) {}

  async preferences(tenantId: string, userId: string): Promise<PushPreferences> {
    const result = await this.pool.query<PushPreferences>(
      `SELECT web_push_enabled,push_assigned_messages,push_assignments,
              push_appointments,push_critical_alerts,push_other
       FROM panel_notification_preferences
       WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId]
    );
    return result.rows[0] ?? DEFAULT_PREFERENCES;
  }

  async updatePreferences(
    tenantId: string,
    userId: string,
    patch: Partial<PushPreferences>
  ): Promise<PushPreferences> {
    const result = await this.pool.query<PushPreferences>(
      `INSERT INTO panel_notification_preferences(
         tenant_id,user_id,web_push_enabled,push_assigned_messages,push_assignments,
         push_appointments,push_critical_alerts,push_other
       ) VALUES($1,$2,COALESCE($3,true),COALESCE($4,true),COALESCE($5,true),COALESCE($6,true),COALESCE($7,true),COALESCE($8,false))
       ON CONFLICT(tenant_id,user_id) DO UPDATE SET
         web_push_enabled=COALESCE($3,panel_notification_preferences.web_push_enabled),
         push_assigned_messages=COALESCE($4,panel_notification_preferences.push_assigned_messages),
         push_assignments=COALESCE($5,panel_notification_preferences.push_assignments),
         push_appointments=COALESCE($6,panel_notification_preferences.push_appointments),
         push_critical_alerts=COALESCE($7,panel_notification_preferences.push_critical_alerts),
         push_other=COALESCE($8,panel_notification_preferences.push_other),
         updated_at=now()
       RETURNING web_push_enabled,push_assigned_messages,push_assignments,
                 push_appointments,push_critical_alerts,push_other`,
      [
        tenantId,
        userId,
        patch.web_push_enabled ?? null,
        patch.push_assigned_messages ?? null,
        patch.push_assignments ?? null,
        patch.push_appointments ?? null,
        patch.push_critical_alerts ?? null,
        patch.push_other ?? null
      ]
    );
    const preferences = result.rows[0];
    await this.pool.query(
      `UPDATE web_push_outbox
       SET status='sent',sent_at=now(),last_error='suppressed_by_preference',updated_at=now()
       WHERE tenant_id=$1 AND user_id=$2 AND status IN ('pending','processing')
         AND (
           $3::boolean=false
           OR (event_type='assigned_message' AND $4::boolean=false)
           OR (event_type IN ('case_assignment','handoff') AND $5::boolean=false)
           OR (event_type IN ('appointment_changed','appointment_reminder') AND $6::boolean=false)
           OR (event_type='critical_alert' AND $7::boolean=false)
           OR (event_type='other' AND $8::boolean=false)
         )`,
      [
        tenantId,
        userId,
        preferences.web_push_enabled,
        preferences.push_assigned_messages,
        preferences.push_assignments,
        preferences.push_appointments,
        preferences.push_critical_alerts,
        preferences.push_other
      ]
    );
    return preferences;
  }

  async upsertSubscription(input: {
    tenantId: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    expirationTime?: number | null;
    deviceName: string;
    userAgent?: string;
  }): Promise<{ id: string }> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO web_push_subscriptions(
         tenant_id,user_id,endpoint,p256dh,auth,expiration_time,device_name,user_agent
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8
       WHERE web_push_recipient_active($1,$2)
       ON CONFLICT(tenant_id,user_id,endpoint) DO UPDATE SET
         p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,expiration_time=EXCLUDED.expiration_time,
         device_name=EXCLUDED.device_name,user_agent=EXCLUDED.user_agent,updated_at=now()
       RETURNING id`,
      [
        input.tenantId,
        input.userId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.expirationTime ?? null,
        input.deviceName,
        input.userAgent ?? null
      ]
    );
    if (!result.rows[0]) throw new Error("Web Push recipient does not have active workspace access");
    return result.rows[0];
  }

  async deleteSubscription(tenantId: string, userId: string, endpoint: string): Promise<boolean> {
    const deleted = await this.pool.query(
      `DELETE FROM web_push_subscriptions
       WHERE tenant_id=$1 AND user_id=$2 AND endpoint=$3`,
      [tenantId, userId, endpoint]
    );
    return (deleted.rowCount ?? 0) > 0;
  }

  async subscriptionCount(tenantId: string, userId: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM web_push_subscriptions
       WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async createOutbox(input: {
    tenantId: string;
    userId: string;
    eventType: WebPushEventType;
    urgency: WebPushUrgency;
    targetPath: string;
    resourceType: string;
    resourceId?: string | null;
    dedupeKey: string;
  }): Promise<{ id: string; created: boolean }> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO web_push_outbox(
         tenant_id,user_id,event_type,urgency,target_path,resource_type,resource_id,dedupe_key
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8
       WHERE web_push_recipient_active($1,$2)
       ON CONFLICT(tenant_id,user_id,dedupe_key) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.userId, input.eventType, input.urgency, input.targetPath,
        input.resourceType, input.resourceId ?? null, input.dedupeKey]
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM web_push_outbox
       WHERE tenant_id=$1 AND user_id=$2 AND dedupe_key=$3
         AND web_push_recipient_active($1,$2)`,
      [input.tenantId, input.userId, input.dedupeKey]
    );
    if (!existing.rows[0]) throw new Error("Web Push recipient does not have active workspace access");
    return { id: existing.rows[0].id, created: false };
  }

  async prepareDeliveries(tenantId: string, outboxId: string): Promise<PendingWebPushDelivery[] | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE web_push_outbox
         SET status='sent',processing_started_at=NULL,sent_at=now(),
             last_error='suppressed_by_membership',updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','processing')
           AND NOT web_push_recipient_active(tenant_id,user_id)`,
        [tenantId, outboxId]
      );
      const claimed = await client.query<{
        id: string;
        tenant_id: string;
        user_id: string;
        event_type: WebPushEventType;
        urgency: WebPushUrgency;
        target_path: string;
      }>(
        `SELECT id,tenant_id,user_id,event_type,urgency,target_path
         FROM web_push_outbox
         WHERE tenant_id=$1 AND id=$2
           AND status IN ('pending','processing') AND available_at<=now()
           AND web_push_effective_enabled(tenant_id)
           AND web_push_recipient_active(tenant_id,user_id)
         FOR UPDATE`,
        [tenantId, outboxId]
      );
      const outbox = claimed.rows[0];
      if (!outbox) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE web_push_outbox
         SET status='processing',processing_started_at=now(),attempt_count=attempt_count+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, outboxId]
      );
      await client.query(
        `INSERT INTO web_push_deliveries(outbox_id,tenant_id,subscription_id)
         SELECT $1,subscription.tenant_id,subscription.id
         FROM web_push_subscriptions subscription
         WHERE subscription.tenant_id=$2 AND subscription.user_id=$3
         ON CONFLICT(outbox_id,subscription_id) DO NOTHING`,
        [outboxId, outbox.tenant_id, outbox.user_id]
      );
      const deliveries = await client.query<{
        subscription_id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      }>(
        `SELECT delivery.subscription_id,subscription.endpoint,subscription.p256dh,subscription.auth
         FROM web_push_deliveries delivery
         JOIN web_push_subscriptions subscription
           ON subscription.id=delivery.subscription_id
          AND subscription.tenant_id=delivery.tenant_id
         WHERE delivery.outbox_id=$1 AND delivery.tenant_id=$2 AND delivery.status='pending'
         ORDER BY delivery.subscription_id`,
        [outboxId, tenantId]
      );
      await client.query("COMMIT");
      return deliveries.rows.map((delivery) => ({
        outboxId,
        tenantId: outbox.tenant_id,
        eventType: outbox.event_type,
        urgency: outbox.urgency,
        targetPath: outbox.target_path,
        subscriptionId: delivery.subscription_id,
        endpoint: delivery.endpoint,
        p256dh: delivery.p256dh,
        auth: delivery.auth
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeliverySent(outboxId: string, subscriptionId: string): Promise<void> {
    await this.pool.query(
      `WITH delivered AS (
         UPDATE web_push_deliveries
         SET status='sent',attempt_count=attempt_count+1,last_error=NULL,sent_at=now(),updated_at=now()
         WHERE outbox_id=$1 AND subscription_id=$2
         RETURNING subscription_id
       )
       UPDATE web_push_subscriptions subscription
       SET last_success_at=now(),updated_at=now()
       FROM delivered WHERE subscription.id=delivered.subscription_id`,
      [outboxId, subscriptionId]
    );
  }

  async deliveryStillAuthorized(
    tenantId: string,
    outboxId: string,
    subscriptionId: string
  ): Promise<boolean> {
    const result = await this.pool.query<{ authorized: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM web_push_outbox outbox
         JOIN web_push_subscriptions subscription
           ON subscription.tenant_id=outbox.tenant_id
          AND subscription.user_id=outbox.user_id
         WHERE outbox.tenant_id=$1 AND outbox.id=$2
           AND subscription.id=$3
           AND outbox.status='processing'
           AND web_push_recipient_active(outbox.tenant_id,outbox.user_id)
       ) authorized`,
      [tenantId, outboxId, subscriptionId]
    );
    return result.rows[0]?.authorized === true;
  }

  async removeExpiredSubscription(subscriptionId: string): Promise<void> {
    await this.pool.query("DELETE FROM web_push_subscriptions WHERE id=$1", [subscriptionId]);
  }

  async markDeliveryRetry(outboxId: string, subscriptionId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE web_push_deliveries
       SET attempt_count=attempt_count+1,last_error=$3,updated_at=now()
       WHERE outbox_id=$1 AND subscription_id=$2 AND status='pending'`,
      [outboxId, subscriptionId, error.slice(0, 2_000)]
    );
  }

  async finishOutbox(outboxId: string, error?: string, terminal = false): Promise<void> {
    if (error) {
      await this.pool.query(
        `UPDATE web_push_outbox SET status=$2,processing_started_at=NULL,last_error=$3,updated_at=now()
         WHERE id=$1 AND status IN ('pending','processing')`,
        [outboxId, terminal ? "failed" : "pending", error.slice(0, 2_000)]
      );
      if (terminal) {
        await this.pool.query(
          `UPDATE web_push_deliveries SET status='failed',updated_at=now()
           WHERE outbox_id=$1 AND status='pending'
             AND EXISTS(
               SELECT 1 FROM web_push_outbox
               WHERE id=$1 AND status='failed'
             )`,
          [outboxId]
        );
      }
      return;
    }
    await this.pool.query(
      `UPDATE web_push_outbox
       SET status='sent',processing_started_at=NULL,last_error=NULL,sent_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('pending','processing')`,
      [outboxId]
    );
  }

  async findPendingJobs(limit = 200): Promise<Array<{ tenantId: string; outboxId: string }>> {
    await this.pool.query(
      `UPDATE web_push_outbox
       SET status='sent',processing_started_at=NULL,sent_at=now(),
           last_error='suppressed_by_membership',updated_at=now()
       WHERE status IN ('pending','processing')
         AND NOT web_push_recipient_active(tenant_id,user_id)`
    );
    const result = await this.pool.query<{ id: string; tenant_id: string }>(
      `UPDATE web_push_outbox
       SET status='pending',processing_started_at=NULL,updated_at=now()
       WHERE status='processing' AND processing_started_at<now()-interval '10 minutes'
         AND web_push_recipient_active(tenant_id,user_id)
       RETURNING id,tenant_id`
    );
    const pending = await this.pool.query<{ id: string; tenant_id: string }>(
      `SELECT id,tenant_id FROM web_push_outbox
       WHERE status='pending' AND available_at<=now()
         AND web_push_effective_enabled(tenant_id)
         AND web_push_recipient_active(tenant_id,user_id)
       ORDER BY available_at,created_at,id LIMIT $1`,
      [limit]
    );
    const jobs = new Map<string, { tenantId: string; outboxId: string }>();
    for (const row of [...result.rows, ...pending.rows]) {
      jobs.set(`${row.tenant_id}:${row.id}`, { tenantId: row.tenant_id, outboxId: row.id });
    }
    return [...jobs.values()];
  }

  async enqueueDueAppointmentReminders(): Promise<number> {
    const decisions = await listAllTenantEffectiveFeatureFlags(this.pool);
    const appointmentTenants = Object.entries(decisions)
      .filter(([, flags]) => flags.appointments_v1 === true)
      .map(([tenantId]) => tenantId);
    if (appointmentTenants.length === 0) return 0;
    const result = await this.pool.query(
      `INSERT INTO web_push_outbox(
         tenant_id,user_id,event_type,urgency,target_path,resource_type,resource_id,dedupe_key
       )
       SELECT appointment.tenant_id,member.user_id,'appointment_reminder','high',
              '/agenda?appointment=' || appointment.id || '&unit=' || appointment.unit_id || '&date=' ||
                to_char(appointment.start_at AT TIME ZONE tenant.timezone,'YYYY-MM-DD'),
              'appointment',appointment.id,
              'appointment-reminder:' || appointment.id || ':' || extract(epoch FROM appointment.start_at)::bigint
       FROM scheduling_appointments appointment
       JOIN tenants tenant ON tenant.id=appointment.tenant_id
       JOIN workspace_members member
         ON member.workspace_id=appointment.tenant_id AND member.id=appointment.assigned_member_id AND member.status='active'
       LEFT JOIN panel_notification_preferences preference
         ON preference.tenant_id=appointment.tenant_id AND preference.user_id=member.user_id
       WHERE appointment.status IN ('confirmado','reagendado')
         AND appointment.tenant_id=ANY($1::uuid[])
         AND appointment.start_at>now() AND appointment.start_at<=now()+interval '15 minutes'
         AND web_push_effective_enabled(appointment.tenant_id)
         AND COALESCE(preference.web_push_enabled,true)
         AND COALESCE(preference.push_appointments,true)
       ON CONFLICT(tenant_id,user_id,dedupe_key) DO NOTHING`,
      [appointmentTenants]
    );
    return result.rowCount ?? 0;
  }
}

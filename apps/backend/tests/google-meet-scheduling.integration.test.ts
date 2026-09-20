import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { createSchedulingToolExecutor } from "../src/modules/ai-router/tool-executor.js";
import { GoogleMeetClient, GoogleMeetClientCache } from "../src/modules/scheduling/google-meet.js";
import { SchedulingNotificationRepository } from "../src/modules/scheduling/notification-repository.js";
import { connectGoogleMeetOAuth, createAppointment } from "../src/modules/scheduling/service.js";
import {
  MeetingProvisioningProcessor,
  MeetingProvisioningRepository
} from "../src/modules/scheduling/meeting-provisioning.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "meet-scheduling-password";
let tenantId = "";
let ownerMemberId = "";
let ownerUserId = "";
let ownerCookie = "";
let operatorCookie = "";
let operatorUserId = "";
let operatorMemberId = "";
const phone = `5511${Date.now().toString().slice(-8)}`;
const oauthEmail = "meet-owner@gmail.com";
const oauthRefreshToken = "google-oauth-refresh-token";

beforeAll(async () => {
  await app.ready();
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Meet Scheduling ${randomUUID()}`]
  );
  tenantId = tenant.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
     SELECT $1,flag_key,true FROM unnest($2::text[]) flag_key
     ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true`,
    [tenantId, ["workspace_admin_v1", "appointments_v1", "leads_v1", "dashboard_v1"]]
  );
  const passwordHash = await hash(password, 4);
  const ownerEmail = `meet-owner-${randomUUID()}@test.local`;
  const operatorEmail = `meet-operator-${randomUUID()}@test.local`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const owner = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id",
      [ownerEmail, passwordHash]
    );
    const operator = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [operatorEmail, passwordHash]
    );
    ownerUserId = owner.rows[0].id;
    operatorUserId = operator.rows[0].id;
    ownerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'
       RETURNING id`,
      [tenantId, ownerUserId]
    )).rows[0].id;
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, operatorUserId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await pool.query(
    `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
     VALUES($1,'reunioes','Reuniões comerciais','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
    [tenantId]
  );
  await pool.query(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
     VALUES($1,$2,'Marina Oliveira','reunioes','qualificado','whatsapp',4)`,
    [tenantId, phone]
  );

  const ownerLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: ownerEmail, password } });
  ownerCookie = (Array.isArray(ownerLogin.headers["set-cookie"])
    ? ownerLogin.headers["set-cookie"][0]
    : ownerLogin.headers["set-cookie"]!).split(";")[0];
  const operatorLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: operatorEmail, password } });
  operatorCookie = (Array.isArray(operatorLogin.headers["set-cookie"])
    ? operatorLogin.headers["set-cookie"][0]
    : operatorLogin.headers["set-cookie"]!).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[ownerUserId, operatorUserId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerUserId, operatorUserId]]);
  await app.close();
  await pool.end();
});

describe("Google Meet scheduling automation", () => {
  it("creates, persists, exposes and targets the same Meet link from the AI booking flow", async () => {
    const atendonMeetDefault = await app.inject({
      method: "GET",
      url: "/scheduling/config/atendon-meet",
      headers: { cookie: ownerCookie }
    });
    expect(atendonMeetDefault.statusCode).toBe(200);
    expect(atendonMeetDefault.json()).toEqual({ settings: { enabled: false, available: false } });
    const prematureEnable = await app.inject({
      method: "PUT",
      url: "/scheduling/config/atendon-meet",
      headers: { cookie: ownerCookie },
      payload: { enabled: true }
    });
    expect(prematureEnable.statusCode).toBe(409);
    expect(prematureEnable.json().error).toMatch(/infraestrutura.*não está disponível/i);
    const disabledPublicJoin = await app.inject({
      method: "GET",
      url: `/meet/join/${"a".repeat(32)}`
    });
    expect(disabledPublicJoin.statusCode).toBe(503);
    expect((await pool.query(
      "SELECT 1 FROM scheduling_atendon_meet_settings WHERE tenant_id=$1",
      [tenantId]
    )).rows).toHaveLength(0);

    const unavailable = await app.inject({
      method: "PUT",
      url: "/scheduling/config/google-meet",
      headers: { cookie: ownerCookie },
      payload: {
        enabled: true,
        closer_member_ids: [ownerMemberId]
      }
    });
    expect(unavailable.statusCode).toBe(409);

    const createSpace = vi.fn().mockResolvedValue({
      name: "spaces/atendon-meeting",
      meetingUri: "https://meet.google.com/atn-donx-link",
      meetingCode: "atn-donx-link"
    });
    const prepareCreateSpace = vi.spyOn(GoogleMeetClient.prototype, "prepareCreateSpace")
      .mockResolvedValue({ createSpace });
    try {
      expect((await app.inject({
        method: "PUT",
        url: "/scheduling/config/google-meet",
        headers: { cookie: operatorCookie },
        payload: { enabled: false, closer_member_ids: [] }
      })).statusCode).toBe(403);
      expect((await app.inject({
        url: "/scheduling/config/google-meet",
        headers: { cookie: operatorCookie }
      })).statusCode).toBe(200);

      await pool.query(
        `INSERT INTO scheduling_google_meet_settings(
           tenant_id,enabled,organizer_email,oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
         ) VALUES($1,false,$2,$2,$3,now())`,
        [tenantId, oauthEmail, encryptSecret(oauthRefreshToken, config.DATA_ENCRYPTION_KEY)]
      );

      const settings = await app.inject({
        method: "PUT",
        url: "/scheduling/config/google-meet",
        headers: { cookie: ownerCookie },
        payload: {
          enabled: true,
          closer_member_ids: [ownerMemberId]
        }
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().settings).toMatchObject({
        enabled: true,
        organizer_email: oauthEmail,
        creation_moment: "appointment_confirmed",
        closer_member_ids: [ownerMemberId],
        oauth_email: oauthEmail,
        oauth_connected: true
      });
      expect(settings.json().settings).not.toHaveProperty("oauth_refresh_token");
      const storedCredentials = await pool.query<{
        oauth_email: string;
        oauth_refresh_token_encrypted: string;
      }>(
        `SELECT oauth_email,oauth_refresh_token_encrypted
         FROM scheduling_google_meet_settings WHERE tenant_id=$1`,
        [tenantId]
      );
      expect(storedCredentials.rows[0].oauth_email).toBe(oauthEmail);
      expect(storedCredentials.rows[0].oauth_refresh_token_encrypted).not.toContain(oauthRefreshToken);

      const preserved = await app.inject({
        method: "PUT",
        url: "/scheduling/config/google-meet",
        headers: { cookie: ownerCookie },
        payload: {
          enabled: true,
          closer_member_ids: [ownerMemberId]
        }
      });
      expect(preserved.statusCode).toBe(200);
      expect(preserved.json().settings).toMatchObject({ oauth_connected: true, oauth_email: oauthEmail });
      expect((await pool.query<{ value: string }>(
        `SELECT oauth_refresh_token_encrypted value
         FROM scheduling_google_meet_settings WHERE tenant_id=$1`,
        [tenantId]
      )).rows[0].value).toBe(storedCredentials.rows[0].oauth_refresh_token_encrypted);
      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_logs
         WHERE workspace_id=$1 AND action='google_meet.settings.update'
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId]
      );
      expect(audit.rows[0].metadata).toMatchObject({ oauth_email: oauthEmail });
      expect(audit.rows[0].metadata).not.toHaveProperty("oauth_refresh_token");

      const onMeetingScheduled = vi.fn();
      const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
        conversationId: randomUUID(),
        inboundExternalId: `inbound-${randomUUID()}`,
        aiTurnId: randomUUID(),
        journal: async (_input, execute) => execute(),
        enabledToolNames: ["agendar_reuniao"],
        onMeetingScheduled
      });
      const result = JSON.parse(await executeTool(
        "agendar_reuniao",
        JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T09:00:00.000Z" }),
        { providerCallId: "tool-meet-1", ordinal: 0 }
      ));

      expect(prepareCreateSpace).not.toHaveBeenCalled();
      expect(createSpace).not.toHaveBeenCalled();
      expect(result.agendamento).toMatchObject({
        status: "confirmado",
        meeting_provisioning_status: "pending",
        meet_link: null,
        meet: null
      });
      expect(result).not.toHaveProperty("instrucao");
      expect(onMeetingScheduled).not.toHaveBeenCalled();

      const outbox = await pool.query<{ id: string }>(
        `SELECT id FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, result.agendamento.id]
      );
      const notificationSession = await pool.query<{ id: string }>(
        "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
        [tenantId]
      );
      const notificationRepository = new SchedulingNotificationRepository(pool);
      const notificationId = await notificationRepository.create({
        tenantId,
        appointmentId: result.agendamento.id,
        sessionId: notificationSession.rows[0].id,
        groupJid: "120363000000000000@g.us",
        message: "Novo agendamento ainda sem link"
      });
      expect(notificationId).toBeTruthy();
      await notificationRepository.markSent(notificationId!, "whatsapp-group-message-id");
      const provisioning = new MeetingProvisioningProcessor(
        new MeetingProvisioningRepository(pool),
        new GoogleMeetClientCache(),
        {
          DATA_ENCRYPTION_KEY: config.DATA_ENCRYPTION_KEY,
          DATA_ENCRYPTION_KEY_PREVIOUS: config.DATA_ENCRYPTION_KEY_PREVIOUS,
          JWT_SECRET: config.JWT_SECRET,
          GOOGLE_MEET_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_MEET_OAUTH_CLIENT_SECRET: "test-client-secret"
        },
        async () => undefined,
        async () => undefined
      );
      await expect(provisioning.process(outbox.rows[0].id)).resolves.toBe("ready");
      expect(prepareCreateSpace).toHaveBeenCalledTimes(1);
      expect(createSpace).toHaveBeenCalledTimes(1);

      const stored = await pool.query(
        `SELECT meeting_provider,meeting_space_name,meeting_code,meeting_url,meeting_created_at,
                meeting_provisioning_status
         FROM scheduling_appointments WHERE id=$1`,
        [result.agendamento.id]
      );
      expect(stored.rows[0]).toMatchObject({
        meeting_provider: "google_meet",
        meeting_provisioning_status: "ready",
        meeting_space_name: "spaces/atendon-meeting",
        meeting_code: "atn-donx-link",
        meeting_url: "https://meet.google.com/atn-donx-link"
      });
      expect(stored.rows[0].meeting_created_at).not.toBeNull();
      expect((await pool.query<{
        message: string;
        edit_status: string | null;
        message_revision: number;
      }>(
        `SELECT message,edit_status,message_revision
         FROM scheduling_appointment_notifications WHERE id=$1`,
        [notificationId]
      )).rows[0]).toMatchObject({
        message: expect.stringContaining("Link da reunião: https://meet.google.com/atn-donx-link"),
        edit_status: "pending",
        message_revision: 1
      });
      expect((await pool.query(
        "SELECT 1 FROM scheduling_atendon_meet_settings WHERE tenant_id=$1",
        [tenantId]
      )).rows).toHaveLength(0);

      const panelAgenda = await app.inject({
        url: "/scheduling/appointments?unidade_id=reunioes&inicio=2030-01-07&fim=2030-01-08",
        headers: { cookie: ownerCookie }
      });
      expect(panelAgenda.statusCode).toBe(200);
      expect(panelAgenda.json().agendamentos).toContainEqual(expect.objectContaining({
        id: result.agendamento.id,
        meet_link: "https://meet.google.com/atn-donx-link"
      }));

      const ownerAlerts = await app.inject({ url: "/alerts", headers: { cookie: ownerCookie } });
      const meetingAlert = ownerAlerts.json().alerts.find((alert: { kind: string }) => alert.kind === "meeting");
      expect(meetingAlert).toMatchObject({
        message: expect.stringContaining("Marina Oliveira"),
        kind: "meeting",
        metadata: {
          contact_name: "Marina Oliveira",
          contact_phone: phone,
          starts_at: "2030-01-07T09:00:00.000Z",
          timezone: "UTC",
          meet_url: "https://meet.google.com/atn-donx-link"
        }
      });
      expect(meetingAlert.message).toContain("07/01/2030");
      expect(meetingAlert.message).toContain("09:00");
      expect(meetingAlert.message).toContain("https://meet.google.com/atn-donx-link");

      const operatorAlerts = await app.inject({ url: "/alerts", headers: { cookie: operatorCookie } });
      expect(operatorAlerts.statusCode).toBe(403);
      expect((await app.inject({
        method: "PATCH",
        url: `/alerts/${meetingAlert.id}/read`,
        headers: { cookie: operatorCookie }
      })).statusCode).toBe(403);

      const recipients = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM system_alert_receipts WHERE alert_id=$1 ORDER BY user_id",
        [meetingAlert.id]
      );
      expect(recipients.rows).toEqual([{ user_id: ownerUserId }]);

      const moved = await app.inject({
        method: "PATCH",
        url: `/scheduling/appointments/${result.agendamento.id}/reagendar`,
        headers: { cookie: ownerCookie },
        payload: { start: "2030-01-07T10:00:00.000Z", unidade_id: "reunioes" }
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().agendamento).toMatchObject({
        status: "confirmado",
        meet_link: "https://meet.google.com/atn-donx-link"
      });

      const idempotentLead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         VALUES($1,$2,'Lead idempotente','reunioes','qualificado','saga-test') RETURNING id`,
        [tenantId, `5521${Date.now().toString().slice(-8)}`]
      );
      const failedEnqueue = vi.fn().mockRejectedValue(new Error("Redis unavailable"));
      const sameReservation = await Promise.all([
        createAppointment(tenantId, {
          lead_id: idempotentLead.rows[0].id,
          unidade_id: "reunioes",
          start: "2030-01-07T11:00:00.000Z",
          idempotency_key: "concurrent-reservation"
        }, { enqueueProvisioning: failedEnqueue }),
        createAppointment(tenantId, {
          lead_id: idempotentLead.rows[0].id,
          unidade_id: "reunioes",
          start: "2030-01-07T11:00:00.000Z",
          idempotency_key: "concurrent-reservation"
        }, { enqueueProvisioning: failedEnqueue })
      ]);
      expect(sameReservation[0].id).toBe(sameReservation[1].id);
      expect((await pool.query<{ count: number }>(
        `SELECT count(*)::int count FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, sameReservation[0].id]
      )).rows[0].count).toBe(1);
      const recoverable = await new MeetingProvisioningRepository(pool).findDuePage();
      expect(recoverable.ids).toContainEqual(expect.any(String));

      const slowLead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         VALUES($1,$2,'Lead lento','reunioes','qualificado','saga-test') RETURNING id`,
        [tenantId, `5531${Date.now().toString().slice(-8)}`]
      );
      const slowAppointment = await createAppointment(tenantId, {
        lead_id: slowLead.rows[0].id,
        unidade_id: "reunioes",
        start: "2030-01-07T12:00:00.000Z"
      }, { enqueueProvisioning: async () => undefined });
      const slowOutbox = await pool.query<{ id: string }>(
        `SELECT id FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, slowAppointment.id]
      );
      let resolveSlowCreate!: (space: {
        name: string;
        meetingUri: string;
        meetingCode: string;
      }) => void;
      const slowCreate = vi.fn(() => new Promise<{
        name: string;
        meetingUri: string;
        meetingCode: string;
      }>((resolve) => {
        resolveSlowCreate = resolve;
      }));
      prepareCreateSpace.mockResolvedValueOnce({ createSpace: slowCreate });
      const slowProcessing = provisioning.process(slowOutbox.rows[0].id);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await pool.query<{ attempted: boolean }>(
          `SELECT attempted_at IS NOT NULL attempted
           FROM scheduling_meeting_provisioning_outbox WHERE id=$1`,
          [slowOutbox.rows[0].id]
        );
        if (state.rows[0]?.attempted) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const lockProbe = await pool.connect();
      try {
        await lockProbe.query("BEGIN");
        await lockProbe.query("SET LOCAL lock_timeout='250ms'");
        await lockProbe.query(
          "SELECT id FROM scheduling_appointments WHERE id=$1 FOR UPDATE",
          [slowAppointment.id]
        );
        await lockProbe.query("COMMIT");
      } finally {
        lockProbe.release();
      }
      expect(slowCreate).toHaveBeenCalledTimes(1);
      resolveSlowCreate({
        name: "spaces/slow",
        meetingUri: "https://meet.google.com/slow-link-one",
        meetingCode: "slow-link-one"
      });
      await expect(slowProcessing).resolves.toBe("ready");

      const leaseLead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         VALUES($1,$2,'Lead lease','reunioes','qualificado','saga-test') RETURNING id`,
        [tenantId, `5541${Date.now().toString().slice(-8)}`]
      );
      const leaseAppointment = await createAppointment(tenantId, {
        lead_id: leaseLead.rows[0].id,
        unidade_id: "reunioes",
        start: "2030-01-07T13:00:00.000Z"
      }, { enqueueProvisioning: async () => undefined });
      const leaseOutbox = await pool.query<{ id: string }>(
        `SELECT id FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, leaseAppointment.id]
      );
      const shortLeaseRepository = new MeetingProvisioningRepository(pool, 1);
      expect(await shortLeaseRepository.claim(leaseOutbox.rows[0].id)).not.toBeNull();
      expect(await shortLeaseRepository.markAttemptStarted(leaseOutbox.rows[0].id)).toBe(true);
      await pool.query(
        `UPDATE scheduling_meeting_provisioning_outbox
         SET processing_started_at=now()-interval '1 minute' WHERE id=$1`,
        [leaseOutbox.rows[0].id]
      );
      expect(await shortLeaseRepository.claim(leaseOutbox.rows[0].id)).toBeNull();
      expect((await pool.query<{ status: string }>(
        "SELECT meeting_provisioning_status status FROM scheduling_appointments WHERE id=$1",
        [leaseAppointment.id]
      )).rows[0].status).toBe("uncertain");

      const suppressedLead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         VALUES($1,$2,'Lead cancelado','reunioes','qualificado','saga-test') RETURNING id`,
        [tenantId, `5551${Date.now().toString().slice(-8)}`]
      );
      const suppressedAppointment = await createAppointment(tenantId, {
        lead_id: suppressedLead.rows[0].id,
        unidade_id: "reunioes",
        start: "2030-01-07T14:00:00.000Z"
      }, { enqueueProvisioning: async () => undefined });
      const suppressedOutbox = await pool.query<{ id: string }>(
        `SELECT id FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, suppressedAppointment.id]
      );
      await pool.query(
        "UPDATE scheduling_appointments SET status='cancelado' WHERE tenant_id=$1 AND id=$2",
        [tenantId, suppressedAppointment.id]
      );
      const prepareCallsBeforeCancellation = prepareCreateSpace.mock.calls.length;
      await expect(provisioning.process(suppressedOutbox.rows[0].id)).resolves.toBe("skipped");
      expect(prepareCreateSpace).toHaveBeenCalledTimes(prepareCallsBeforeCancellation);
      expect((await pool.query<{ appointment_status: string; outbox_status: string }>(
        `SELECT appointment.meeting_provisioning_status appointment_status,
                outbox.status outbox_status
         FROM scheduling_appointments appointment
         JOIN scheduling_meeting_provisioning_outbox outbox
           ON outbox.appointment_id=appointment.id AND outbox.tenant_id=appointment.tenant_id
         WHERE appointment.id=$1`,
        [suppressedAppointment.id]
      )).rows[0]).toEqual({
        appointment_status: "not_required",
        outbox_status: "failed"
      });

      const disabledLead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         VALUES($1,$2,'Lead integração desligada','reunioes','qualificado','saga-test') RETURNING id`,
        [tenantId, `5561${Date.now().toString().slice(-8)}`]
      );
      const disabledAppointment = await createAppointment(tenantId, {
        lead_id: disabledLead.rows[0].id,
        unidade_id: "reunioes",
        start: "2030-01-07T15:00:00.000Z"
      }, { enqueueProvisioning: async () => undefined });
      const disabledOutbox = await pool.query<{ id: string }>(
        `SELECT id FROM scheduling_meeting_provisioning_outbox
         WHERE tenant_id=$1 AND appointment_id=$2`,
        [tenantId, disabledAppointment.id]
      );
      await pool.query(
        "UPDATE scheduling_google_meet_settings SET enabled=false WHERE tenant_id=$1",
        [tenantId]
      );
      const prepareCallsBeforeDisable = prepareCreateSpace.mock.calls.length;
      await expect(provisioning.process(disabledOutbox.rows[0].id)).resolves.toBe("skipped");
      expect(prepareCreateSpace).toHaveBeenCalledTimes(prepareCallsBeforeDisable);
      await pool.query(
        "UPDATE scheduling_google_meet_settings SET enabled=true WHERE tenant_id=$1",
        [tenantId]
      );

      await pool.query(
        `UPDATE scheduling_appointments SET status='cancelado'
         WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
        [tenantId, [
          sameReservation[0].id,
          slowAppointment.id,
          leaseAppointment.id,
          disabledAppointment.id
        ]]
      );

      const disconnected = await app.inject({
        method: "DELETE",
        url: "/scheduling/config/google-meet/oauth",
        headers: { cookie: ownerCookie }
      });
      expect(disconnected.statusCode).toBe(200);
      expect(disconnected.json().settings).toMatchObject({ enabled: false, oauth_connected: false, oauth_email: null });
      expect((await pool.query<{ value: string | null }>(
        "SELECT oauth_refresh_token_encrypted value FROM scheduling_google_meet_settings WHERE tenant_id=$1",
        [tenantId]
      )).rows[0].value).toBeNull();
    } finally {
      prepareCreateSpace.mockRestore();
    }
  });

  it("routes new meetings to the available attendant with the lighter agenda", async () => {
    const settings = await app.inject({
      method: "PUT",
      url: "/scheduling/config/google-meet",
      headers: { cookie: ownerCookie },
      payload: {
        enabled: false,
        closer_member_ids: [ownerMemberId, operatorMemberId]
      }
    });
    expect(settings.statusCode).toBe(200);
    await pool.query(
      "UPDATE scheduling_appointments SET status='cancelado' WHERE tenant_id=$1 AND status IN ('confirmado','reagendado')",
      [tenantId]
    );
    await pool.query(
      `UPDATE scheduling_google_meet_closers
       SET created_at=CASE member_id
         WHEN $2::uuid THEN '2026-01-01T00:00:00Z'::timestamptz
         ELSE '2026-01-02T00:00:00Z'::timestamptz
       END
       WHERE tenant_id=$1 AND member_id=ANY($3::uuid[])`,
      [tenantId, ownerMemberId, [ownerMemberId, operatorMemberId]]
    );
    await pool.query(
      `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
       VALUES($1,NULL)
       ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=NULL,updated_at=now()`,
      [tenantId]
    );

    // idx_appointments_one_active_per_lead permite um único compromisso ativo por lead,
    // então a carga por closer usa um lead sintético distinto para cada compromisso.
    await pool.query(
      `WITH load_leads AS (
         INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
         SELECT $1,'5598' || $3 || lpad(n::text,2,'0'),'Carga ' || n,'reunioes','qualificado','round-robin-load'
         FROM generate_series(1,8) n
         RETURNING id, phone
       )
       INSERT INTO scheduling_appointments(
         lead_id,tenant_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at
       )
       SELECT load_lead.id,$1,'reunioes',
              '2031-01-06T09:00:00.000Z'::timestamptz + (load_lead.n * interval '1 hour'),
              '2031-01-06T10:00:00.000Z'::timestamptz + (load_lead.n * interval '1 hour'),
              'confirmado',
              $2::uuid,
              now() - ((20 - load_lead.n) * interval '1 minute')
       FROM (SELECT id, right(phone,2)::int n FROM load_leads) load_lead`,
      [tenantId, ownerMemberId, Date.now().toString().slice(-6)]
    );

    const countsBefore = await pool.query<{ assigned_member_id: string; count: number }>(
      `SELECT assigned_member_id,count(*)::int count
       FROM scheduling_appointments
       WHERE tenant_id=$1 AND status IN ('confirmado','reagendado')
       GROUP BY assigned_member_id
       ORDER BY assigned_member_id`,
      [tenantId]
    );
    expect(Object.fromEntries(countsBefore.rows.map((row) => [row.assigned_member_id, row.count]))).toEqual({
      [ownerMemberId]: 8
    });

    const createLead = async (suffix: string) => {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,assigned_member_id)
         VALUES($1,$2,$3,'reunioes','qualificado','round-robin-test',$4) RETURNING id`,
        [tenantId, `5599${suffix}${Date.now().toString().slice(-6)}`, `Lead ${suffix}`, ownerMemberId]
      );
      return created.rows[0].id;
    };

    const firstLeadId = await createLead("41");
    const first = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: {
        lead_id: firstLeadId,
        unidade_id: "reunioes",
        start: "2030-01-09T09:00:00.000Z"
      }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().agendamento.responsavel).toMatchObject({
      member_id: operatorMemberId,
      user_id: operatorUserId
    });

    const secondLeadId = await createLead("42");
    const second = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: {
        lead_id: secondLeadId,
        unidade_id: "reunioes",
        start: "2030-01-09T10:00:00.000Z"
      }
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().agendamento.responsavel).toMatchObject({
      member_id: operatorMemberId,
      user_id: operatorUserId
    });

    const assignedLeads = await pool.query<{ id: string; assigned_member_id: string }>(
      "SELECT id,assigned_member_id FROM scheduling_leads WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[firstLeadId, secondLeadId]]
    );
    expect(new Set(assignedLeads.rows.map((row) => row.assigned_member_id))).toEqual(new Set([operatorMemberId]));

    const operatorDashboard = await app.inject({
      url: "/dashboard?period=custom&start=2030-01-09&end=2030-01-09",
      headers: { cookie: operatorCookie }
    });
    expect(operatorDashboard.statusCode).toBe(200);
    expect(operatorDashboard.json().commercial).toMatchObject({
      scope: {
        type: "mine",
        member_id: operatorMemberId,
        is_closer: true
      },
      period: {
        key: "custom",
        start: "2030-01-09",
        end: "2030-01-09",
        timezone: "UTC"
      },
      metrics: {
        scheduled: 2
      }
    });
    expect(operatorDashboard.json().commercial.series).toEqual([
      expect.objectContaining({ day: "2030-01-09", scheduled: 2 })
    ]);
    expect(operatorDashboard.json().commercial.team).toEqual([
      expect.objectContaining({
        member_id: operatorMemberId,
        user_id: operatorUserId,
        is_current: true
      })
    ]);
    const operatorAgenda = await app.inject({
      url: "/scheduling/appointments?unidade_id=reunioes&inicio=2030-01-09&fim=2030-01-10",
      headers: { cookie: operatorCookie }
    });
    expect(operatorAgenda.statusCode).toBe(200);
    expect(new Set(operatorAgenda.json().agendamentos.map((item: { id: string }) => item.id))).toEqual(
      new Set([first.json().agendamento.id, second.json().agendamento.id])
    );

    const balancingLeadId = await createLead("43");
    const balancing = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: {
        lead_id: balancingLeadId,
        unidade_id: "reunioes",
        start: "2030-01-09T11:00:00.000Z"
      }
    });
    expect(balancing.statusCode).toBe(201);
    expect(balancing.json().agendamento.responsavel.member_id).toBe(operatorMemberId);

    const concurrentLeadIds = await Promise.all([createLead("44"), createLead("45")]);
    const concurrent = await Promise.all(concurrentLeadIds.map((leadId, index) => app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: {
        lead_id: leadId,
        unidade_id: "reunioes",
        start: `2030-01-09T${12 + index}:00:00.000Z`
      }
    })));
    expect(concurrent.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(new Set(concurrent.map((response) => response.json().agendamento.responsavel.member_id))).toEqual(
      new Set([operatorMemberId])
    );
  });

  it("reconnecting the Google OAuth account requeues stuck failed/uncertain meetings instead of leaving them stranded", async () => {
    await pool.query(
      `INSERT INTO scheduling_google_meet_settings(
         tenant_id,enabled,organizer_email,oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
       ) VALUES($1,true,$2,$2,$3,now())
       ON CONFLICT(tenant_id) DO UPDATE SET
         enabled=true,organizer_email=EXCLUDED.organizer_email,oauth_email=EXCLUDED.oauth_email,
         oauth_refresh_token_encrypted=EXCLUDED.oauth_refresh_token_encrypted,oauth_connected_at=now()`,
      [tenantId, oauthEmail, encryptSecret(oauthRefreshToken, config.DATA_ENCRYPTION_KEY)]
    );

    const reconcileLead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
       VALUES($1,$2,'Lead reconciliação','reunioes','qualificado','saga-test') RETURNING id`,
      [tenantId, `5571${Date.now().toString().slice(-8)}`]
    );
    const reconcileAppointment = await createAppointment(tenantId, {
      lead_id: reconcileLead.rows[0].id,
      unidade_id: "reunioes",
      start: "2030-01-07T16:00:00.000Z"
    }, { enqueueProvisioning: async () => undefined });
    const reconcileOutbox = await pool.query<{ id: string }>(
      `SELECT id FROM scheduling_meeting_provisioning_outbox
       WHERE tenant_id=$1 AND appointment_id=$2`,
      [tenantId, reconcileAppointment.id]
    );
    await pool.query(
      `UPDATE scheduling_meeting_provisioning_outbox
       SET status='failed',attempt_count=5,last_error='O Google recusou a renovação do acesso ao Meet (HTTP 400)'
       WHERE id=$1`,
      [reconcileOutbox.rows[0].id]
    );
    await pool.query(
      `UPDATE scheduling_appointments
       SET meeting_provisioning_status='failed',meeting_provisioning_error='O Google recusou a renovação do acesso ao Meet (HTTP 400)'
       WHERE id=$1`,
      [reconcileAppointment.id]
    );

    await connectGoogleMeetOAuth(
      tenantId,
      { email: oauthEmail, refreshToken: "fresh-refresh-token-after-reconnect" },
      { userId: ownerUserId, actorScope: "workspace" }
    );

    const reconciled = await pool.query<{ status: string; attempt_count: number; last_error: string | null }>(
      `SELECT status,attempt_count,last_error FROM scheduling_meeting_provisioning_outbox WHERE id=$1`,
      [reconcileOutbox.rows[0].id]
    );
    expect(reconciled.rows[0]).toMatchObject({ status: "pending", attempt_count: 0, last_error: null });

    const reconciledAppointment = await pool.query<{
      meeting_provisioning_status: string;
      meeting_provisioning_error: string | null;
    }>(
      `SELECT meeting_provisioning_status,meeting_provisioning_error
       FROM scheduling_appointments WHERE id=$1`,
      [reconcileAppointment.id]
    );
    expect(reconciledAppointment.rows[0]).toMatchObject({
      meeting_provisioning_status: "pending",
      meeting_provisioning_error: null
    });
  });
});

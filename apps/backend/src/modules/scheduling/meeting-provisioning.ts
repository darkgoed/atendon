import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { enqueueMeetingContactDelivery } from "../../queue/meeting-contact-delivery-queue.js";
import { decryptSecret } from "../ai-router/secret-box.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import {
  GoogleMeetApiError,
  GoogleMeetClientCache,
  GoogleMeetConfigurationError,
  type GoogleMeetSpace
} from "./google-meet.js";
import {
  refreshAppointmentGroupNotification,
  scheduleAppointmentGroupNotificationRefresh
} from "./notification-repository.js";
import { insertNewMeetingAlert, insertUnassignedAppointmentAlert } from "./service.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_SAFE_ATTEMPTS = 5;

type ProvisioningStatus = "pending" | "processing" | "ready" | "failed" | "uncertain";

type ClaimedProvisioning = {
  id: string;
  tenantId: string;
  appointmentId: string;
  attemptCount: number;
  encryptedRefreshToken: string | null;
};

export type MeetingProvisioningPage = {
  ids: string[];
  nextCursor: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

export async function lateMeetingDeliveryEnabled(client: PoolClient, tenantId: string): Promise<boolean> {
  await client.query("SAVEPOINT scheduling_meet_outbox_flag");
  try {
    const enabled = await isFeatureFlagEnabled(client, tenantId, "scheduling_meet_outbox_v2");
    await client.query("RELEASE SAVEPOINT scheduling_meet_outbox_flag");
    return enabled;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT scheduling_meet_outbox_flag");
    await client.query("RELEASE SAVEPOINT scheduling_meet_outbox_flag");
    logger.warn(
      { err: error, tenantId },
      "Scheduling Meet outbox flag unavailable; late contact delivery remains disabled"
    );
    return false;
  }
}

function lateMeetingDeliveryText(input: {
  start: Date;
  timezone: string;
  meetUrl: string;
}): string {
  const startsAt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: input.timezone,
    dateStyle: "short",
    timeStyle: "short",
    hour12: false
  }).format(input.start);
  return `O link da sua reunião de ${startsAt} está pronto: ${input.meetUrl}`;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class MeetingProvisioningRepository {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly maxSafeAttempts = DEFAULT_MAX_SAFE_ATTEMPTS
  ) {}

  private async markTerminal(
    client: PoolClient,
    row: { id: string; tenant_id: string; appointment_id: string },
    status: Extract<ProvisioningStatus, "failed" | "uncertain">,
    message: string
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE scheduling_meeting_provisioning_outbox
       SET status=$2,last_error=$3,completed_at=now(),processing_started_at=NULL,updated_at=now()
       WHERE id=$1 AND status NOT IN ('ready','failed','uncertain')
       RETURNING id`,
      [row.id, status, message]
    );
    if (!updated.rows[0]) return;
    await client.query(
      `UPDATE scheduling_appointments
       SET meeting_provisioning_status=$3,meeting_provisioning_error=$4,updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [row.appointment_id, row.tenant_id, status, message]
    );
    await client.query(
      `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
       VALUES($1,$2,'operational','workspace',$3)`,
      [
        row.tenant_id,
        status === "uncertain"
          ? "Não foi possível confirmar se o Google Meet criou a reunião. Não tente novamente antes de reconciliar no Google."
          : "Não foi possível criar o Google Meet da reunião reservada. Reconecte a conta e reconcilie o agendamento.",
        {
          event: `meeting_provisioning_${status}`,
          appointment_id: row.appointment_id,
          outbox_id: row.id,
          error: message
        }
      ]
    );
  }

  private async suppressBeforeAttempt(
    client: PoolClient,
    row: { id: string; tenant_id: string; appointment_id: string },
    message: string
  ): Promise<void> {
    await client.query(
      `UPDATE scheduling_meeting_provisioning_outbox
       SET status='failed',last_error=$2,completed_at=now(),
           processing_started_at=NULL,updated_at=now()
       WHERE id=$1 AND status IN ('pending','processing') AND attempted_at IS NULL`,
      [row.id, message]
    );
    await client.query(
      `UPDATE scheduling_appointments
       SET meeting_provisioning_status='not_required',
           meeting_provisioning_error=NULL,updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [row.appointment_id, row.tenant_id]
    );
  }

  async claim(outboxId: string): Promise<ClaimedProvisioning | null> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string;
        tenant_id: string;
        appointment_id: string;
        status: ProvisioningStatus;
        attempt_count: number;
        attempted_at: Date | null;
        processing_started_at: Date | null;
        oauth_refresh_token_encrypted: string | null;
        appointment_status: string;
        settings_enabled: boolean | null;
      }>(
        `SELECT outbox.id,outbox.tenant_id,outbox.appointment_id,outbox.status,
                outbox.attempt_count,outbox.attempted_at,outbox.processing_started_at,
                settings.oauth_refresh_token_encrypted,settings.enabled settings_enabled,
                appointment.status appointment_status
         FROM scheduling_meeting_provisioning_outbox outbox
         JOIN scheduling_appointments appointment
           ON appointment.id=outbox.appointment_id AND appointment.tenant_id=outbox.tenant_id
         LEFT JOIN scheduling_google_meet_settings settings
           ON settings.tenant_id=outbox.tenant_id
         WHERE outbox.id=$1
         FOR UPDATE OF outbox SKIP LOCKED`,
        [outboxId]
      );
      const row = selected.rows[0];
      if (!row || ["ready", "failed", "uncertain"].includes(row.status)) return null;
      if (
        !["confirmado", "reagendado"].includes(row.appointment_status)
        || row.settings_enabled !== true
      ) {
        await this.suppressBeforeAttempt(
          client,
          row,
          row.settings_enabled !== true
            ? "Provisionamento dispensado porque a integração Google Meet está desativada"
            : `Provisionamento dispensado para agendamento com status ${row.appointment_status}`
        );
        return null;
      }
      const leaseExpired = row.status === "processing"
        && (
          row.processing_started_at === null
          || row.processing_started_at.getTime() <= Date.now() - this.leaseMs
        );
      if (row.status === "processing" && !leaseExpired) return null;
      if (row.status === "pending") {
        const due = await client.query<{ due: boolean }>(
          "SELECT available_at <= now() due FROM scheduling_meeting_provisioning_outbox WHERE id=$1",
          [row.id]
        );
        if (!due.rows[0]?.due) return null;
      }
      if (row.attempted_at) {
        await this.markTerminal(
          client,
          row,
          "uncertain",
          "Lease expirou depois de spaces.create ter sido iniciado; repetição automática bloqueada"
        );
        return null;
      }
      const claimed = await client.query<{ attempt_count: number }>(
        `UPDATE scheduling_meeting_provisioning_outbox
         SET status='processing',attempt_count=attempt_count+1,
             processing_started_at=now(),updated_at=now()
         WHERE id=$1
         RETURNING attempt_count`,
        [row.id]
      );
      await client.query(
        `UPDATE scheduling_appointments
         SET meeting_provisioning_status='processing',meeting_provisioning_error=NULL,updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [row.appointment_id, row.tenant_id]
      );
      return {
        id: row.id,
        tenantId: row.tenant_id,
        appointmentId: row.appointment_id,
        attemptCount: claimed.rows[0].attempt_count,
        encryptedRefreshToken: row.oauth_refresh_token_encrypted
      };
    });
  }

  async markAttemptStarted(outboxId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE scheduling_meeting_provisioning_outbox
         SET attempted_at=now(),updated_at=now()
         WHERE id=$1 AND status='processing' AND attempted_at IS NULL
         RETURNING id`,
        [outboxId]
      );
      return Boolean(updated.rows[0]);
    });
  }

  async recordSafeFailure(claimed: ClaimedProvisioning, error: unknown): Promise<"pending" | "failed"> {
    const message = errorMessage(error);
    return transaction(this.pool, async (client) => {
      const current = await client.query<{
        id: string;
        tenant_id: string;
        appointment_id: string;
        status: ProvisioningStatus;
        attempted_at: Date | null;
      }>(
        `SELECT id,tenant_id,appointment_id,status,attempted_at
         FROM scheduling_meeting_provisioning_outbox WHERE id=$1 FOR UPDATE`,
        [claimed.id]
      );
      const row = current.rows[0];
      if (!row || row.status !== "processing") return row?.status === "failed" ? "failed" : "pending";
      if (row.attempted_at) {
        await this.markTerminal(client, row, "uncertain", message);
        return "failed";
      }
      if (claimed.attemptCount >= this.maxSafeAttempts) {
        await this.markTerminal(client, row, "failed", message);
        return "failed";
      }
      const backoffMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, claimed.attemptCount - 1));
      await client.query(
        `UPDATE scheduling_meeting_provisioning_outbox
         SET status='pending',available_at=now()+($2::bigint * interval '1 millisecond'),
             processing_started_at=NULL,last_error=$3,updated_at=now()
         WHERE id=$1`,
        [claimed.id, backoffMs, message]
      );
      await client.query(
        `UPDATE scheduling_appointments
         SET meeting_provisioning_status='pending',meeting_provisioning_error=$3,updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [claimed.appointmentId, claimed.tenantId, message]
      );
      return "pending";
    });
  }

  async markFailed(claimed: ClaimedProvisioning, error: unknown): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.markTerminal(client, {
        id: claimed.id,
        tenant_id: claimed.tenantId,
        appointment_id: claimed.appointmentId
      }, "failed", errorMessage(error));
    });
  }

  async markUncertain(claimed: ClaimedProvisioning, error: unknown): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.markTerminal(client, {
        id: claimed.id,
        tenant_id: claimed.tenantId,
        appointment_id: claimed.appointmentId
      }, "uncertain", errorMessage(error));
    });
  }

  async markReady(claimed: ClaimedProvisioning, space: GoogleMeetSpace): Promise<string | null> {
    return transaction(this.pool, async (client) => {
      const details = await client.query<{
        id: string;
        tenant_id: string;
        appointment_id: string;
        lead_id: string;
        unit_id: string;
        start_at: Date;
        end_at: Date;
        assigned_member_id: string | null;
        lead_name: string | null;
        lead_phone: string;
        unit_name: string;
        timezone: string;
        attendant_user_id: string | null;
        appointment_status: string;
        settings_enabled: boolean | null;
      }>(
        `SELECT outbox.id,outbox.tenant_id,outbox.appointment_id,
                appointment.lead_id,appointment.unit_id,appointment.start_at,appointment.end_at,
                appointment.status appointment_status,settings.enabled settings_enabled,
                appointment.assigned_member_id,lead.name lead_name,lead.phone lead_phone,
                unit.name unit_name,tenant.timezone,member.user_id attendant_user_id
         FROM scheduling_meeting_provisioning_outbox outbox
         JOIN scheduling_appointments appointment
           ON appointment.id=outbox.appointment_id AND appointment.tenant_id=outbox.tenant_id
         JOIN scheduling_leads lead
           ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id AND lead.deleted_at IS NULL
         JOIN scheduling_units unit
           ON unit.id=appointment.unit_id AND unit.tenant_id=appointment.tenant_id
         JOIN tenants tenant ON tenant.id=appointment.tenant_id
         LEFT JOIN scheduling_google_meet_settings settings
           ON settings.tenant_id=appointment.tenant_id
         LEFT JOIN workspace_members member
           ON member.id=appointment.assigned_member_id AND member.workspace_id=appointment.tenant_id
         WHERE outbox.id=$1
         FOR UPDATE OF outbox,appointment`,
        [claimed.id]
      );
      const row = details.rows[0];
      if (!row) return null;
      if (
        !["confirmado", "reagendado"].includes(row.appointment_status)
        || row.settings_enabled !== true
      ) {
        await this.markTerminal(
          client,
          row,
          "uncertain",
          row.settings_enabled !== true
            ? "A integração Google Meet foi desativada depois do início de spaces.create; reconciliação manual necessária"
            : `O agendamento mudou para ${row.appointment_status} depois do início de spaces.create; reconciliação manual necessária`
        );
        return null;
      }
      const completed = await client.query(
        `UPDATE scheduling_meeting_provisioning_outbox
         SET status='ready',completed_at=now(),processing_started_at=NULL,last_error=NULL,updated_at=now()
         WHERE id=$1 AND status='processing' AND attempted_at IS NOT NULL
         RETURNING id`,
        [claimed.id]
      );
      if (!completed.rows[0]) return null;
      await client.query(
        `UPDATE scheduling_appointments
         SET meeting_provider='google_meet',meeting_space_name=$3,meeting_code=$4,
             meeting_url=$5,meeting_created_at=now(),meeting_provisioning_status='ready',
             meeting_provisioning_error=NULL,updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [row.appointment_id, row.tenant_id, space.name, space.meetingCode, space.meetingUri]
      );
      await scheduleAppointmentGroupNotificationRefresh(
        client,
        row.tenant_id,
        row.appointment_id
      );
      await client.query(
        `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
         VALUES($1,$2,'google_meet_provisionado',$3)`,
        [row.lead_id, row.tenant_id, {
          appointment_id: row.appointment_id,
          meeting_space_name: space.name,
          meet_link: space.meetingUri
        }]
      );
      const alert = {
        tenantId: row.tenant_id,
        appointmentId: row.appointment_id,
        leadId: row.lead_id,
        contactName: row.lead_name,
        contactPhone: row.lead_phone,
        unitId: row.unit_id,
        unitName: row.unit_name,
        start: new Date(row.start_at),
        end: new Date(row.end_at),
        timezone: row.timezone,
        meetLink: space.meetingUri
      };
      if (row.assigned_member_id && row.attendant_user_id) {
        await insertNewMeetingAlert(client, {
          ...alert,
          assignedMemberId: row.assigned_member_id,
          attendantUserId: row.attendant_user_id
        });
      } else {
        await insertUnassignedAppointmentAlert(client, alert);
      }
      if (!await lateMeetingDeliveryEnabled(client, row.tenant_id)) return null;
      const delivery = await client.query<{ id: string }>(
        `INSERT INTO scheduling_meeting_contact_delivery_outbox(
           tenant_id,appointment_id,conversation_id,session_id,
           contact_phone,contact_jid,meet_url,message_text,available_at
         )
         SELECT $1,$2,conversation.id,conversation.session_id,
                conversation.contact_phone,conversation.contact_jid,$3,$4,
                now()+interval '5 seconds'
         FROM conversations conversation
         WHERE conversation.tenant_id=$1
           AND conversation.contact_phone=$5
           AND conversation.session_id IS NOT NULL
         ORDER BY conversation.last_message_at DESC,conversation.id DESC
         LIMIT 1
         ON CONFLICT(tenant_id,appointment_id) DO UPDATE
           SET updated_at=scheduling_meeting_contact_delivery_outbox.updated_at
         RETURNING id`,
        [
          row.tenant_id,
          row.appointment_id,
          space.meetingUri,
          lateMeetingDeliveryText({
            start: new Date(row.start_at),
            timezone: row.timezone,
            meetUrl: space.meetingUri
          }),
          row.lead_phone
        ]
      );
      return delivery.rows[0]?.id ?? null;
    });
  }

  async findDuePage(limit = 100, afterId?: string): Promise<MeetingProvisioningPage> {
    return transaction(this.pool, async (client) => {
      const rows = await client.query<{ id: string }>(
        `SELECT id
         FROM scheduling_meeting_provisioning_outbox
         WHERE (
           (status='pending' AND available_at <= now())
           OR
           (status='processing'
             AND COALESCE(processing_started_at,'-infinity'::timestamptz)
                 <= now()-($2::bigint * interval '1 millisecond'))
         )
         AND ($3::uuid IS NULL OR id > $3)
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit, this.leaseMs, afterId ?? null]
      );
      const ids = rows.rows.map((row) => row.id);
      return { ids, nextCursor: ids.length === limit ? ids.at(-1)! : null };
    });
  }
}

type ProvisioningRuntimeConfig = Pick<AppConfig,
  | "DATA_ENCRYPTION_KEY"
  | "DATA_ENCRYPTION_KEY_PREVIOUS"
  | "JWT_SECRET"
  | "GOOGLE_MEET_OAUTH_CLIENT_ID"
  | "GOOGLE_MEET_OAUTH_CLIENT_SECRET"
>;

export class MeetingProvisioningProcessor {
  constructor(
    private readonly repository: MeetingProvisioningRepository,
    private readonly clientCache: GoogleMeetClientCache,
    private readonly cfg: ProvisioningRuntimeConfig = config,
    private readonly enqueueContactDelivery: (outboxId: string) => Promise<void> = enqueueMeetingContactDelivery,
    private readonly refreshAppointmentNotification: (
      tenantId: string,
      appointmentId: string
    ) => Promise<void> = refreshAppointmentGroupNotification
  ) {}

  async process(outboxId: string): Promise<"skipped" | "pending" | "ready" | "failed" | "uncertain"> {
    const claimed = await this.repository.claim(outboxId);
    if (!claimed) return "skipped";
    if (!claimed.encryptedRefreshToken
      || !this.cfg.GOOGLE_MEET_OAUTH_CLIENT_ID
      || !this.cfg.GOOGLE_MEET_OAUTH_CLIENT_SECRET) {
      await this.repository.markFailed(claimed, new GoogleMeetConfigurationError());
      return "failed";
    }

    let refreshToken: string;
    try {
      refreshToken = decryptSecret(claimed.encryptedRefreshToken, {
        current: this.cfg.DATA_ENCRYPTION_KEY,
        previous: this.cfg.DATA_ENCRYPTION_KEY_PREVIOUS ? [this.cfg.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
        legacy: [this.cfg.JWT_SECRET]
      });
    } catch {
      await this.repository.markFailed(claimed, new GoogleMeetConfigurationError(
        "A conexão OAuth do Google Meet não pôde ser aberta"
      ));
      return "failed";
    }

    const meet = this.clientCache.get(claimed.tenantId, {
      oauthClientId: this.cfg.GOOGLE_MEET_OAUTH_CLIENT_ID,
      oauthClientSecret: this.cfg.GOOGLE_MEET_OAUTH_CLIENT_SECRET,
      refreshToken
    });
    let prepared: Awaited<ReturnType<typeof meet.prepareCreateSpace>>;
    try {
      prepared = await meet.prepareCreateSpace();
    } catch (error) {
      if (error instanceof GoogleMeetConfigurationError) {
        await this.repository.markFailed(claimed, error);
        return "failed";
      }
      return this.repository.recordSafeFailure(claimed, error);
    }

    if (!await this.repository.markAttemptStarted(claimed.id)) return "skipped";
    let space: GoogleMeetSpace;
    try {
      space = await prepared.createSpace();
    } catch (error) {
      if (error instanceof GoogleMeetApiError && error.outcome === "failed") {
        await this.repository.markFailed(claimed, error);
        return "failed";
      }
      await this.repository.markUncertain(claimed, error);
      return "uncertain";
    }
    const deliveryOutboxId = await this.repository.markReady(claimed, space);
    try {
      await this.refreshAppointmentNotification(claimed.tenantId, claimed.appointmentId);
    } catch (error) {
      logger.warn(
        { err: error, tenantId: claimed.tenantId, appointmentId: claimed.appointmentId },
        "Scheduling group notification refresh failed; database reconciler will retry"
      );
    }
    if (deliveryOutboxId) {
      try {
        await this.enqueueContactDelivery(deliveryOutboxId);
      } catch (error) {
        logger.warn(
          { err: error, tenantId: claimed.tenantId, outboxId: deliveryOutboxId },
          "Late Meeting link enqueue failed; database reconciler will retry"
        );
      }
    }
    return "ready";
  }
}

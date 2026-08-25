import type { Pool, PoolClient } from "pg";
import type { MessageGateway } from "../messages/types.js";

const DEFAULT_LEASE_MS = 60_000;

type DeliveryStatus = "pending" | "processing" | "sent" | "suppressed" | "failed" | "uncertain";
export type MeetingContactDeliveryClaimDecision = "claim" | "skip" | "uncertain";

export function decideMeetingContactDeliveryClaim(input: {
  status: DeliveryStatus;
  attemptedAt: Date | null;
  processingStartedAt: Date | null;
  available: boolean;
  turnInProgress: boolean;
  leaseMs: number;
  nowMs?: number;
}): MeetingContactDeliveryClaimDecision {
  if (["sent", "suppressed", "failed", "uncertain"].includes(input.status)) return "skip";
  const leaseExpired = input.status === "processing"
    && (
      input.processingStartedAt === null
      || input.processingStartedAt.getTime() <= (input.nowMs ?? Date.now()) - input.leaseMs
  );
  if (input.status === "processing" && !leaseExpired) return "skip";
  if (input.status === "pending" && !input.available) return "skip";
  if (leaseExpired && input.attemptedAt) return "uncertain";
  // The normal AI turn owns the first delivery attempt. Waiting while its
  // inbound lease is fresh closes the race between Evolution accepting the
  // normal reply and recordAgentReply suppressing this durable fallback.
  if (input.turnInProgress) return "skip";
  return "claim";
}

export interface ClaimedMeetingContactDelivery {
  id: string;
  tenantId: string;
  appointmentId: string;
  conversationId: string;
  sessionId: string;
  destination: string;
  messageText: string;
}

export interface MeetingContactDeliveryPage {
  ids: string[];
  nextCursor: string | null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
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

export class MeetingContactDeliveryRepository {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = DEFAULT_LEASE_MS
  ) {}

  private async markTerminal(
    client: PoolClient,
    row: { id: string; tenant_id: string; appointment_id: string },
    status: Extract<DeliveryStatus, "failed" | "uncertain">,
    message: string
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE scheduling_meeting_contact_delivery_outbox
       SET status=$2,last_error=$3,completed_at=now(),processing_started_at=NULL,updated_at=now()
       WHERE id=$1 AND tenant_id=$4 AND status NOT IN ('sent','failed','uncertain')
       RETURNING id`,
      [row.id, status, message, row.tenant_id]
    );
    if (!updated.rows[0]) return;
    await client.query(
      `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
       VALUES($1,$2,'operational','workspace',$3)`,
      [
        row.tenant_id,
        status === "uncertain"
          ? "O envio tardio do link Google Meet ficou incerto e não será repetido automaticamente."
          : "Não foi possível entregar o link Google Meet ao contato.",
        {
          event: `meeting_contact_delivery_${status}`,
          appointment_id: row.appointment_id,
          outbox_id: row.id,
          error: message
        }
      ]
    );
  }

  async claim(outboxId: string): Promise<ClaimedMeetingContactDelivery | null> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string;
        tenant_id: string;
        appointment_id: string;
        conversation_id: string;
        session_id: string;
        contact_phone: string;
        contact_jid: string | null;
        message_text: string;
        status: DeliveryStatus;
        attempted_at: Date | null;
        processing_started_at: Date | null;
        available: boolean;
        turn_in_progress: boolean;
      }>(
        `SELECT outbox.id,outbox.tenant_id,outbox.appointment_id,
                outbox.conversation_id,outbox.session_id,outbox.contact_phone,
                outbox.contact_jid,outbox.message_text,outbox.status,
                outbox.attempted_at,outbox.processing_started_at,
                outbox.available_at <= now() available,
                EXISTS (
                  SELECT 1 FROM messages inbound
                  WHERE inbound.conversation_id=outbox.conversation_id
                    AND inbound.sender='contact'
                    AND inbound.processed_at IS NULL
                    AND inbound.processing_started_at >= now()-interval '10 minutes'
                ) turn_in_progress
         FROM scheduling_meeting_contact_delivery_outbox outbox
         WHERE outbox.id=$1
         FOR UPDATE OF outbox SKIP LOCKED`,
        [outboxId]
      );
      const row = selected.rows[0];
      if (!row) return null;
      const decision = decideMeetingContactDeliveryClaim({
        status: row.status,
        attemptedAt: row.attempted_at,
        processingStartedAt: row.processing_started_at,
        available: row.available,
        turnInProgress: row.turn_in_progress,
        leaseMs: this.leaseMs
      });
      if (decision === "skip") return null;
      if (decision === "uncertain") {
        await this.markTerminal(
          client,
          row,
          "uncertain",
          "Lease expirou depois de o envio externo ter sido iniciado; repetição automática bloqueada"
        );
        return null;
      }
      const claimed = await client.query(
        `UPDATE scheduling_meeting_contact_delivery_outbox
         SET status='processing',attempt_count=attempt_count+1,
             processing_started_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2
         RETURNING id`,
        [row.id, row.tenant_id]
      );
      if (!claimed.rows[0]) return null;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        appointmentId: row.appointment_id,
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        destination: row.contact_jid ?? row.contact_phone,
        messageText: row.message_text
      };
    });
  }

  async markAttemptStarted(delivery: ClaimedMeetingContactDelivery): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE scheduling_meeting_contact_delivery_outbox
         SET attempted_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND appointment_id=$3
           AND status='processing' AND attempted_at IS NULL
         RETURNING id`,
        [delivery.id, delivery.tenantId, delivery.appointmentId]
      );
      return Boolean(updated.rows[0]);
    });
  }

  async markSent(delivery: ClaimedMeetingContactDelivery, externalMessageId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const completed = await client.query<{ message_text: string }>(
        `UPDATE scheduling_meeting_contact_delivery_outbox
         SET status='sent',external_message_id=$4,completed_at=now(),
             processing_started_at=NULL,last_error=NULL,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND appointment_id=$3
           AND status='processing' AND attempted_at IS NOT NULL
         RETURNING message_text`,
        [delivery.id, delivery.tenantId, delivery.appointmentId, externalMessageId]
      );
      if (!completed.rows[0]) return;
      const inserted = await client.query(
        `INSERT INTO messages(
           conversation_id,sender,content,external_message_id,provider_message_key,status
         )
         SELECT c.id,'agent',$4,$5,$6,'sent'
         FROM conversations c
         WHERE c.id=$1 AND c.tenant_id=$2 AND c.session_id=$3
         ON CONFLICT(provider_message_key) DO NOTHING
         RETURNING id`,
        [
          delivery.conversationId,
          delivery.tenantId,
          delivery.sessionId,
          completed.rows[0].message_text,
          externalMessageId,
          `${delivery.tenantId}:${delivery.sessionId}:${externalMessageId}`
        ]
      );
      if (!inserted.rows[0]) {
        const replay = await client.query(
          `SELECT 1 FROM messages m
           JOIN conversations c ON c.id=m.conversation_id
           WHERE m.provider_message_key=$1 AND c.tenant_id=$2 AND c.id=$3`,
          [
            `${delivery.tenantId}:${delivery.sessionId}:${externalMessageId}`,
            delivery.tenantId,
            delivery.conversationId
          ]
        );
        if (!replay.rows[0]) throw new Error("Conversa da entrega tardia não pertence ao tenant");
      }
    });
  }

  async markUncertain(delivery: ClaimedMeetingContactDelivery, error: unknown): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.markTerminal(client, {
        id: delivery.id,
        tenant_id: delivery.tenantId,
        appointment_id: delivery.appointmentId
      }, "uncertain", errorMessage(error));
    });
  }

  async findDuePage(limit = 100, afterId?: string): Promise<MeetingContactDeliveryPage> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id
         FROM scheduling_meeting_contact_delivery_outbox
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
      const ids = result.rows.map((row) => row.id);
      return { ids, nextCursor: ids.length === limit ? ids.at(-1)! : null };
    });
  }
}

export class MeetingContactDeliveryProcessor {
  constructor(
    private readonly repository: MeetingContactDeliveryRepository,
    private readonly gateway: Pick<MessageGateway, "sendText">
  ) {}

  async process(outboxId: string): Promise<"skipped" | "sent" | "uncertain"> {
    const delivery = await this.repository.claim(outboxId);
    if (!delivery) return "skipped";
    if (!await this.repository.markAttemptStarted(delivery)) return "skipped";
    try {
      const sent = await this.gateway.sendText(
        delivery.sessionId,
        delivery.destination,
        delivery.messageText
      );
      await this.repository.markSent(delivery, sent.externalId);
      return "sent";
    } catch (error) {
      // A network/provider error cannot prove that Evolution did not accept the
      // message. Prefer an explicit uncertain state over a duplicate link.
      await this.repository.markUncertain(delivery, error);
      return "uncertain";
    }
  }
}

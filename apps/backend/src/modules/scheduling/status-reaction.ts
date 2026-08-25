import type { Pool } from "pg";
import type { ReadReceipt } from "../messages/types.js";

const MAX_REACTION_ATTEMPTS = 8;

export const APPOINTMENT_STATUS_REACTIONS = {
  concluido: "✅",
  cancelado: "❌",
  no_show: "⚠️"
} as const;

export interface PendingAppointmentStatusReaction {
  id: string;
  sessionId: string;
  destination: string;
  receipt: ReadReceipt;
  emoji: string;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export class AppointmentStatusReactionRepository {
  constructor(private readonly db: Pool) {}

  async getPending(notificationId: string): Promise<PendingAppointmentStatusReaction | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      group_jid: string;
      external_message_id: string;
      reaction_emoji: string;
    }>(
      `SELECT id,session_id,group_jid,external_message_id,reaction_emoji
       FROM scheduling_appointment_notifications
       WHERE id=$1 AND status='sent' AND external_message_id IS NOT NULL
         AND reaction_status='pending' AND reaction_emoji IS NOT NULL`,
      [notificationId]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      sessionId: row.session_id,
      destination: row.group_jid,
      receipt: { id: row.external_message_id, remoteJid: row.group_jid, fromMe: true },
      emoji: row.reaction_emoji
    } : null;
  }

  async findPendingPage(limit = 100, afterId?: string): Promise<{ ids: string[]; nextCursor: string | null }> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
       FROM scheduling_appointment_notifications
       WHERE status='sent' AND external_message_id IS NOT NULL
         AND reaction_status='pending'
         AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id
       LIMIT $1`,
      [limit, afterId ?? null]
    );
    const ids = result.rows.map((row) => row.id);
    return { ids, nextCursor: ids.length === limit ? ids.at(-1)! : null };
  }

  async markSent(notificationId: string): Promise<void> {
    await this.db.query(
      `UPDATE scheduling_appointment_notifications
       SET reaction_status='sent',reacted_at=now(),reaction_last_error=NULL
       WHERE id=$1 AND reaction_status='pending'`,
      [notificationId]
    );
  }

  async recordFailure(notificationId: string, error: unknown): Promise<void> {
    await this.db.query(
      `UPDATE scheduling_appointment_notifications
       SET reaction_attempts=reaction_attempts+1,
           reaction_last_error=$2,
           reaction_status=CASE WHEN reaction_attempts+1 >= $3 THEN 'failed' ELSE 'pending' END
       WHERE id=$1 AND reaction_status='pending'`,
      [notificationId, errorMessage(error), MAX_REACTION_ATTEMPTS]
    );
  }
}

export class AppointmentStatusReactionProcessor {
  constructor(
    private readonly repository: AppointmentStatusReactionRepository,
    private readonly gateway: {
      sendReaction(sessionId: string, destination: string, receipt: ReadReceipt, emoji: string): Promise<void>;
    }
  ) {}

  async process(notificationId: string): Promise<"skipped" | "sent"> {
    const reaction = await this.repository.getPending(notificationId);
    if (!reaction) return "skipped";
    try {
      await this.gateway.sendReaction(
        reaction.sessionId,
        reaction.destination,
        reaction.receipt,
        reaction.emoji
      );
      await this.repository.markSent(reaction.id);
      return "sent";
    } catch (error) {
      await this.repository.recordFailure(reaction.id, error);
      throw error;
    }
  }
}

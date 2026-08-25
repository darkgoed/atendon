import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { markAppointmentResultPendingWithClient } from "./service.js";

export async function reconcilePendingMeetingResults(limit = 100): Promise<{
  scanned: number;
  marked: number;
  failed: number;
}> {
  const pageSize = Math.max(1,Math.min(limit,500));
  const client = await db.connect();
  let scanned=0;
  let marked=0;
  let failed=0;
  try {
    await client.query("BEGIN");
    const candidates = await client.query<{ id: string; tenant_id: string }>(
      `SELECT id,tenant_id
       FROM scheduling_appointments
       WHERE status IN ('confirmado','reagendado')
         AND end_at<=now() AND result_pending_at IS NULL
       ORDER BY end_at,id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [pageSize]
    );
    scanned=candidates.rows.length;
    for (const appointment of candidates.rows) {
      await client.query("SAVEPOINT pending_meeting_result");
      try {
        const result = await markAppointmentResultPendingWithClient(client,appointment.tenant_id,appointment.id);
        if (result.changed) marked+=1;
        await client.query("RELEASE SAVEPOINT pending_meeting_result");
      } catch (error) {
        failed+=1;
        await client.query("ROLLBACK TO SAVEPOINT pending_meeting_result");
        await client.query("RELEASE SAVEPOINT pending_meeting_result");
        logger.warn({ err: error,appointmentId: appointment.id,tenantId: appointment.tenant_id },"Could not mark appointment result pending");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { scanned,marked,failed };
}

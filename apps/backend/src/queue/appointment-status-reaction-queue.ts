import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface AppointmentStatusReactionJob {
  notificationId: string;
}

export const APPOINTMENT_STATUS_REACTION_QUEUE = "appointment-status-reactions";
export const appointmentStatusReactionQueue = new Queue<AppointmentStatusReactionJob>(
  APPOINTMENT_STATUS_REACTION_QUEUE,
  { connection: redisConnection }
);

export async function enqueueAppointmentStatusReaction(notificationId: string): Promise<void> {
  await appointmentStatusReactionQueue.add("react", { notificationId }, {
    jobId: `appointment_status_reaction_${notificationId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
    attempts: 8,
    backoff: { type: "exponential", delay: 2_000 },
    // A status change can happen while the original group notification is
    // still pending. A skipped job must release its id so the reconciler can
    // enqueue it again as soon as the provider message id is available.
    removeOnComplete: true,
    removeOnFail: 5_000
  });
}

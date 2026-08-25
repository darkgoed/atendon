import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const MEETING_CONTACT_DELIVERY_QUEUE = "meeting-contact-delivery";

export interface MeetingContactDeliveryJob {
  outboxId: string;
}

export const meetingContactDeliveryQueue = new Queue<MeetingContactDeliveryJob>(
  MEETING_CONTACT_DELIVERY_QUEUE,
  { connection: redisConnection }
);

export async function enqueueMeetingContactDelivery(outboxId: string): Promise<void> {
  await meetingContactDeliveryQueue.add("deliver", { outboxId }, {
    jobId: `meeting_contact_delivery_${outboxId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
    // The database lease owns retries. Once an external send starts, an
    // ambiguous result is never repeated automatically.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true
  });
}

import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const MEETING_CONFIRMATION_QUEUE = "meeting-confirmation";
export interface MeetingConfirmationJob { outboxId: string; }
export const meetingConfirmationQueue = new Queue<MeetingConfirmationJob>(MEETING_CONFIRMATION_QUEUE, { connection: redisConnection });
export async function enqueueMeetingConfirmation(outboxId: string): Promise<void> {
  await meetingConfirmationQueue.add("confirm", { outboxId }, {
    jobId: `meeting_confirmation_${outboxId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
    attempts: 1, removeOnComplete: true, removeOnFail: true
  });
}

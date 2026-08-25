import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const MEETING_PROVISIONING_QUEUE = "meeting-provisioning";

export interface MeetingProvisioningJob {
  outboxId: string;
}

export const meetingProvisioningQueue = new Queue<MeetingProvisioningJob>(
  MEETING_PROVISIONING_QUEUE,
  { connection: redisConnection }
);

export async function enqueueMeetingProvisioning(outboxId: string): Promise<void> {
  await meetingProvisioningQueue.add("provision", { outboxId }, {
    jobId: `meeting_provisioning_${outboxId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
    // The database saga owns retries. BullMQ must never repeat an ambiguous
    // spaces.create call after a worker crash or network timeout.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true
  });
}

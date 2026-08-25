import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface HandoffNotificationJob {
  notificationId: string;
}

export const HANDOFF_NOTIFICATION_QUEUE = "handoff-notifications";
export const handoffNotificationQueue = new Queue<HandoffNotificationJob>(HANDOFF_NOTIFICATION_QUEUE, {
  connection: redisConnection
});

export async function enqueueHandoffNotification(notificationId: string): Promise<"enqueued" | "deduplicated"> {
  const existing = await handoffNotificationQueue.getJob(notificationId);
  await handoffNotificationQueue.add("deliver", { notificationId }, {
    jobId: notificationId,
    attempts: 8,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000
  });
  return existing ? "deduplicated" : "enqueued";
}

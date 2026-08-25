import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface SchedulingNotificationJob {
  notificationId: string;
  action?: "deliver" | "edit";
  revision?: number;
}

export const SCHEDULING_NOTIFICATION_QUEUE = "scheduling-appointment-notifications";
export const schedulingNotificationQueue = new Queue<SchedulingNotificationJob>(SCHEDULING_NOTIFICATION_QUEUE, {
  connection: redisConnection
});

export async function enqueueSchedulingNotification(notificationId: string): Promise<"enqueued" | "deduplicated"> {
  const existing = await schedulingNotificationQueue.getJob(notificationId);
  await schedulingNotificationQueue.add("deliver", { notificationId }, {
    jobId: notificationId,
    attempts: 8,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000
  });
  return existing ? "deduplicated" : "enqueued";
}

export async function enqueueSchedulingNotificationEdit(
  notificationId: string,
  revision: number
): Promise<"enqueued" | "deduplicated"> {
  const jobId = `edit-${notificationId}-${revision}`;
  const existing = await schedulingNotificationQueue.getJob(jobId);
  await schedulingNotificationQueue.add("edit", { notificationId, action: "edit", revision }, {
    jobId,
    attempts: 8,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000
  });
  return existing ? "deduplicated" : "enqueued";
}

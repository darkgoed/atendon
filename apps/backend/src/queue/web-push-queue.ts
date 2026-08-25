import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const WEB_PUSH_QUEUE = "web-push-delivery";

export interface WebPushJob {
  tenantId: string;
  outboxId: string;
}

export const webPushQueue = new Queue<WebPushJob>(WEB_PUSH_QUEUE, {
  connection: redisConnection
});

export async function enqueueWebPush(tenantId: string, outboxId: string): Promise<"enqueued" | "deduplicated"> {
  const jobId = `web_push_${tenantId}_${outboxId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (await webPushQueue.getJob(jobId)) return "deduplicated";
  await webPushQueue.add("deliver", { tenantId, outboxId }, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 500
  });
  return "enqueued";
}

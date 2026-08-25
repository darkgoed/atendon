import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const AI_FOLLOW_UP_QUEUE = "ai-follow-ups";

export interface AiFollowUpJob {
  conversationId: string;
  sequenceVersion?: number;
  dueAt?: string;
}

export const aiFollowUpQueue = new Queue<AiFollowUpJob>(AI_FOLLOW_UP_QUEUE, { connection: redisConnection });

export async function enqueueAiFollowUp(
  conversationId: string,
  event?: { sequenceVersion: number; dueAt: Date }
): Promise<"enqueued" | "deduplicated"> {
  const dueAt = event?.dueAt;
  const jobId = (event
    ? `ai_follow_up_${conversationId}_${event.sequenceVersion}_${dueAt!.getTime()}`
    : `ai_follow_up_${conversationId}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const existing = await aiFollowUpQueue.getJob(jobId);
  await aiFollowUpQueue.add("send", {
    conversationId,
    ...(event ? { sequenceVersion: event.sequenceVersion, dueAt: dueAt!.toISOString() } : {})
  }, {
    jobId,
    delay: dueAt ? Math.max(0, dueAt.getTime() - Date.now()) : 0,
    attempts: 1,
    // The same conversation can become due again after the configured interval.
    // Remove terminal jobs so their deterministic id can be reused; while a job
    // is active/delayed, that id still suppresses duplicate reconciler enqueues.
    removeOnComplete: true,
    removeOnFail: true
  });
  return existing ? "deduplicated" : "enqueued";
}

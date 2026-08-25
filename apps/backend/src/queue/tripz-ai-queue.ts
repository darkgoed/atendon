import { Queue } from "bullmq";
import type { TripzAccessScope } from "../modules/tripz-ai/domain.js";
import { redisConnection } from "./connection.js";

export const TRIPZ_AI_QUEUE = "tripz-ai-turns";

export interface TripzAiTurnJob {
  scope: TripzAccessScope;
  conversationId: string;
  messageId: string;
  attachmentIds: string[];
}

export const tripzAiQueue = new Queue<TripzAiTurnJob>(TRIPZ_AI_QUEUE, { connection: redisConnection });

function tripzJobId(messageId: string): string {
  return `tripz_${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export async function enqueueTripzAiTurn(job: TripzAiTurnJob): Promise<void> {
  const jobId = tripzJobId(job.messageId);
  const previous = await tripzAiQueue.getJob(jobId);
  if (previous) {
    const state = await previous.getState();
    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return;
    await previous.remove();
  }
  await tripzAiQueue.add("process", job, {
    jobId,
    // OpenRouter retries are already capped and accounted for inside one turn.
    // A queue-level replay after an unknown provider outcome could double-charge.
    attempts: 1,
    removeOnComplete: 1_000,
    removeOnFail: 5_000
  });
}


import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const AI_EVALUATION_QUEUE = "ai-attendance-evaluations";

export interface AiEvaluationDirectJob {
  tenantId: string;
  conversationId: string;
  agentConfigVersionId: string;
  trigger: "closed" | "handoff" | "tool_error" | "manual" | "sampled";
}

export interface AiEvaluationEventJob {
  eventId: string;
}

export type AiEvaluationJob = AiEvaluationDirectJob | AiEvaluationEventJob;

export const aiEvaluationQueue = new Queue<AiEvaluationJob>(AI_EVALUATION_QUEUE, { connection: redisConnection });

export async function enqueueAiEvaluation(job: AiEvaluationDirectJob): Promise<"enqueued" | "deduplicated"> {
  const id = [job.tenantId, job.conversationId, job.agentConfigVersionId, "v1", job.trigger]
    .join("_")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const existing = await aiEvaluationQueue.getJob(id);
  await aiEvaluationQueue.add("evaluate", job, {
    jobId: id,
    attempts: 2,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 2_000,
    removeOnFail: 5_000
  });
  return existing ? "deduplicated" : "enqueued";
}

export async function enqueueAiEvaluationEvent(eventId: string): Promise<"enqueued" | "deduplicated"> {
  const jobId = `ai_evaluation_event_${eventId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const existing = await aiEvaluationQueue.getJob(jobId);
  await aiEvaluationQueue.add("evaluate-event", { eventId }, {
    jobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 2_000,
    removeOnFail: 5_000
  });
  return existing ? "deduplicated" : "enqueued";
}

export function isAiEvaluationEventJob(job: AiEvaluationJob): job is AiEvaluationEventJob {
  return "eventId" in job;
}

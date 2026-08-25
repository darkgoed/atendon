import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const AI_REPLAY_QUEUE = "ai-improvement-replays";
export interface AiReplayJob { runId: string }
export const aiReplayQueue = new Queue<AiReplayJob>(AI_REPLAY_QUEUE, { connection: redisConnection });

export async function enqueueAiReplay(runId: string): Promise<void> {
  await aiReplayQueue.add("replay", { runId }, {
    jobId: `ai_replay_${runId}`,
    attempts: 1,
    removeOnComplete: 2_000,
    removeOnFail: 5_000
  });
}

import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import type { SessionMessage } from "../modules/messages/types.js";
import { isWithinBusinessHours, nextBusinessHoursStart, type BusinessHoursConfig } from "../modules/whatsapp/business-hours.js";

export const INBOUND_QUEUE = "inbound-messages";
// A valid AI turn can span several provider/tool calls plus humanized typing.
// Three attempts expired during ordinary multi-message bursts before the
// active turn could absorb them, producing a false terminal queue failure.
export const INBOUND_JOB_ATTEMPTS = 8;
export type InboundJobData = SessionMessage & {
  aiTurnId?: string;
  automaticRecoveryAttempt?: number;
};

export const inboundQueue = new Queue<InboundJobData>(INBOUND_QUEUE, { connection: redisConnection });

export function createInboundJobData(message: SessionMessage): InboundJobData {
  return { ...message, aiTurnId: randomUUID(), automaticRecoveryAttempt: 0 };
}

export function ensureInboundAiTurn(data: InboundJobData): InboundJobData & { aiTurnId: string } {
  return data.aiTurnId
    ? data as InboundJobData & { aiTurnId: string }
    : { ...data, aiTurnId: randomUUID(), automaticRecoveryAttempt: data.automaticRecoveryAttempt ?? 0 };
}

export function inboundJobId(message: SessionMessage): string {
  return `${message.tenantId}_${message.sessionId}_${message.externalId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function inboundRecoveryJobId(message: SessionMessage): string {
  return `${inboundJobId(message)}_manual_recovery`;
}

async function addInboundJob(message: SessionMessage, jobId: string, delayMs = 0): Promise<void> {
  await inboundQueue.add("process", createInboundJobData(message), {
    jobId,
    attempts: INBOUND_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
    ...(delayMs > 0 ? { delay: delayMs } : {})
  });
}

export async function enqueueInbound(message: SessionMessage, delayMs = 0): Promise<void> {
  await addInboundJob(message, inboundJobId(message), delayMs);
}

export async function enqueueInboundRecovery(message: SessionMessage): Promise<void> {
  const jobId = inboundRecoveryJobId(message);
  const previous = await inboundQueue.getJob(jobId);
  if (previous) {
    const state = await previous.getState();
    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return;
    await previous.remove();
  }
  await addInboundJob(message, jobId);
}

export interface InboundQueueAdjustment {
  promoted: number;
  rescheduled: number;
  skipped: number;
}

interface AdjustableInboundJob {
  data: InboundJobData;
  getState(): Promise<string>;
  promote(): Promise<void>;
  changeDelay(delay: number): Promise<void>;
}

export async function adjustDelayedInboundJobList(
  jobs: AdjustableInboundJob[],
  tenantId: string,
  hours: BusinessHoursConfig,
  now = new Date()
): Promise<InboundQueueAdjustment> {
  const adjustment: InboundQueueAdjustment = { promoted: 0, rescheduled: 0, skipped: 0 };
  for (const job of jobs) {
    if (job.data.tenantId !== tenantId) continue;
    try {
      if (await job.getState() !== "delayed") {
        adjustment.skipped += 1;
        continue;
      }
      if (isWithinBusinessHours(now, hours)) {
        await job.promote();
        adjustment.promoted += 1;
        continue;
      }
      const delayMs = Math.max(0, nextBusinessHoursStart(now, hours).getTime() - now.getTime());
      await job.changeDelay(delayMs);
      adjustment.rescheduled += 1;
    } catch {
      adjustment.skipped += 1;
    }
  }
  return adjustment;
}

export async function adjustDelayedInboundJobs(
  tenantId: string,
  hours: BusinessHoursConfig,
  now = new Date()
): Promise<InboundQueueAdjustment> {
  const jobs = await inboundQueue.getDelayed(0, -1);
  // A worker or webhook may move a job after getDelayed(). The list helper
  // counts that race as skipped instead of risking a duplicate enqueue.
  return adjustDelayedInboundJobList(jobs, tenantId, hours, now);
}

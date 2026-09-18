import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const QUALIFICATION_WAIT_QUEUE = "qualification-waits";

export interface QualificationWaitJob {
  tenantId: string;
  qualificationId: string;
  /** Etapa que agendou a espera (informativo; a retomada revalida o estado no banco). */
  stepId?: string;
}

export const qualificationWaitQueue = new Queue<QualificationWaitJob>(QUALIFICATION_WAIT_QUEUE, { connection: redisConnection });

/** Agenda a retomada de uma espera (delay/wait_for_reply). jobId determinístico por etapa. */
export async function enqueueQualificationWait(data: QualificationWaitJob, delayMs = 0): Promise<void> {
  await qualificationWaitQueue.add("resume", data, {
    jobId: `qw:${data.qualificationId}:${data.stepId ?? "*"}`,
    attempts: 3,
    backoff: { type: "fixed", delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
    ...(delayMs > 0 ? { delay: delayMs } : {})
  });
}

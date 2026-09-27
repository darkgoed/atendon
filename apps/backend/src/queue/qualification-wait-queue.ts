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

/**
 * Agenda a retomada de uma espera (delay/wait_for_reply). jobId por etapa E
 * instante-alvo (em segundos): revisitar a mesma etapa não colide com o job
 * concluído retido. Sem ':' — o BullMQ recusa ids com ':' fora de 3 partes.
 */
export async function enqueueQualificationWait(data: QualificationWaitJob, delayMs = 0): Promise<void> {
  const dueSecond = Math.round((Date.now() + Math.max(0, delayMs)) / 1_000);
  await qualificationWaitQueue.add("resume", data, {
    jobId: `qw_${data.qualificationId}_${(data.stepId ?? "*").replaceAll(":", "_")}_${dueSecond}`,
    attempts: 3,
    backoff: { type: "fixed", delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
    ...(delayMs > 0 ? { delay: delayMs } : {})
  });
}

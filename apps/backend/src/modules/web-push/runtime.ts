import { Worker } from "bullmq";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { redisConnection } from "../../queue/connection.js";
import { enqueueWebPush, WEB_PUSH_QUEUE, webPushQueue, type WebPushJob } from "../../queue/web-push-queue.js";
import { VapidWebPushSender, WebPushProcessor } from "./processor.js";
import { WebPushRepository } from "./repository.js";

export interface WebPushRuntime {
  close(): Promise<void>;
}

export function startWebPushRuntime(): WebPushRuntime {
  if (!config.WEB_PUSH_PUBLIC_KEY || !config.WEB_PUSH_PRIVATE_KEY || !config.WEB_PUSH_SUBJECT) {
    logger.warn("Web Push desabilitado: configure WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY e WEB_PUSH_SUBJECT");
    return { close: async () => undefined };
  }

  const repository = new WebPushRepository(db);
  const processor = new WebPushProcessor(repository, new VapidWebPushSender(config));
  const worker = new Worker<WebPushJob>(WEB_PUSH_QUEUE, (job) => processor.process(
    job.data.tenantId,
    job.data.outboxId,
    job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
  ), { connection: redisConnection, concurrency: 5, metrics: { maxDataPoints: 24 * 60 } });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, outboxId: job.data.outboxId, result }, "Web Push processado");
  });
  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, outboxId: job?.data.outboxId, err: error }, "Web Push falhou");
  });

  const reconcile = async () => {
    const reminders = await repository.enqueueDueAppointmentReminders();
    const jobs = await repository.findPendingJobs();
    await Promise.all(jobs.map((job) => enqueueWebPush(job.tenantId, job.outboxId)));
    if (reminders > 0 || jobs.length > 0) {
      logger.info({ reminders, queued: jobs.length }, "Web Push outbox reconciliado");
    }
  };
  const timer = setInterval(() => {
    void reconcile().catch((error) => logger.error({ error }, "Reconciliação Web Push falhou"));
  }, 15_000);
  void reconcile().catch((error) => logger.error({ error }, "Reconciliação Web Push inicial falhou"));

  return {
    close: async () => {
      clearInterval(timer);
      await worker.close();
      await webPushQueue.close();
    }
  };
}

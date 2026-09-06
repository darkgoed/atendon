import { Worker } from "bullmq";
import { logger } from "./logger.js";
import { createWhatsAppRuntime } from "./runtime.js";
import { redisConnection } from "./queue/connection.js";
import { ensureInboundAiTurn, INBOUND_QUEUE, type InboundJobData } from "./queue/message-queue.js";
import { HUMAN_OUTBOUND_QUEUE, type HumanOutboundJob } from "./queue/human-message-queue.js";
import { MessageRepository } from "./modules/messages/repository.js";
import { db } from "./db/client.js";
import { ConversationBusyRetryError, isAutomaticAiRecoveryError } from "./modules/messages/process-message.js";
import { HANDOFF_NOTIFICATION_QUEUE, enqueueHandoffNotification, type HandoffNotificationJob } from "./queue/handoff-notification-queue.js";
import {
  SCHEDULING_NOTIFICATION_QUEUE,
  enqueueSchedulingNotification,
  enqueueSchedulingNotificationEdit,
  type SchedulingNotificationJob
} from "./queue/scheduling-notification-queue.js";
import { SchedulingNotificationRepository } from "./modules/scheduling/notification-repository.js";
import {
  CRITICAL_WORKER_HEARTBEAT_KEYS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_MS
} from "./readiness.js";
import { AI_FOLLOW_UP_QUEUE, enqueueAiFollowUp, type AiFollowUpJob } from "./queue/ai-follow-up-queue.js";

import { config } from "./config.js";
import {
  MEETING_PROVISIONING_QUEUE,
  enqueueMeetingProvisioning,
  type MeetingProvisioningJob
} from "./queue/meeting-provisioning-queue.js";
import {
  MeetingProvisioningProcessor,
  MeetingProvisioningRepository
} from "./modules/scheduling/meeting-provisioning.js";
import { GoogleMeetClientCache } from "./modules/scheduling/google-meet.js";
import {
  MEETING_CONTACT_DELIVERY_QUEUE,
  enqueueMeetingContactDelivery,
  type MeetingContactDeliveryJob
} from "./queue/meeting-contact-delivery-queue.js";
import {
  APPOINTMENT_STATUS_REACTION_QUEUE,
  enqueueAppointmentStatusReaction,
  type AppointmentStatusReactionJob
} from "./queue/appointment-status-reaction-queue.js";
import {
  MeetingContactDeliveryProcessor,
  MeetingContactDeliveryRepository
} from "./modules/scheduling/meeting-contact-delivery.js";
import { MEETING_CONFIRMATION_QUEUE, enqueueMeetingConfirmation, type MeetingConfirmationJob } from "./queue/meeting-confirmation-queue.js";
import { MeetingConfirmationProcessor, MeetingConfirmationRepository } from "./modules/scheduling/meeting-confirmation.js";
import { isFeatureFlagEnabled } from "./modules/operations/feature-flags.js";
import {
  AppointmentStatusReactionProcessor,
  AppointmentStatusReactionRepository
} from "./modules/scheduling/status-reaction.js";
import {
  reconcileAiFollowUps as reconcileAiFollowUpPages,
  reconcileHandoffNotifications as reconcileHandoffPages,
  reconciliationLogLevel,
  type ReconciliationResult
} from "./modules/operations/event-reconciliation.js";
import { isWithinBusinessHours } from "./modules/whatsapp/business-hours.js";
import { startWebPushRuntime } from "./modules/web-push/runtime.js";
import { aiTurnProgressStore } from "./modules/realtime/ai-turn-progress.js";
import { reconcilePendingMeetingResults } from "./modules/commercial-journey/reconciliation.js";
import { enqueueTripzAiTurn, TRIPZ_AI_QUEUE, type TripzAiTurnJob } from "./queue/tripz-ai-queue.js";
import { TripzAiRepository } from "./modules/tripz-ai/repository.js";
import { TripzAiTurnProcessor } from "./modules/tripz-ai/runtime.js";
import { authorizeTripzAiWorkerScope } from "./modules/tripz-ai/authorization.js";
import {
  MEET_MAINTENANCE_QUEUE,
  meetMaintenanceQueue,
  scheduleMeetMaintenanceJobs,
  type MeetMaintenanceJob
} from "./queue/meet-maintenance-queue.js";
import { indexMeetRecordings } from "./modules/meet/recordings-indexer.js";
import { deleteExpiredMeetRecordings } from "./modules/meet/retention.js";
import { runBillingReconciliationBatch, runSubscriptionLifecycleBatch } from "./billing/reconciler.js";
import { runMercadoPagoReconciliationBatch } from "./billing/mercadopago-reconciliation.js";
import { runDunningBatch } from "./billing/dunning.js";
import { applyScheduledDowngrades } from "./billing/proration.js";
import {
  OAUTH_TOKEN_RENEWAL_INTERVAL_MS,
  runOAuthTokenRenewalBatch,
} from "./billing/mercadopago-renewal.js";
export { runOAuthTokenRenewalBatch } from "./billing/mercadopago-renewal.js";

const { manager, processor, followUpProcessor, followUpRepository } = createWhatsAppRuntime();
const webPushRuntime = startWebPushRuntime();
const workerMetrics = { maxDataPoints: 24 * 60 };
const worker = new Worker<InboundJobData>(INBOUND_QUEUE, async (job) => {
  let data = job.data;
  if (!data.aiTurnId) {
    data = ensureInboundAiTurn(data);
    await job.updateData(data);
  }
  try {
    return await processor.process(data, {
      attempt: job.attemptsMade + 1,
      requestId: data.aiTurnId,
      automaticRecoveryAttempt: data.automaticRecoveryAttempt ?? 0
    });
  } catch (error) {
    if (isAutomaticAiRecoveryError(error) && (data.automaticRecoveryAttempt ?? 0) < 1) {
      await job.updateData({ ...data, automaticRecoveryAttempt: 1 });
    }
    throw error;
  }
}, {
  connection: redisConnection,
  concurrency: 5,
  metrics: workerMetrics
});
const humanWorker = new Worker<HumanOutboundJob>(HUMAN_OUTBOUND_QUEUE, async (job) => {
  const sent = await manager.sendText(job.data.sessionId, job.data.contactJid ?? job.data.contactPhone, job.data.text);
  await new MessageRepository(db).recordHuman({
    kind: "human", externalId: sent.externalId, tenantId: job.data.tenantId,
    sessionId: job.data.sessionId, contactPhone: job.data.contactPhone, contactJid: job.data.contactJid, text: job.data.text
  });
  return sent.externalId;
}, { connection: redisConnection, concurrency: 5, metrics: workerMetrics });
const messageRepository = new MessageRepository(db);
const handoffWorker = new Worker<HandoffNotificationJob>(HANDOFF_NOTIFICATION_QUEUE, async (job) => {
  const notification = await messageRepository.getPendingHandoffNotification(job.data.notificationId);
  if (!notification) return "already_delivered";
  try {
    const sent = await manager.sendText(notification.sessionId, notification.attendantPhone, notification.message);
    await messageRepository.markHandoffNotificationSent(notification.id, sent.externalId);
    return sent.externalId;
  } catch (error) {
    await messageRepository.recordHandoffNotificationFailure(notification.id, error);
    throw error;
  }
}, { connection: redisConnection, concurrency: 3, metrics: workerMetrics });
const schedulingNotificationRepository = new SchedulingNotificationRepository(db);
const schedulingNotificationWorker = new Worker<SchedulingNotificationJob>(SCHEDULING_NOTIFICATION_QUEUE, async (job) => {
  if (job.data.action === "edit") {
    const notification = await schedulingNotificationRepository.getPendingEdit(job.data.notificationId);
    if (!notification) return "already_edited";
    try {
      await manager.updateText(
        notification.sessionId,
        notification.groupJid,
        notification.externalMessageId,
        notification.message
      );
      await schedulingNotificationRepository.markEdited(notification.id, notification.revision);
      return `edited:${notification.revision}`;
    } catch (error) {
      await schedulingNotificationRepository.recordEditFailure(notification.id, notification.revision, error);
      throw error;
    }
  }
  const notification = await schedulingNotificationRepository.getPending(job.data.notificationId);
  if (!notification) return "already_delivered";
  try {
    const sent = await manager.sendText(notification.sessionId, notification.groupJid, notification.message);
    const editRevision = await schedulingNotificationRepository.markSent(
      notification.id,
      sent.externalId,
      notification.revision
    );
    if (editRevision !== null) {
      await enqueueSchedulingNotificationEdit(notification.id, editRevision).catch((error) => {
        logger.warn(
          { err: error, notificationId: notification.id, revision: editRevision },
          "Scheduling group notification race edit enqueue failed; database reconciler will retry"
        );
      });
    }
    return sent.externalId;
  } catch (error) {
    await schedulingNotificationRepository.recordFailure(notification.id, error);
    throw error;
  }
}, { connection: redisConnection, concurrency: 3, metrics: workerMetrics });
const followUpWorker = new Worker<AiFollowUpJob>(AI_FOLLOW_UP_QUEUE, async (job) => {
  try {
    return await followUpProcessor.process(job.data.conversationId);
  } finally {
    const next = await followUpRepository.findScheduledEvent(job.data.conversationId);
    if (next) {
      await enqueueAiFollowUp(next.conversationId, {
        sequenceVersion: next.sequenceVersion,
        dueAt: next.dueAt
      }).catch((error) => logger.warn(
        { error, conversationId: next.conversationId },
        "Follow-up committed but next event enqueue failed; reconciler will recover"
      ));
    }
  }
}, {
  connection: redisConnection,
  concurrency: 3,
  metrics: workerMetrics
});
const meetingProvisioningRepository = new MeetingProvisioningRepository(db);
const meetingProvisioningProcessor = new MeetingProvisioningProcessor(
  meetingProvisioningRepository,
  new GoogleMeetClientCache()
);
const meetingProvisioningWorker = new Worker<MeetingProvisioningJob>(
  MEETING_PROVISIONING_QUEUE,
  (job) => meetingProvisioningProcessor.process(job.data.outboxId),
  { connection: redisConnection, concurrency: 3, metrics: workerMetrics }
);
const meetingContactDeliveryRepository = new MeetingContactDeliveryRepository(db);
const meetingContactDeliveryProcessor = new MeetingContactDeliveryProcessor(
  meetingContactDeliveryRepository,
  manager
);
const meetingContactDeliveryWorker = new Worker<MeetingContactDeliveryJob>(
  MEETING_CONTACT_DELIVERY_QUEUE,
  (job) => meetingContactDeliveryProcessor.process(job.data.outboxId),
  { connection: redisConnection, concurrency: 3, metrics: workerMetrics }
);
const meetingConfirmationRepository = new MeetingConfirmationRepository(db);
const meetingConfirmationProcessor = new MeetingConfirmationProcessor(
  meetingConfirmationRepository,
  manager,
  (tenantId) => isFeatureFlagEnabled(db, tenantId, "scheduling_meeting_confirmation_v1")
);
const meetingConfirmationWorker = new Worker<MeetingConfirmationJob>(
  MEETING_CONFIRMATION_QUEUE,
  (job) => meetingConfirmationProcessor.process(job.data.outboxId),
  { connection: redisConnection, concurrency: 3, metrics: workerMetrics }
);
meetingConfirmationWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, outboxId: job.data.outboxId, result }, "Meeting confirmation processed");
});
meetingConfirmationWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, outboxId: job?.data.outboxId, err: error },
    "Meeting confirmation worker failed; database reconciliation will classify the operation"
  );
});
const appointmentStatusReactionRepository = new AppointmentStatusReactionRepository(db);
const appointmentStatusReactionProcessor = new AppointmentStatusReactionProcessor(
  appointmentStatusReactionRepository,
  {
    sendReaction: (sessionId, destination, receipt, emoji) =>
      manager.sendReactionStrict(sessionId, destination, receipt, emoji)
  }
);
const appointmentStatusReactionWorker = new Worker<AppointmentStatusReactionJob>(
  APPOINTMENT_STATUS_REACTION_QUEUE,
  (job) => appointmentStatusReactionProcessor.process(job.data.notificationId),
  { connection: redisConnection, concurrency: 3, metrics: workerMetrics }
);
const tripzAiRepository = new TripzAiRepository(db);
const tripzAiTurnProcessor = new TripzAiTurnProcessor(tripzAiRepository, {
  authorizeScope: (scope) => authorizeTripzAiWorkerScope(db, scope)
});
const tripzAiWorker = new Worker<TripzAiTurnJob>(
  TRIPZ_AI_QUEUE,
  (job) => tripzAiTurnProcessor.process(job.data),
  { connection: redisConnection, concurrency: 2, metrics: workerMetrics }
);
const meetMaintenanceWorker = new Worker<MeetMaintenanceJob>(
  MEET_MAINTENANCE_QUEUE,
  async (job) => {
    if (!config.MEET_ENABLED) return { skipped: true };
    return job.data.kind === "index"
      ? indexMeetRecordings()
      : deleteExpiredMeetRecordings();
  },
  { connection: redisConnection, concurrency: 1, metrics: workerMetrics }
);
worker.on("completed", (job) => logger.info({ jobId: job.id }, "Message processed"));
worker.on("failed", (job, error) => {
  const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  if (error instanceof ConversationBusyRetryError && (job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 1)) {
    logger.info({ jobId: job?.id, externalId: error.externalId, attemptsMade: job?.attemptsMade, attempts: job?.opts.attempts }, "Message processing delayed because conversation is busy");
    return;
  }
  if (!exhausted) {
    logger.warn({ jobId: job?.id, err: error, attemptsMade: job?.attemptsMade, attempts: job?.opts.attempts }, "Message processing attempt failed; retry scheduled");
    return;
  }
  logger.error({ jobId: job?.id, err: error, exhausted }, "Message failed");
  if (job?.data.tenantId) void db.query(
    "INSERT INTO system_alerts(tenant_id,message) VALUES($1,$2)",
    [job.data.tenantId, "A mensagem da IA não foi enviada. Verifique a conexão e tente novamente."]
  ).catch((alertError) => logger.error({ err: alertError, jobId: job.id }, "Failed to persist message alert"));
});
humanWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, err: error }, "Human message failed");
  if (job?.data.tenantId) void db.query(
    "INSERT INTO system_alerts(tenant_id,message) VALUES($1,$2)",
    [job.data.tenantId, "A mensagem do atendente não foi enviada. Verifique a conexão e tente novamente."]
  ).catch((alertError) => logger.error({ err: alertError, jobId: job.id }, "Failed to persist message alert"));
});
handoffWorker.on("failed", (job, error) => {
  const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  logger.error({ jobId: job?.id, err: error, exhausted }, "Handoff notification failed");
  if (exhausted && job?.data.notificationId) {
    void messageRepository.recordHandoffNotificationFailure(job.data.notificationId, error, true)
      .then(() => db.query(
        `INSERT INTO system_alerts(tenant_id,message)
         SELECT tenant_id,$2 FROM handoff_notifications WHERE id=$1`,
        [job.data.notificationId, "A notificação de transferência para atendimento humano não foi entregue."]
      ))
      .catch((markError) => logger.error({ err: markError, jobId: job.id }, "Failed to persist handoff notification failure"));
  }
});
schedulingNotificationWorker.on("failed", (job, error) => {
  const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  const editing = job?.data.action === "edit";
  logger.error({ jobId: job?.id, err: error, exhausted, editing }, editing
    ? "Scheduling appointment group notification edit failed"
    : "Scheduling appointment group notification failed");
  if (exhausted && job?.data.notificationId) {
    const terminal = editing
      ? schedulingNotificationRepository.recordEditFailure(
          job.data.notificationId,
          job.data.revision ?? 0,
          error,
          true
        )
      : schedulingNotificationRepository.recordFailure(job.data.notificationId, error, true);
    void terminal
      .catch((markError) => logger.error({ err: markError, jobId: job.id }, "Failed to persist scheduling notification failure"));
  }
});
followUpWorker.on("completed", (job, result) => logger.info({ jobId: job.id, result }, "AI follow-up processed"));
followUpWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, conversationId: job?.data.conversationId, err: error }, "AI follow-up failed");
});
meetingProvisioningWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, outboxId: job.data.outboxId, result }, "Meeting provisioning processed");
});
meetingProvisioningWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, outboxId: job?.data.outboxId, err: error },
    "Meeting provisioning worker failed; database lease reconciliation will classify the operation"
  );
});
meetingContactDeliveryWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, outboxId: job.data.outboxId, result }, "Meeting contact delivery processed");
});
meetingContactDeliveryWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, outboxId: job?.data.outboxId, err: error },
    "Meeting contact delivery worker failed; database reconciliation will classify the operation"
  );
});
tripzAiWorker.on("completed", (job, result) => {
  logger.info({ component: "TripzAI", jobId: job.id, conversationId: job.data.conversationId, result }, "[TripzAI] queued turn completed");
});
tripzAiWorker.on("failed", (job, error) => {
  logger.error({
    component: "TripzAI",
    jobId: job?.id,
    tenantId: job?.data.scope.tenantId,
    conversationId: job?.data.conversationId,
    messageId: job?.data.messageId,
    errorCode: error instanceof Error && "code" in error ? String(error.code) : "TRIPZ_AI_PROCESSING_FAILED"
  }, "[TripzAI] queued turn failed");
  if (job) {
    void tripzAiTurnProcessor.markTerminalFailure(job.data, error)
      .catch((markError) => logger.error({ component: "TripzAI", jobId: job.id, error: markError }, "[TripzAI] failed to persist terminal turn failure"));
  }
});
meetMaintenanceWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, kind: job.data.kind, result }, "Meet recording maintenance completed");
});
meetMaintenanceWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, kind: job?.data.kind, error }, "Meet recording maintenance failed");
});

const reconcileTripzAiTurns = async (): Promise<void> => {
  const interruptedTurns = await tripzAiRepository.failStaleProcessingTurns({ limit: 100 });
  const turns = await tripzAiRepository.listQueuedTurnsForRecovery({ olderThanMs: 30_000, limit: 100 });
  for (const turn of turns) await enqueueTripzAiTurn(turn);
  if (turns.length > 0 || interruptedTurns > 0) {
    logger.info({ component: "TripzAI", recoveredTurns: turns.length, interruptedTurns }, "[TripzAI] queued turns reconciled");
  }
};
const tripzAiReconciler = setInterval(() => {
  void reconcileTripzAiTurns()
    .catch((error) => logger.error({ component: "TripzAI", error }, "[TripzAI] queued turn reconciliation failed"));
}, 30_000);

const businessHoursState = new Map<string, boolean>();
const reconcileBusinessHoursPresence = async (): Promise<void> => {
  const result = await db.query<{ id: string; timezone: string; business_hours_start: string; business_hours_end: string }>(
    `SELECT s.id, t.timezone, t.business_hours_start, t.business_hours_end
     FROM whatsapp_sessions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.status = 'connected'`
  );
  const now = new Date();
  await Promise.all(result.rows.map(async (row) => {
    const open = isWithinBusinessHours(now, { timezone: row.timezone, start: row.business_hours_start, end: row.business_hours_end });
    const wasOpen = businessHoursState.get(row.id);
    businessHoursState.set(row.id, open);
    // First observation after a process (re)start: start()/CONNECTION_UPDATE already set the correct
    // initial presence, so only act on an actual transition to avoid a redundant Evolution API call.
    if (wasOpen === undefined || wasOpen === open) return;
    try {
      if (open) await manager.goOnline(row.id);
      else await manager.setPresence(row.id, "unavailable");
    } catch (error) {
      logger.warn({ error, sessionId: row.id, open }, "Business hours presence transition failed");
    }
  }));
};
const businessHoursTicker = setInterval(() => {
  void reconcileBusinessHoursPresence().catch((error) => logger.error({ error }, "Business hours presence reconciliation failed"));
}, 60_000);

const logReconciliationResult = (result: ReconciliationResult, message: string): void => {
  const level = reconciliationLogLevel(result);
  if (level === "warn") logger.warn({ result }, message);
  else if (level === "info") logger.info({ result }, message);
  else logger.debug({ result }, message);
};

const reconcileHandoffNotifications = async (): Promise<void> => {
  const result = await reconcileHandoffPages(messageRepository, enqueueHandoffNotification);
  logReconciliationResult(result, "Handoff recovery reconciliation completed");
};
const handoffReconciler = setInterval(() => {
  void reconcileHandoffNotifications().catch((error) => logger.error({ error }, "Handoff outbox reconciliation failed"));
}, 120_000);
const reconcileAiFollowUps = async (): Promise<void> => {
  const result = await reconcileAiFollowUpPages(followUpRepository, enqueueAiFollowUp);
  logReconciliationResult(result, "AI follow-up recovery reconciliation completed");
};
const followUpReconciler = setInterval(() => {
  void reconcileAiFollowUps().catch((error) => logger.error({ error }, "AI follow-up reconciliation failed"));
}, 60_000);
const reconcileSchedulingNotifications = async (): Promise<void> => {
  let cursor: string | undefined;
  let examined = 0;
  do {
    const page = await schedulingNotificationRepository.findPendingPage(100, cursor);
    examined += page.ids.length;
    await Promise.all(page.ids.map((id) => enqueueSchedulingNotification(id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  let editCursor: string | undefined;
  let editsExamined = 0;
  do {
    const page = await schedulingNotificationRepository.findPendingEditPage(100, editCursor);
    editsExamined += page.edits.length;
    await Promise.all(page.edits.map((edit) =>
      enqueueSchedulingNotificationEdit(edit.id, edit.revision)
    ));
    editCursor = page.nextCursor ?? undefined;
  } while (editCursor);
  const details = { examined, editsExamined };
  if (examined > 0 || editsExamined > 0) {
    logger.info(details, "Scheduling group notification recovery reconciliation completed");
  } else {
    logger.debug(details, "Scheduling group notification recovery reconciliation completed");
  }
};
const schedulingNotificationReconciler = setInterval(() => {
  void reconcileSchedulingNotifications()
    .catch((error) => logger.error({ error }, "Scheduling group notification outbox reconciliation failed"));
}, 60_000);
const reconcileMeetingProvisioning = async (): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await meetingProvisioningRepository.findDuePage(100, cursor);
    await Promise.all(page.ids.map((id) => enqueueMeetingProvisioning(id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
};
const meetingProvisioningReconciler = setInterval(() => {
  void reconcileMeetingProvisioning()
    .catch((error) => logger.error({ error }, "Meeting provisioning outbox reconciliation failed"));
}, 15_000);
const reconcileMeetingContactDeliveries = async (): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await meetingContactDeliveryRepository.findDuePage(100, cursor);
    await Promise.all(page.ids.map((id) => enqueueMeetingContactDelivery(id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
};
const meetingContactDeliveryReconciler = setInterval(() => {
  void reconcileMeetingContactDeliveries()
    .catch((error) => logger.error({ error }, "Meeting contact delivery outbox reconciliation failed"));
}, 15_000);
const reconcileMeetingConfirmations = async (): Promise<void> => {
  // Primeiro cria as linhas que faltam para agendamentos futuros, depois
  // despacha as que já venceram. A ordem importa: sem o primeiro passo a
  // outbox nunca receberia nada.
  for (const appointmentId of await meetingConfirmationRepository.findAppointmentsNeedingConfirmation(100)) {
    await meetingConfirmationRepository.enqueueForAppointment(appointmentId);
  }
  let cursor: string | undefined;
  do {
    const page = await meetingConfirmationRepository.findDuePage(100, cursor);
    await Promise.all(page.ids.map((id) => enqueueMeetingConfirmation(id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
};
const meetingConfirmationReconciler = setInterval(() => {
  void reconcileMeetingConfirmations()
    .catch((error) => logger.error({ error }, "Meeting confirmation outbox reconciliation failed"));
}, 15_000);
const reconcileAppointmentStatusReactions = async (): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await appointmentStatusReactionRepository.findPendingPage(100, cursor);
    await Promise.all(page.ids.map((id) => enqueueAppointmentStatusReaction(id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
};
const appointmentStatusReactionReconciler = setInterval(() => {
  void reconcileAppointmentStatusReactions()
    .catch((error) => logger.error({ error }, "Appointment status reaction reconciliation failed"));
}, 15_000);
const pendingMeetingResultReconciler = setInterval(() => {
  void reconcilePendingMeetingResults()
    .then((result) => {
      if (result.failed > 0) logger.warn({ result }, "Pending meeting result reconciliation completed with failures");
      else if (result.marked > 0) logger.info({ result }, "Pending meeting results marked");
      else logger.debug({ result }, "Pending meeting result reconciliation completed");
    })
    .catch((error) => logger.error({ error }, "Pending meeting result reconciliation failed"));
}, 60_000);
const billingReconciler = setInterval(() => {
  void runBillingReconciliationBatch(100).then((result) => {
    if (result.errors.length) logger.warn({ result }, "Billing reconciliation completed with errors");
  }).catch((error) => logger.error({ error }, "Billing reconciliation failed"));
}, Number(process.env.BILLING_RECONCILIATION_INTERVAL_MS ?? 60_000));
billingReconciler.unref();
const mercadopagoReconciliationTimer = setInterval(() => {
  void runMercadoPagoReconciliationBatch(100).then((result) => {
    if (result.errors.length) logger.warn({ result }, "Mercado Pago reconciliation completed with errors");
  }).catch((error) => logger.error({ error }, "Mercado Pago reconciliation failed"));
}, Number(process.env.MERCADOPAGO_RECONCILIATION_INTERVAL_MS ?? 60_000));
mercadopagoReconciliationTimer.unref();
const dunningTimer = setInterval(() => {
  void runDunningBatch(100).then((result) => {
    if (result.errors.length) logger.warn({ result }, "Billing dunning completed with errors");
  }).catch((error) => logger.error({ error }, "Billing dunning failed"));
}, Number(process.env.DUNNING_INTERVAL_MS ?? 60_000));
dunningTimer.unref();
const subscriptionLifecycleTimer = setInterval(() => {
  void runSubscriptionLifecycleBatch(100).then((result) => {
    if (result.errors.length) logger.warn({ result }, "Subscription lifecycle completed with errors");
  }).catch((error) => logger.error({ error }, "Subscription lifecycle failed"));
}, Number(process.env.SUBSCRIPTION_LIFECYCLE_INTERVAL_MS ?? 60_000));
subscriptionLifecycleTimer.unref();
/**
 * Downgrade agendado (§U4): a troca para um plano menor é gravada em
 * tenant_subscriptions.scheduled_plan_id e só vale quando o ciclo pago vira.
 * Sem este timer a regra existiria no banco e nunca seria aplicada — o cliente
 * continuaria no plano caro indefinidamente.
 */
const scheduledDowngradeTimer = setInterval(() => {
  void applyScheduledDowngrades(100)
    .then((applied) => { if (applied > 0) logger.info({ applied }, "Scheduled downgrades applied"); })
    .catch((error) => logger.error({ error }, "Scheduled downgrade application failed"));
}, Number(process.env.SCHEDULED_DOWNGRADE_INTERVAL_MS ?? 60_000));
scheduledDowngradeTimer.unref();
const oauthTokenRenewalTimer = setInterval(() => {
  void runOAuthTokenRenewalBatch()
    .catch((error) => logger.error({ error }, "Mercado Pago OAuth token renewal batch failed"));
}, Number(process.env.OAUTH_TOKEN_RENEWAL_INTERVAL_MS ?? OAUTH_TOKEN_RENEWAL_INTERVAL_MS));
oauthTokenRenewalTimer.unref();
const recordHeartbeat = async (): Promise<void> => {
  const redis = await worker.client;
  const value = String(Date.now());
  await Promise.all([
    redis.set(WORKER_HEARTBEAT_KEY, value, { PX: WORKER_HEARTBEAT_TTL_MS }),
    ...Object.values(CRITICAL_WORKER_HEARTBEAT_KEYS)
      .map((key) => redis.set(key, value, { PX: WORKER_HEARTBEAT_TTL_MS }))
  ]);
};
const heartbeatTimer = setInterval(() => {
  void recordHeartbeat().catch((error) => logger.error({ error }, "Worker heartbeat failed"));
}, 10_000);
void recordHeartbeat().catch((error) => logger.error({ error }, "Initial worker heartbeat failed"));
void reconcileHandoffNotifications().catch((error) => logger.error({ error }, "Initial handoff outbox reconciliation failed"));
void reconcileAiFollowUps().catch((error) => logger.error({ error }, "Initial AI follow-up reconciliation failed"));
void reconcileSchedulingNotifications()
  .catch((error) => logger.error({ error }, "Initial scheduling group notification reconciliation failed"));
void reconcileMeetingProvisioning()
  .catch((error) => logger.error({ error }, "Initial meeting provisioning reconciliation failed"));
void reconcileMeetingContactDeliveries()
  .catch((error) => logger.error({ error }, "Initial meeting contact delivery reconciliation failed"));
void reconcileMeetingConfirmations()
  .catch((error) => logger.error({ error }, "Initial meeting confirmation reconciliation failed"));
void reconcileAppointmentStatusReactions()
  .catch((error) => logger.error({ error }, "Initial appointment status reaction reconciliation failed"));
void reconcilePendingMeetingResults()
  .catch((error) => logger.error({ error }, "Initial pending meeting result reconciliation failed"));
void reconcileTripzAiTurns()
  .catch((error) => logger.error({ component: "TripzAI", error }, "[TripzAI] initial queued turn reconciliation failed"));
if (config.MEET_ENABLED) {
  void scheduleMeetMaintenanceJobs()
    .catch((error) => logger.error({ error }, "Meet recording repeatable jobs could not be scheduled"));
}
void manager.startAll().catch((error) => logger.error({ error }, "Evolution tenant provisioning failed"));

async function shutdown(): Promise<void> {
  clearInterval(handoffReconciler);
  clearInterval(schedulingNotificationReconciler);
  clearInterval(followUpReconciler);
  clearInterval(businessHoursTicker);
  clearInterval(meetingProvisioningReconciler);
  clearInterval(meetingContactDeliveryReconciler);
  clearInterval(meetingConfirmationReconciler);
  clearInterval(appointmentStatusReactionReconciler);
  clearInterval(pendingMeetingResultReconciler);
  clearInterval(billingReconciler);
  clearInterval(mercadopagoReconciliationTimer);
  clearInterval(dunningTimer);
  clearInterval(subscriptionLifecycleTimer);
  clearInterval(scheduledDowngradeTimer);
  clearInterval(oauthTokenRenewalTimer);
  clearInterval(heartbeatTimer);
  clearInterval(tripzAiReconciler);
  try {
    const redis = await worker.client;
    await redis.del(WORKER_HEARTBEAT_KEY, ...Object.values(CRITICAL_WORKER_HEARTBEAT_KEYS));
  } catch (error) {
    logger.warn({ error }, "Could not clear worker heartbeat during shutdown");
  }
  await manager.stopAll();
  await worker.close();
  await humanWorker.close();
  await handoffWorker.close();
  await schedulingNotificationWorker.close();
  await followUpWorker.close();
  await meetingProvisioningWorker.close();
  await meetingContactDeliveryWorker.close();
  await meetingConfirmationWorker.close();
  await appointmentStatusReactionWorker.close();
  await tripzAiWorker.close();
  await meetMaintenanceWorker.close();
  await meetMaintenanceQueue.close();
  await webPushRuntime.close();
  await aiTurnProgressStore.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

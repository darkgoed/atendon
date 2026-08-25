import { db } from "./db/client.js";
import { meetingContactDeliveryQueue } from "./queue/meeting-contact-delivery-queue.js";
import { meetingProvisioningQueue } from "./queue/meeting-provisioning-queue.js";
import { inboundQueue } from "./queue/message-queue.js";

export const WORKER_HEARTBEAT_KEY = "atendon:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL_MS = 30_000;
export const CRITICAL_WORKER_HEARTBEAT_KEYS = {
  inbound: "atendon:worker:heartbeat:inbound",
  meeting_provisioning: "atendon:worker:heartbeat:meeting_provisioning",
  meeting_contact_delivery: "atendon:worker:heartbeat:meeting_contact_delivery"
} as const;
const READINESS_TIMEOUT_MS = 2_000;

export interface ReadinessResult {
  ready: boolean;
  checks: {
    postgres: boolean;
    redis: boolean;
    queue: boolean;
    worker: boolean;
    worker_inbound: boolean;
    worker_meeting_provisioning: boolean;
    worker_meeting_contact_delivery: boolean;
  };
}

export function isWorkerHeartbeatFresh(value: string | null, now = Date.now()): boolean {
  const heartbeat = Number(value);
  return Number.isFinite(heartbeat)
    && heartbeat > 0
    && now - heartbeat >= 0
    && now - heartbeat <= WORKER_HEARTBEAT_TTL_MS;
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Readiness check timed out")), READINESS_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkReadiness(now = Date.now()): Promise<ReadinessResult> {
  const checks: ReadinessResult["checks"] = {
    postgres: false,
    redis: false,
    queue: false,
    worker: false,
    worker_inbound: false,
    worker_meeting_provisioning: false,
    worker_meeting_contact_delivery: false
  };

  await Promise.all([
    withTimeout(db.query("SELECT 1"))
      .then(() => { checks.postgres = true; })
      .catch(() => undefined),
    withTimeout((async () => {
      await Promise.all([
        inboundQueue.waitUntilReady(),
        meetingProvisioningQueue.waitUntilReady(),
        meetingContactDeliveryQueue.waitUntilReady()
      ]);
      const redis = await inboundQueue.client;
      const redisReady = redis.status === "ready";
      await Promise.all([
        inboundQueue.getJobCounts("waiting", "active", "delayed", "failed"),
        meetingProvisioningQueue.getJobCounts("waiting", "active", "delayed", "failed"),
        meetingContactDeliveryQueue.getJobCounts("waiting", "active", "delayed", "failed")
      ]);
      const [legacy, inbound, meetingProvisioning, meetingContactDelivery] = await Promise.all([
        redis.get(WORKER_HEARTBEAT_KEY),
        redis.get(CRITICAL_WORKER_HEARTBEAT_KEYS.inbound),
        redis.get(CRITICAL_WORKER_HEARTBEAT_KEYS.meeting_provisioning),
        redis.get(CRITICAL_WORKER_HEARTBEAT_KEYS.meeting_contact_delivery)
      ]);
      const critical = {
        worker_inbound: isWorkerHeartbeatFresh(inbound, now),
        worker_meeting_provisioning: isWorkerHeartbeatFresh(meetingProvisioning, now),
        worker_meeting_contact_delivery: isWorkerHeartbeatFresh(meetingContactDelivery, now)
      };
      return {
        redis: redisReady,
        queue: true,
        worker: isWorkerHeartbeatFresh(legacy, now) && Object.values(critical).every(Boolean),
        ...critical
      };
    })())
      .then((queueChecks) => { Object.assign(checks, queueChecks); })
      .catch(() => undefined)
  ]);

  return { ready: Object.values(checks).every(Boolean), checks };
}

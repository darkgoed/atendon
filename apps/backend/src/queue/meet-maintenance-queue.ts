import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const MEET_MAINTENANCE_QUEUE = "meet-recording-maintenance";

export type MeetMaintenanceJob =
  | { kind: "index" }
  | { kind: "retention" };

export const meetMaintenanceQueue = new Queue<MeetMaintenanceJob>(MEET_MAINTENANCE_QUEUE, {
  connection: redisConnection
});

export async function scheduleMeetMaintenanceJobs(): Promise<void> {
  await Promise.all([
    meetMaintenanceQueue.add("index-recordings", { kind: "index" }, {
      jobId: "meet-recordings-index",
      repeat: { every: 5 * 60_000 },
      removeOnComplete: 100,
      removeOnFail: 500
    }),
    meetMaintenanceQueue.add("retain-recordings", { kind: "retention" }, {
      jobId: "meet-recordings-retention",
      repeat: { pattern: "0 3 * * *" },
      removeOnComplete: 30,
      removeOnFail: 100
    })
  ]);
}

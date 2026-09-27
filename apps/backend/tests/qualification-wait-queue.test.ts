import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { enqueueQualificationWait, qualificationWaitQueue } from "../src/queue/qualification-wait-queue.js";

const qualificationId = randomUUID();

async function jobsOfQualification() {
  const jobs = await qualificationWaitQueue.getJobs(["delayed", "waiting", "completed"], 0, 1_000);
  return jobs.filter((job) => job.data.qualificationId === qualificationId);
}

afterAll(async () => {
  await Promise.all((await jobsOfQualification()).map((job) => job.remove()));
  await qualificationWaitQueue.close();
});

describe("enqueueQualificationWait", () => {
  it("aceita id de etapa com ':' (BullMQ recusa jobId com ':' fora do formato de 3 partes)", async () => {
    await expect(enqueueQualificationWait(
      { tenantId: randomUUID(), qualificationId, stepId: "node:delay:1" },
      60_000
    )).resolves.toBeUndefined();
  });

  it("revisitar a mesma etapa de espera agenda uma nova retomada (não reaproveita o job antigo)", async () => {
    const tenantId = randomUUID();
    await enqueueQualificationWait({ tenantId, qualificationId, stepId: "wait-1" }, 60_000);
    await enqueueQualificationWait({ tenantId, qualificationId, stepId: "wait-1" }, 10 * 60_000);

    const delayed = (await jobsOfQualification()).filter((job) => job.data.stepId === "wait-1");
    expect(delayed).toHaveLength(2);
  });
});

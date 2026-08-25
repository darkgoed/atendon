import {
  isAiEvaluationEventJob,
  type AiEvaluationJob
} from "../../queue/ai-evaluation-queue.js";
import type { AiAttendanceEvaluator } from "./evaluator.js";
import type { EvaluationEventRepository } from "./evaluation-events.js";
import {
  EvaluatorCircuitOpenError,
  type EvaluatorCircuitBreaker
} from "./evaluator-circuit-breaker.js";

export class EvaluationEventProcessor {
  constructor(
    private readonly events: Pick<EvaluationEventRepository, "getPending" | "markCompleted">,
    private readonly evaluator: Pick<AiAttendanceEvaluator, "process">,
    private readonly circuitBreaker: Pick<
      EvaluatorCircuitBreaker,
      "assertAvailable" | "recordSuccess" | "recordFailure"
    >,
    private readonly onCircuitOpened: (tenantId: string) => Promise<void>,
    private readonly enabled = true
  ) {}

  async process(
    job: AiEvaluationJob
  ): Promise<"created" | "duplicate" | "ineligible" | "already_completed" | "disabled"> {
    // Keep persisted events pending while the global evaluator kill switch is off.
    // Marking them completed here would silently discard work that must resume later.
    if (!this.enabled) return "disabled";
    const event = isAiEvaluationEventJob(job)
      ? await this.events.getPending(job.eventId)
      : null;
    if (isAiEvaluationEventJob(job) && !event) return "already_completed";
    const directJob = event ?? job;
    if (isAiEvaluationEventJob(directJob)) throw new Error("Evaluation event could not be resolved");

    await this.circuitBreaker.assertAvailable(directJob.tenantId);
    try {
      const result = await this.evaluator.process(directJob);
      await this.circuitBreaker.recordSuccess(directJob.tenantId);
      if (event) await this.events.markCompleted(event.id);
      return result;
    } catch (error) {
      if (!(error instanceof EvaluatorCircuitOpenError)) {
        const circuit = await this.circuitBreaker.recordFailure(directJob.tenantId);
        if (circuit.opened) await this.onCircuitOpened(directJob.tenantId);
      }
      throw error;
    }
  }
}

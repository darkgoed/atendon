import type { MessageRepository } from "../messages/repository.js";
import type { AiFollowUpRepository } from "../messages/ai-follow-up.js";
import {
  recordReconcilerMetric,
  recordReconcilerOldestAge,
  type ReconcilerWorkflow
} from "./observability-metrics.js";

type EnqueueResult = "enqueued" | "deduplicated";

export interface ReconciliationResult {
  examined: number;
  enqueued: number;
  deduplicated: number;
  errors: number;
  oldestAgeMs: number;
}

export function reconciliationLogLevel(
  result: ReconciliationResult
): "debug" | "info" | "warn" {
  if (result.errors > 0) return "warn";
  if (result.examined > 0 || result.enqueued > 0 || result.deduplicated > 0) return "info";
  return "debug";
}

function emptyResult(): ReconciliationResult {
  return { examined: 0, enqueued: 0, deduplicated: 0, errors: 0, oldestAgeMs: 0 };
}

function record(workflow: ReconcilerWorkflow, result: ReconciliationResult): void {
  recordReconcilerMetric(workflow, "examined", result.examined);
  recordReconcilerMetric(workflow, "enqueued", result.enqueued);
  recordReconcilerMetric(workflow, "deduplicated", result.deduplicated);
  recordReconcilerMetric(workflow, "error", result.errors);
  recordReconcilerOldestAge(workflow, result.oldestAgeMs);
}

function addOutcome(result: ReconciliationResult, outcome: EnqueueResult): void {
  result[outcome === "enqueued" ? "enqueued" : "deduplicated"] += 1;
}

export async function reconcileHandoffNotifications(
  repository: Pick<MessageRepository, "findPendingHandoffNotificationPage">,
  enqueue: (id: string) => Promise<EnqueueResult>,
  pageSize = 100,
  maxPages = 10
): Promise<ReconciliationResult> {
  const result = emptyResult();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await repository.findPendingHandoffNotificationPage(pageSize, cursor);
    if (pageNumber === 0) result.oldestAgeMs = page.oldestAgeMs;
    result.examined += page.ids.length;
    for (const id of page.ids) {
      try {
        addOutcome(result, await enqueue(id));
      } catch {
        result.errors += 1;
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  record("handoff", result);
  return result;
}

export async function reconcileAiFollowUps(
  repository: Pick<AiFollowUpRepository, "findDuePage">,
  enqueue: (
    conversationId: string,
    event: { sequenceVersion: number; dueAt: Date }
  ) => Promise<EnqueueResult>,
  pageSize = 100,
  maxPages = 10
): Promise<ReconciliationResult> {
  const result = emptyResult();
  let cursor: { dueAt: Date; conversationId: string } | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await repository.findDuePage(pageSize, cursor);
    if (pageNumber === 0) result.oldestAgeMs = page.oldestAgeMs;
    result.examined += page.events.length;
    for (const event of page.events) {
      try {
        addOutcome(result, await enqueue(event.conversationId, {
          sequenceVersion: event.sequenceVersion,
          dueAt: event.dueAt
        }));
      } catch {
        result.errors += 1;
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  record("follow_up", result);
  return result;
}

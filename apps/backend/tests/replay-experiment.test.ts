import { describe, expect, it, vi } from "vitest";
import {
  compactReplayHistory,
  evaluateReplayExperiment,
  REPLAY_EXPERIMENT_VARIANTS,
  runReplayExperiment
} from "../src/modules/agent-improvement/replay-experiment.js";
import type { ReplayCaseOutcome } from "../src/modules/agent-improvement/replay.js";

const outcome: ReplayCaseOutcome = {
  caseId: "gold-1",
  severity: "critical",
  relatedToTarget: false,
  baselineScores: { correctness: 90 },
  candidateScores: { correctness: 90 },
  baselineOverall: 90,
  candidateOverall: 90,
  candidateHasCriticalFailure: false,
  unexpectedToolCalls: 0,
  missingTransactionalEvidence: false,
  passed: true
};

describe("IA-04 replay experiment", () => {
  it("compares 0.1/0.2 against 0.7 for legacy and compact prompts", () => {
    expect(REPLAY_EXPERIMENT_VARIANTS.map((item) => item.id)).toEqual([
      "legacy-t0.1", "compact-t0.1",
      "legacy-t0.2", "compact-t0.2",
      "legacy-t0.7", "compact-t0.7"
    ]);
  });

  it("selects compact only with >=30% p50 token reduction and existing gates passing", () => {
    const samples = REPLAY_EXPERIMENT_VARIANTS.flatMap((variant) => [1, 2, 3].map((index) => ({
      variantId: variant.id,
      inputTokens: variant.compactPrompt ? 600 + index : 1_000 + index,
      outputTokens: 50,
      costUsd: 0.01,
      outcome: { ...outcome, caseId: `${variant.id}-${index}` }
    })));
    const result = evaluateReplayExperiment(samples);
    expect(result.summaries.find((item) => item.id === "compact-t0.2")).toMatchObject({
      inputTokensP50: 602,
      eligible: true
    });
    expect(result.recommended?.id).toBe("compact-t0.1");
  });

  it("compacts only recent history and never rewrites facts", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `mensagem-${index}`
    }));
    expect(compactReplayHistory(history)).toEqual(history.slice(-12));
  });

  it("executes every case against all six variants through an injected replay callback", async () => {
    const execute = vi.fn(async (caseId: string, variant: typeof REPLAY_EXPERIMENT_VARIANTS[number]) => ({
      inputTokens: variant.compactPrompt ? 600 : 1_000,
      outputTokens: 50,
      costUsd: 0.01,
      outcome: { ...outcome, caseId }
    }));
    const result = await runReplayExperiment({ cases: ["case-a", "case-b"], execute });
    expect(execute).toHaveBeenCalledTimes(12);
    expect(result.summaries).toHaveLength(6);
  });
});

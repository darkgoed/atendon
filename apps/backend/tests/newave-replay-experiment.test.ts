import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNewaveReplayExperimentCli } from "../scripts/run-newave-replay-experiment.js";
import {
  NEWAVE_GOLD_CASES,
  NEWAVE_GOLD_SUITE_VERSION
} from "../src/modules/agent-improvement/newave-gold-suite.js";
import {
  captureNewaveGoldReplayExperimentFixtures,
  runNewaveGoldReplayExperiment,
  type NewaveReplayExperimentFixtureBundle
} from "../src/modules/agent-improvement/newave-replay-experiment.js";
import { REPLAY_EXPERIMENT_VARIANTS } from "../src/modules/agent-improvement/replay-experiment.js";

const linguisticScores = {
  correctness: 90,
  task_completion: 90,
  continuity: 90,
  communication: 90,
  security_privacy: 90,
  tool_usage: 90,
  handoff: 90
};

function fixtureBundle(): NewaveReplayExperimentFixtureBundle {
  return {
    suiteVersion: NEWAVE_GOLD_SUITE_VERSION,
    evidenceKind: "synthetic_test",
    samples: REPLAY_EXPERIMENT_VARIANTS.flatMap((variant) =>
      NEWAVE_GOLD_CASES.map((regressionCase, caseIndex) => {
        const evidence = regressionCase.expectedBehavior.deterministic.actionEvidence;
        const responseEvidence = evidence.type === "response" ? evidence.anyOf[0]! : "ok";
        return {
          caseKey: regressionCase.key,
          variantId: variant.id,
          inputTokens: variant.compactPrompt ? 600 + caseIndex % 3 : 1_000 + caseIndex % 3,
          outputTokens: 50,
          costUsd: 0.01,
          response: [
            responseEvidence,
            ...regressionCase.expectedBehavior.required
          ].join(" "),
          calls: regressionCase.expectedBehavior.simulatedTools.map((tool) => ({
            name: tool.name,
            arguments: tool.arguments ?? {},
            ...(tool.transactionalOutcome
              ? { transactionalOutcome: tool.transactionalOutcome }
              : {})
          })),
          linguisticScores,
          linguisticOverall: 90,
          hasCriticalFailure: false
        };
      })
    )
  };
}

describe("Newave IA-04 executable gold experiment", () => {
  it("executes the complete 0.1/0.2/0.7 × legacy/compact matrix and applies gates", () => {
    const report = runNewaveGoldReplayExperiment({
      fixtures: fixtureBundle(),
      generatedAt: new Date("2030-01-08T00:00:00.000Z")
    });
    expect(report.matrix).toEqual({
      temperatures: [0.1, 0.2, 0.7],
      promptModes: ["legacy", "compact"],
      caseCount: NEWAVE_GOLD_CASES.length,
      variantCount: 6,
      sampleCount: NEWAVE_GOLD_CASES.length * 6
    });
    expect(report.variants).toHaveLength(6);
    const compact = report.variants.find((variant) => variant.id === "compact-t0.2");
    expect(compact).toMatchObject({ gateStatus: "ready", eligible: false });
    expect(compact?.tokenReductionPercent).toBeCloseTo(40, 1);
    expect(report).toMatchObject({
      evidenceKind: "synthetic_test",
      promotionEligible: false,
      recommendedVariantId: null
    });
  });

  it("captures every gold case through an injected adapter without owning a model gateway", async () => {
    const source = fixtureBundle();
    const byKey = new Map(source.samples.map((sample) => [
      `${sample.caseKey}:${sample.variantId}`,
      sample
    ]));
    const execute = vi.fn(async (
      regressionCase: typeof NEWAVE_GOLD_CASES[number],
      variant: typeof REPLAY_EXPERIMENT_VARIANTS[number]
    ) => {
      const fixture = byKey.get(`${regressionCase.key}:${variant.id}`)!;
      return {
        inputTokens: fixture.inputTokens,
        outputTokens: fixture.outputTokens,
        costUsd: fixture.costUsd,
        response: fixture.response,
        calls: fixture.calls,
        linguisticScores: fixture.linguisticScores,
        linguisticOverall: fixture.linguisticOverall,
        hasCriticalFailure: fixture.hasCriticalFailure
      };
    });
    const captured = await captureNewaveGoldReplayExperimentFixtures({
      evidenceKind: "synthetic_test",
      execute
    });
    expect(execute).toHaveBeenCalledTimes(NEWAVE_GOLD_CASES.length * 6);
    expect(captured.samples).toHaveLength(NEWAVE_GOLD_CASES.length * 6);
  });

  it("rejects an incomplete comparison instead of silently evaluating a subset", () => {
    const fixtures = fixtureBundle();
    fixtures.samples.pop();
    expect(() => runNewaveGoldReplayExperiment({ fixtures })).toThrow(
      /Matriz IA-04 incompleta/
    );
  });

  it("recommends a variant only for a complete bundle explicitly marked as recorded replay", () => {
    const fixtures = fixtureBundle();
    fixtures.evidenceKind = "recorded_replay";
    const report = runNewaveGoldReplayExperiment({
      fixtures,
      generatedAt: new Date("2030-01-08T00:00:00.000Z")
    });
    expect(report.promotionEligible).toBe(true);
    expect(report.recommendedVariantId).toBe("compact-t0.1");
  });

  it("persists only a sanitized aggregate report through the offline CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atendon-ia04-"));
    const fixturesPath = join(directory, "fixtures.json");
    const reportPath = join(directory, "report.json");
    await writeFile(fixturesPath, JSON.stringify(fixtureBundle()), "utf8");
    await expect(runNewaveReplayExperimentCli([
      "--fixtures",
      fixturesPath,
      "--output",
      reportPath
    ])).resolves.toBe(reportPath);
    const persisted = await readFile(reportPath, "utf8");
    const report = JSON.parse(persisted) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: "newave-replay-experiment-report-v1",
      executionMode: "offline_fixture_evaluator",
      evidenceKind: "synthetic_test",
      promotionEligible: false,
      recommendedVariantId: null
    });
    expect(persisted).not.toMatch(
      /"(?:response|targetMessage|history|toolCalls|apiKey|systemPrompt)"|@example\.com|\+?55\d{10,}/i
    );
  });
});

import {
  validateDeterministicReplay,
  type DeterministicReplayCall
} from "./deterministic-replay-validator.js";
import {
  NEWAVE_GOLD_CASES,
  NEWAVE_GOLD_SUITE_VERSION
} from "./newave-gold-suite.js";
import {
  evaluateReplayExperiment,
  REPLAY_EXPERIMENT_VARIANTS,
  REPLAY_TEMPERATURES,
  type ReplayExperimentSample
} from "./replay-experiment.js";
import type { QualityScores, ReplayCaseOutcome } from "./replay.js";

export interface NewaveReplayExperimentFixture {
  caseKey: string;
  variantId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  response: string;
  calls: DeterministicReplayCall[];
  linguisticScores: QualityScores;
  linguisticOverall: number;
  hasCriticalFailure: boolean;
}

export interface NewaveReplayExperimentFixtureBundle {
  suiteVersion: string;
  evidenceKind: "recorded_replay" | "synthetic_test";
  samples: NewaveReplayExperimentFixture[];
}

export interface SanitizedNewaveReplayExperimentReport {
  schemaVersion: "newave-replay-experiment-report-v1";
  suiteVersion: string;
  generatedAt: string;
  executionMode: "offline_fixture_evaluator";
  evidenceKind: NewaveReplayExperimentFixtureBundle["evidenceKind"];
  promotionEligible: boolean;
  matrix: {
    temperatures: readonly number[];
    promptModes: readonly ["legacy", "compact"];
    caseCount: number;
    variantCount: number;
    sampleCount: number;
  };
  baselineVariantId: string;
  variants: Array<{
    id: string;
    temperature: number;
    promptMode: "legacy" | "compact";
    inputTokensP50: number;
    tokenReductionPercent: number;
    gateStatus: "ready" | "test_failed";
    gateReasons: string[];
    gateMetrics: ReturnType<typeof evaluateReplayExperiment>["summaries"][number]["gates"]["metrics"];
    eligible: boolean;
  }>;
  recommendedVariantId: string | null;
}

const PROMPT_MODES = ["legacy", "compact"] as const;
const VARIANT_IDS = new Set(REPLAY_EXPERIMENT_VARIANTS.map((variant) => variant.id));
const GOLD_CASE_KEYS = new Set(NEWAVE_GOLD_CASES.map((item) => item.key));

function finiteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Fixture IA-04 inválida: ${field} deve ser finito e não negativo`);
  }
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase("pt-BR");
}

function passesTextCriteria(
  response: string,
  expected: { required: readonly string[]; forbidden: readonly string[] }
): boolean {
  const normalized = normalizedText(response);
  return expected.required.every((item) => normalized.includes(normalizedText(item)))
    && expected.forbidden.every((item) => !normalized.includes(normalizedText(item)));
}

function fixtureIndex(bundle: NewaveReplayExperimentFixtureBundle) {
  if (bundle.suiteVersion !== NEWAVE_GOLD_SUITE_VERSION) {
    throw new Error("Fixture IA-04 pertence a outra versão da suíte gold");
  }
  const index = new Map<string, NewaveReplayExperimentFixture>();
  for (const sample of bundle.samples) {
    if (!GOLD_CASE_KEYS.has(sample.caseKey)) {
      throw new Error(`Fixture IA-04 contém caso desconhecido: ${sample.caseKey}`);
    }
    if (!VARIANT_IDS.has(sample.variantId)) {
      throw new Error(`Fixture IA-04 contém variante desconhecida: ${sample.variantId}`);
    }
    finiteNonNegative(sample.inputTokens, "inputTokens");
    finiteNonNegative(sample.outputTokens, "outputTokens");
    finiteNonNegative(sample.costUsd, "costUsd");
    finiteNonNegative(sample.linguisticOverall, "linguisticOverall");
    const key = `${sample.caseKey}:${sample.variantId}`;
    if (index.has(key)) throw new Error(`Fixture IA-04 duplicada: ${key}`);
    index.set(key, sample);
  }
  const expectedCount = NEWAVE_GOLD_CASES.length * REPLAY_EXPERIMENT_VARIANTS.length;
  if (index.size !== expectedCount) {
    throw new Error(`Matriz IA-04 incompleta: esperados ${expectedCount}, recebidos ${index.size}`);
  }
  return index;
}

/**
 * Executes the complete gold matrix through an injected adapter. This module never owns
 * a model/API gateway. Only measurements captured from an authorized replay adapter may
 * use `recorded_replay`; synthetic fixtures are useful for tests but never promotion-eligible.
 */
export async function captureNewaveGoldReplayExperimentFixtures(input: {
  evidenceKind: NewaveReplayExperimentFixtureBundle["evidenceKind"];
  execute: (
    regressionCase: typeof NEWAVE_GOLD_CASES[number],
    variant: typeof REPLAY_EXPERIMENT_VARIANTS[number]
  ) => Promise<Omit<NewaveReplayExperimentFixture, "caseKey" | "variantId">>;
}): Promise<NewaveReplayExperimentFixtureBundle> {
  const samples: NewaveReplayExperimentFixture[] = [];
  for (const variant of REPLAY_EXPERIMENT_VARIANTS) {
    for (const regressionCase of NEWAVE_GOLD_CASES) {
      samples.push({
        caseKey: regressionCase.key,
        variantId: variant.id,
        ...await input.execute(regressionCase, variant)
      });
    }
  }
  return {
    suiteVersion: NEWAVE_GOLD_SUITE_VERSION,
    evidenceKind: input.evidenceKind,
    samples
  };
}

function deterministicOutcome(
  fixture: NewaveReplayExperimentFixture,
  baseline: NewaveReplayExperimentFixture,
  regressionCase: typeof NEWAVE_GOLD_CASES[number]
): ReplayCaseOutcome {
  const deterministic = validateDeterministicReplay({
    severity: regressionCase.severity,
    expectation: regressionCase.expectedBehavior.deterministic,
    response: fixture.response,
    calls: fixture.calls
  });
  const unexpectedToolCalls = deterministic.violations.filter((violation) =>
    violation.code === "TOOL_CALL_COUNT_MISMATCH"
    || violation.code === "TOOL_ACTION_MISMATCH"
  ).length;
  const missingTransactionalEvidence = deterministic.violations.some((violation) =>
    violation.code === "CLAIM_SET_MISMATCH"
  );
  const passed = fixture.response.trim().length > 0
    && !fixture.hasCriticalFailure
    && deterministic.passed
    && passesTextCriteria(fixture.response, regressionCase.expectedBehavior);
  return {
    caseId: regressionCase.key,
    severity: regressionCase.severity,
    relatedToTarget: false,
    baselineScores: baseline.linguisticScores,
    candidateScores: fixture.linguisticScores,
    baselineOverall: baseline.linguisticOverall,
    candidateOverall: fixture.linguisticOverall,
    candidateHasCriticalFailure: fixture.hasCriticalFailure,
    unexpectedToolCalls,
    missingTransactionalEvidence,
    deterministicFailures: deterministic.violations.length,
    passed
  };
}

/**
 * Validates an offline fixture matrix and emits aggregate data only. Raw responses, prompts,
 * histories, calls and credentials are intentionally excluded from the persistable report.
 */
export function runNewaveGoldReplayExperiment(input: {
  fixtures: NewaveReplayExperimentFixtureBundle;
  generatedAt?: Date;
}): SanitizedNewaveReplayExperimentReport {
  const fixtures = fixtureIndex(input.fixtures);
  const samples: ReplayExperimentSample[] = [];
  for (const variant of REPLAY_EXPERIMENT_VARIANTS) {
    for (const regressionCase of NEWAVE_GOLD_CASES) {
      const fixture = fixtures.get(`${regressionCase.key}:${variant.id}`)!;
      const baseline = fixtures.get(`${regressionCase.key}:legacy-t0.7`)!;
      samples.push({
        variantId: variant.id,
        inputTokens: fixture.inputTokens,
        outputTokens: fixture.outputTokens,
        costUsd: fixture.costUsd,
        outcome: deterministicOutcome(fixture, baseline, regressionCase)
      });
    }
  }
  const result = evaluateReplayExperiment(samples);
  const promotionEligible = input.fixtures.evidenceKind === "recorded_replay";
  return {
    schemaVersion: "newave-replay-experiment-report-v1",
    suiteVersion: NEWAVE_GOLD_SUITE_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    executionMode: "offline_fixture_evaluator",
    evidenceKind: input.fixtures.evidenceKind,
    promotionEligible,
    matrix: {
      temperatures: REPLAY_TEMPERATURES,
      promptModes: PROMPT_MODES,
      caseCount: NEWAVE_GOLD_CASES.length,
      variantCount: REPLAY_EXPERIMENT_VARIANTS.length,
      sampleCount: samples.length
    },
    baselineVariantId: result.baselineVariantId,
    variants: result.summaries.map((summary) => ({
      id: summary.id,
      temperature: summary.temperature,
      promptMode: summary.compactPrompt ? "compact" : "legacy",
      inputTokensP50: summary.inputTokensP50,
      tokenReductionPercent: summary.tokenReductionPercent,
      gateStatus: summary.gates.status,
      gateReasons: summary.gates.reasons,
      gateMetrics: summary.gates.metrics,
      eligible: promotionEligible && summary.eligible
    })),
    recommendedVariantId: promotionEligible ? result.recommended?.id ?? null : null
  };
}

export function serializeNewaveReplayExperimentReport(
  report: SanitizedNewaveReplayExperimentReport
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

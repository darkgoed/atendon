import { evaluateReplayGates, type ReplayCaseOutcome } from "./replay.js";

export const REPLAY_TEMPERATURES = [0.1, 0.2, 0.7] as const;

export interface ReplayExperimentVariant {
  id: string;
  temperature: typeof REPLAY_TEMPERATURES[number];
  compactPrompt: boolean;
}

export const REPLAY_EXPERIMENT_VARIANTS: readonly ReplayExperimentVariant[] =
  REPLAY_TEMPERATURES.flatMap((temperature) => [
    { id: `legacy-t${temperature}`, temperature, compactPrompt: false },
    { id: `compact-t${temperature}`, temperature, compactPrompt: true }
  ]);

export interface ReplayExperimentSample {
  variantId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: ReplayCaseOutcome;
}

export async function runReplayExperiment<TCase>(input: {
  cases: readonly TCase[];
  execute: (
    regressionCase: TCase,
    variant: ReplayExperimentVariant
  ) => Promise<Omit<ReplayExperimentSample, "variantId">>;
}) {
  const samples: ReplayExperimentSample[] = [];
  for (const variant of REPLAY_EXPERIMENT_VARIANTS) {
    for (const regressionCase of input.cases) {
      samples.push({
        variantId: variant.id,
        ...await input.execute(regressionCase, variant)
      });
    }
  }
  return evaluateReplayExperiment(samples);
}

function percentile50(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function compactReplayHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  recentMessages = 12
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.slice(-recentMessages);
}

export function evaluateReplayExperiment(samples: readonly ReplayExperimentSample[]) {
  const summaries = REPLAY_EXPERIMENT_VARIANTS.map((variant) => {
    const variantSamples = samples.filter((sample) => sample.variantId === variant.id);
    const baselineSamples = samples.filter((sample) => sample.variantId === "legacy-t0.7");
    const inputTokensP50 = percentile50(variantSamples.map((sample) => sample.inputTokens));
    const baselineInputTokensP50 = percentile50(baselineSamples.map((sample) => sample.inputTokens));
    const tokenReductionPercent = baselineInputTokensP50 > 0
      ? ((baselineInputTokensP50 - inputTokensP50) / baselineInputTokensP50) * 100
      : 0;
    const gates = evaluateReplayGates({
      cases: variantSamples.map((sample) => sample.outcome),
      targetDimensions: [],
      baselineCostPerResponse: baselineSamples.length
        ? baselineSamples.reduce((sum, sample) => sum + sample.costUsd, 0) / baselineSamples.length
        : 0,
      candidateCostPerResponse: variantSamples.length
        ? variantSamples.reduce((sum, sample) => sum + sample.costUsd, 0) / variantSamples.length
        : 0
    });
    return {
      ...variant,
      inputTokensP50,
      tokenReductionPercent,
      gates,
      eligible: variantSamples.length > 0
        && gates.status === "ready"
        && (!variant.compactPrompt || tokenReductionPercent >= 30)
    };
  });
  return {
    baselineVariantId: "legacy-t0.7",
    summaries,
    recommended: summaries
      .filter((summary) => summary.eligible)
      .sort((left, right) =>
        left.inputTokensP50 - right.inputTokensP50
        || left.temperature - right.temperature
      )[0]
  };
}

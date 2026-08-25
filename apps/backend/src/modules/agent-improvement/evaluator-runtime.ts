import type { AppConfig } from "../../config.js";

export type DedicatedEvaluatorRuntime = {
  apiKey: string;
  model: string;
};

export function dedicatedEvaluatorRuntime(config: AppConfig): DedicatedEvaluatorRuntime | undefined {
  if (!config.CHANGELOG_OPENROUTER_API_KEY) return undefined;
  return {
    apiKey: config.CHANGELOG_OPENROUTER_API_KEY,
    model: config.CHANGELOG_OPENROUTER_MODEL
  };
}

import { z } from "zod";
import type { AppConfig } from "../../config.js";

const creditsResponseSchema = z.object({
  data: z.object({
    total_credits: z.number().finite().nonnegative(),
    total_usage: z.number().finite().nonnegative()
  })
});

export type OpenRouterCreditBalance = {
  totalCredits: number;
  totalUsage: number;
  balance: number;
};

type CreditsConfig = Pick<
  AppConfig,
  "OPENROUTER_BASE_URL" | "OPENROUTER_MANAGEMENT_API_KEY" | "OPENROUTER_TIMEOUT_MS"
>;

export async function fetchOpenRouterCreditBalance(
  config: CreditsConfig,
  fetcher: typeof fetch = fetch
): Promise<OpenRouterCreditBalance> {
  if (!config.OPENROUTER_MANAGEMENT_API_KEY) {
    throw new Error("OpenRouter management API key is not configured");
  }

  const response = await fetcher(`${config.OPENROUTER_BASE_URL}/credits`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.OPENROUTER_MANAGEMENT_API_KEY}`
    },
    signal: AbortSignal.timeout(config.OPENROUTER_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter credits request failed (${response.status})`);
  }

  const parsed = creditsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("OpenRouter returned an invalid credits response");
  }

  const totalCredits = parsed.data.data.total_credits;
  const totalUsage = parsed.data.data.total_usage;
  return {
    totalCredits,
    totalUsage,
    balance: totalCredits - totalUsage
  };
}

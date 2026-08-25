import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterCreditBalance } from "../src/modules/usage/openrouter-credits.js";

const config = {
  OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
  OPENROUTER_MANAGEMENT_API_KEY: "management-secret-key",
  OPENROUTER_TIMEOUT_MS: 5_000
};

describe("OpenRouter credit balance", () => {
  it("returns purchased credits, usage, and the remaining balance", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      data: { total_credits: 10.5, total_usage: 8.25 }
    }));

    await expect(fetchOpenRouterCreditBalance(config, fetcher)).resolves.toEqual({
      totalCredits: 10.5,
      totalUsage: 8.25,
      balance: 2.25
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer management-secret-key" }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("rejects missing credentials, provider errors, and invalid payloads", async () => {
    await expect(fetchOpenRouterCreditBalance(
      { ...config, OPENROUTER_MANAGEMENT_API_KEY: undefined },
      vi.fn()
    )).rejects.toThrow("not configured");

    await expect(fetchOpenRouterCreditBalance(
      config,
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }))
    )).rejects.toThrow("(403)");

    await expect(fetchOpenRouterCreditBalance(
      config,
      vi.fn().mockResolvedValue(Response.json({ data: { total_credits: "10", total_usage: 2 } }))
    )).rejects.toThrow("invalid credits response");
  });
});

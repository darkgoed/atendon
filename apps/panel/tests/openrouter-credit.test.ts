import { describe, expect, it } from "vitest";
import { openRouterCreditLevel } from "../lib/openrouter-credit";

describe("OpenRouter credit alerts", () => {
  it("uses the requested exact thresholds", () => {
    expect(openRouterCreditLevel(3)).toBe("healthy");
    expect(openRouterCreditLevel(2.99)).toBe("warning");
    expect(openRouterCreditLevel(1)).toBe("warning");
    expect(openRouterCreditLevel(0.99)).toBe("critical");
    expect(openRouterCreditLevel(0)).toBe("critical");
  });
});

export type OpenRouterCreditLevel = "healthy" | "warning" | "critical";

export function openRouterCreditLevel(balance: number): OpenRouterCreditLevel {
  if (balance < 1) return "critical";
  if (balance < 3) return "warning";
  return "healthy";
}

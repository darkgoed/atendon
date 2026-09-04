// @vitest-environment jsdom

import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi, afterEach } from "vitest";
import { EntitlementsProvider, useFeature } from "@/lib/entitlements";
import { translatePlanError } from "@/lib/plan-errors";

const isolatedWrapper = ({ children }: { children: React.ReactNode }) => React.createElement(SWRConfig, { value: { provider: () => new Map() } }, React.createElement(EntitlementsProvider, null, children));

describe("entitlements", () => {
  afterEach(() => vi.restoreAllMocks());

  it("useFeature devolve false para ausente e true para presente", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ features: { AGENDA: true } }), { headers: { "content-type": "application/json" } }));
    const { result, rerender } = renderHook(({ key }: { key: string }) => useFeature(key), { initialProps: { key: "AGENDA" }, wrapper: isolatedWrapper });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ key: "MISSING" });
    expect(result.current).toBe(false);
  });

  it("traduz limites sem vazar o código técnico", () => {
    const message = translatePlanError({ code: "PLAN_LIMIT_REACHED", details: { limit: "MAX_USERS", current: 8, max: 8, planName: "Médio" } });
    expect(message).toContain("8 usuários"); expect(message).toContain("Uso: 8/8"); expect(message).not.toContain("PLAN_LIMIT_REACHED");
  });

  it("traduz feature indisponível citando os planos", () => {
    expect(translatePlanError({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlans: ["Médio", "Pro"] } })).toContain("Médio, Pro");
  });

  it("falha de rede mantém o frontend fail-open", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    const { result } = renderHook(() => useFeature("ANY_FEATURE"), { wrapper: isolatedWrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

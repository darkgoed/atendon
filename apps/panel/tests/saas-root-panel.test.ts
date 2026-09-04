import { describe, expect, it } from "vitest";
import { canAccessManifestItem, findPanelManifestItem } from "../lib/panel-manifest";
import { duplicatePlanPayload, formatUsage, normalizePlan, reaisToCents, type Plan } from "../lib/saas-plans";
import { readFileSync } from "node:fs";

const planFixture = { id: "1", code: "BASIC", name: "Básico", monthly_price_cents: "49700", status: "active", is_internal: false, features: [{ feature_key: "ai", enabled: true }], limits: [{ limit_key: "users", limit_value: "3" }, { limit_key: "wa", limit_value: null }] } satisfies Plan;
const session = (isRoot: boolean, rootWorkspaceAccess?: boolean) => ({ user: { id: "u", email: "x", isRoot, name: null }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root" as const, rootWorkspaceAccess });

describe("ROOT SaaS panel", () => {
  it("discovers a ROOT menu route without commercial capability", () => {
    const item = findPanelManifestItem("/root/saas/planos/editar");
    expect(item).toMatchObject({ href: "/root/saas/planos", rootOnly: true, menu: true });
    expect(item?.capability).toBeUndefined();
    expect(canAccessManifestItem(session(true), item!)).toBe(true);
    expect(canAccessManifestItem(session(false), item!)).toBe(false);
  });
  it("normalizes real API arrays, prices, fields and unlimited usage", () => {
    const normalized = normalizePlan(planFixture);
    expect(normalized.features).toEqual({ ai: true });
    expect(normalized.limits).toEqual({ users: 3, wa: null });
    expect(normalized.monthlyPriceCents).toBe(49700);
    expect(normalized.billingPeriodMonths).toBe(1);
    expect(formatUsage({ used: 2, limit: null })).toBe("2 / Ilimitado");
    expect(reaisToCents("49,70".replace(",", "."))).toBe(4970);
  });
  it("omits an empty duplicate name and trims a filled one", () => {
    expect(duplicatePlanPayload(" NEW_CODE ", "   ")).toEqual({ code: "NEW_CODE" });
    expect(duplicatePlanPayload("NEW_CODE", "  Novo nome  ")).toEqual({ code: "NEW_CODE", name: "Novo nome" });
  });
  it("uses real usage and history fields and real plan endpoints", () => {
    const source = readFileSync(new URL("../app/root/saas/planos/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("MAX_USERS");
    expect(source).toContain("MAX_WHATSAPP_CONNECTIONS");
    expect(source).toContain("MAX_AI_INTERACTIONS");
    expect(source).toContain('useSWR<{ events: Event[] }>(root ? "/root/saas/events" : null, fetcher)');
    expect(source).toContain("eventsData.events");
    expect(source).not.toContain("subscription_events");
    expect(source).toContain("event_type");
    expect(source).toContain('"/root/saas/plans"');
    expect(source).toContain("/archive");
    expect(source).toContain("/duplicate");
    expect(source).not.toContain("/root/saas/plans/${selected.id || \"\"}");
  });
  it("contains tenant subscription controls and no workspace gate", () => {
    const source = readFileSync(new URL("../app/root/saas/planos/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("/root/saas/tenants");
    expect(source).toContain("/subscription");
    expect(source).toContain("suspend");
    expect(source).toContain("reactivate");
    expect(source).toContain("cancel");
    expect(source).not.toContain("canAccessRootWorkspace");
  });
});

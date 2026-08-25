import { describe, expect, it } from "vitest";
import {
  buildOperationalChecklist,
  isOnboardingCollapsed,
  onboardingStorageKey,
  summarizeOperationalChecklist,
  type OperationalChecklistAccess,
  type OperationalChecklistReality
} from "../lib/onboarding";

const fullAccess: OperationalChecklistAccess = {
  connection: true,
  connectionManage: true,
  agent: true,
  agentManage: true,
  catalog: true,
  catalogPage: true,
  catalogManage: true
};

const readyReality: OperationalChecklistReality = {
  connectionStatus: "connected",
  agentActive: true,
  catalog: { status: "ready", categories: 2, units: 1 }
};

describe("operational onboarding checklist", () => {
  it("derives completion exclusively from real operational state", () => {
    const steps = buildOperationalChecklist(fullAccess, readyReality);

    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ["connection", "complete"],
      ["agent", "complete"],
      ["catalog", "complete"]
    ]);
    expect(summarizeOperationalChecklist(steps)).toEqual({ complete: 3, pending: 0, unknown: 0, total: 3 });
  });

  it("omits unavailable pages and never exposes their CTAs", () => {
    const steps = buildOperationalChecklist(
      { ...fullAccess, agent: false, agentManage: false, catalog: false, catalogManage: false },
      readyReality
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: "connection", href: "/conexao" });
  });

  it("checks category and unit readiness without requiring partner access", () => {
    const steps = buildOperationalChecklist(
      { ...fullAccess, catalogPage: false, catalogManage: false },
      readyReality
    );
    const catalog = steps.find((step) => step.id === "catalog");

    expect(catalog).toMatchObject({ status: "complete" });
    expect(catalog?.href).toBeUndefined();
    expect(catalog?.actionLabel).toBeUndefined();
  });

  it("distinguishes an unverifiable catalog from an empty catalog", () => {
    const failed = buildOperationalChecklist(fullAccess, {
      ...readyReality,
      catalog: { status: "error", categories: 0, units: 0 }
    });
    const empty = buildOperationalChecklist(fullAccess, {
      ...readyReality,
      catalog: { status: "ready", categories: 0, units: 0 }
    });

    expect(failed.find((step) => step.id === "catalog")?.status).toBe("unknown");
    expect(empty.find((step) => step.id === "catalog")?.status).toBe("pending");
  });

  it("scopes the collapsed preference by user and workspace", () => {
    expect(onboardingStorageKey("user-1", "workspace-a")).not.toBe(onboardingStorageKey("user-1", "workspace-b"));
    expect(onboardingStorageKey("user-1", "workspace-a")).not.toBe(onboardingStorageKey("user-2", "workspace-a"));
    expect(isOnboardingCollapsed("collapsed")).toBe(true);
    expect(isOnboardingCollapsed("expanded")).toBe(false);
    expect(isOnboardingCollapsed(null)).toBe(false);
  });
});

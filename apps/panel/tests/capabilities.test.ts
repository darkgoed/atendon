import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { capabilitiesCacheKey, type EffectiveCapability } from "../lib/capabilities";
import {
  canExposeManifestItem,
  capabilityKeys,
  findPanelManifestItem,
  firstEnabledModulePath,
  panelManifest
} from "../lib/panel-manifest";
import { capabilityCascadeImpact, capabilityOverrideValue, parseCapabilityOverride } from "../lib/root-capabilities";
import type { PanelSession } from "../lib/session";

const session: PanelSession = {
  user: { id: "user-a", email: "operacao@example.test", isRoot: false, name: "Iara Campos" },
  activeWorkspace: { id: "tenant-a", name: "Operação Boreal", slug: "operacao-boreal", status: "active", role: "OWNER" },
  workspaces: [],
  permissions: ["dashboard.read", "conversations.read", "leads.read", "appointments.read", "post_sales.use", "tripz_ai.use"],
  actorScope: "workspace"
};

const capability = (key: EffectiveCapability["key"], input: Partial<EffectiveCapability> = {}): EffectiveCapability => ({
  key,
  displayName: key,
  description: key,
  kind: "capability",
  tenantConfigurable: true,
  availabilityMode: "all",
  uiOrder: 10,
  dependencies: [],
  supported: true,
  tenantOverride: null,
  enabled: false,
  source: "default",
  blockedBy: [],
  ...input
});

let guardSource = "";
let providerSource = "";
let shellSource = "";
let rootSource = "";
let conversationsSource = "";

beforeAll(async () => {
  [guardSource, providerSource, shellSource, rootSource, conversationsSource] = await Promise.all([
    readFile(new URL("../components/panel-access-guard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/capabilities.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/root/workspaces/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8")
  ]);
});

describe("panel capability manifest", () => {
  it("owns every configurable top-level route and keeps core routes outside toggles", () => {
    const manifestedCapabilities = new Set(panelManifest.flatMap((item) => item.capability ? [item.capability] : []));
    expect([...manifestedCapabilities].sort()).toEqual([...capabilityKeys].sort());
    expect(findPanelManifestItem("/conversas/abc")?.capability).toBeUndefined();
    expect(findPanelManifestItem("/perfil")?.capability).toBeUndefined();
    expect(findPanelManifestItem("/alterar-senha")?.capability).toBeUndefined();
    expect(findPanelManifestItem("/root/workspaces")?.capability).toBeUndefined();
    const billing = findPanelManifestItem("/uso");
    expect(billing?.label).toBe("Uso e cobrança");
    expect(billing?.capability).toBeUndefined();
    expect(billing?.requiredPermissions).toEqual(["usage.read"]);
  });

  it("matches direct and nested URLs without slug-based decisions", () => {
    expect(findPanelManifestItem("/leads/pipeline")?.capability).toBe("pipeline_v1");
    expect(findPanelManifestItem("/leads/lead-7")?.capability).toBe("leads_v1");
    expect(findPanelManifestItem("/pos-venda/configurar")?.capability).toBe("post_sales_v1");
    const removedAgentRoute = ["/agente/", "melhorias"].join("");
    expect(panelManifest.some((item) => item.href === removedAgentRoute)).toBe(false);
    expect(JSON.stringify(panelManifest)).not.toMatch(/tripz.*slug|slug.*tripz/i);
  });

  it("hides Follow-ups when the active plan does not include AI follow-up", () => {
    const followUps = findPanelManifestItem("/follow-ups");
    const rootWorkspaceSession: PanelSession = {
      ...session,
      user: { ...session.user, isRoot: true },
      actorScope: "root",
      rootWorkspaceAccess: true
    };
    expect(followUps?.requiredFeature).toBe("AI_FOLLOWUP");
    expect(canExposeManifestItem(rootWorkspaceSession, followUps!, () => true, () => false)).toBe(false);
    expect(canExposeManifestItem(rootWorkspaceSession, followUps!, () => true, (key) => key === "AI_FOLLOWUP")).toBe(true);
  });

  it("falls back from home to the first accessible enabled module", () => {
    expect(firstEnabledModulePath(session, () => false)).toBe("/conversas");
    expect(firstEnabledModulePath(session, (key) => key === "dashboard_v1")).toBe("/");
  });
});

describe("tenant capability state", () => {
  it("uses a cache key that isolates tenants", () => {
    expect(capabilitiesCacheKey("tenant-a")).toEqual(["tenant-capabilities", "tenant-a"]);
    expect(capabilitiesCacheKey("tenant-b")).toEqual(["tenant-capabilities", "tenant-b"]);
    expect(capabilitiesCacheKey("tenant-a")).not.toEqual(capabilitiesCacheKey("tenant-b"));
    expect(capabilitiesCacheKey(undefined)).toBeNull();
  });

  it("declares explicit loading, error, retry and fail-closed behavior", () => {
    expect(providerSource).toContain("isLoading:");
    expect(providerSource).toContain("error:");
    expect(providerSource).toContain("retry:");
    expect(providerSource).toContain("?.enabled === true");
    expect(providerSource).toContain("shouldRetryOnError: false");
    expect(guardSource).toContain("Funcionalidade indisponível para esta empresa");
    expect(guardSource).toContain('href="/conversas"');
    expect(shellSource).toContain("Conversas permanece acessível");
  });
});

describe("ROOT capability editor", () => {
  it("models inherit/on/off and both dependency directions", () => {
    const catalog = [
      capability("leads_v1"),
      capability("pipeline_v1", { enabled: true, tenantOverride: true, dependencies: ["leads_v1"] }),
      capability("appointments_v1", { enabled: true, dependencies: ["leads_v1"] })
    ];
    expect(capabilityCascadeImpact(catalog, "pipeline_v1", true)).toEqual(["leads_v1"]);
    expect(new Set(capabilityCascadeImpact(catalog, "leads_v1", false))).toEqual(new Set(["pipeline_v1", "appointments_v1"]));
    expect(capabilityOverrideValue(catalog[0])).toBe("inherit");
    expect(parseCapabilityOverride("on")).toBe(true);
    expect(parseCapabilityOverride("off")).toBe(false);
    expect(parseCapabilityOverride("inherit")).toBeNull();
  });

  it("uses the generic API, real template preview and no company slug condition", () => {
    expect(rootSource).toContain("capabilityTemplateTenantId: templateTenantId");
    expect(rootSource).toContain("`/root/workspaces/${templateTenantId}/capabilities`");
    expect(rootSource).toContain("confirmCascade");
    expect(rootSource).toContain("Não provisionada");
    expect(rootSource).not.toMatch(/slug\.(includes|startsWith)|slug\s*===.*tripz/i);
  });

  it("removes indirect lead and agenda surfaces from Conversations", () => {
    expect(conversationsSource).toContain('isEnabled("leads_v1")');
    expect(conversationsSource).toContain('isEnabled("appointments_v1")');
    expect(conversationsSource).toContain("appointmentsEnabled && canCreateAppointment");
    expect(conversationsSource).toContain("leadsEnabled && thread.conversation.lead_id");
  });
});

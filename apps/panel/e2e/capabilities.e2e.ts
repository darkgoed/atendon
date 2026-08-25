import { expect, test, type Page, type Route } from "@playwright/test";

const tenantA = { id: "tenant-cap-a", name: "Operação Boreal", slug: "operacao-boreal", status: "active", role: "OWNER" };
const tenantB = { id: "tenant-cap-b", name: "Operação Cedro", slug: "operacao-cedro", status: "active", role: "OWNER" };
const capabilityKeys = ["dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1", "post_sales_v1", "tripz_ai_v1", "workspace_admin_v1"] as const;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const capability = (key: (typeof capabilityKeys)[number], enabled: boolean) => ({
  key,
  displayName: key,
  description: key,
  kind: "capability",
  tenantConfigurable: true,
  availabilityMode: key === "tripz_ai_v1" ? "provisioned" : "all",
  uiOrder: capabilityKeys.indexOf(key) * 10,
  dependencies: key === "pipeline_v1" || key === "appointments_v1" ? ["leads_v1"] : [],
  supported: key !== "tripz_ai_v1",
  tenantOverride: enabled,
  enabled,
  source: "tenant_override",
  blockedBy: []
});

function session(activeId: string) {
  const activeWorkspace = activeId === tenantA.id ? tenantA : tenantB;
  return {
    user: { id: "cap-user", email: "iara@example.test", isRoot: false, name: "Iara Campos" },
    activeWorkspace,
    workspaces: [tenantA, tenantB],
    permissions: ["dashboard.read", "conversations.read", "leads.read", "appointments.read", "post_sales.use", "connection.read", "members.read", "audit.read", "units.read"],
    actorScope: "workspace"
  };
}

async function installFixture(page: Page, options: { catalogError?: boolean } = {}) {
  await page.addInitScript(() => {
    window.localStorage.setItem("atendon_last_seen_version", "capabilities-e2e");
  });
  let activeId = tenantA.id;
  const capabilityTenants: string[] = [];
  const requestedPaths: string[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/(?:api|backend)/, "");
    requestedPaths.push(path);
    if (path === "/me") return json(route, session(activeId));
    if (path === "/capabilities") {
      capabilityTenants.push(activeId);
      if (options.catalogError) return json(route, { error: "catálogo indisponível" }, 503);
      const enabled = activeId === tenantA.id;
      return json(route, { capabilities: capabilityKeys.map((key) => capability(key, enabled)) });
    }
    if (path === "/workspaces/switch" && request.method() === "POST") {
      activeId = request.postDataJSON().workspaceId;
      return json(route, session(activeId));
    }
    if (path === "/panel/version") return json(route, { version: "capabilities-e2e", changelog: [] });
    if (path === "/feature-flags") return json(route, { flags: {} });
    if (path === "/me/notification-preferences") return json(route, {
      preferences: { enabled: false, sound_enabled: false, visual_enabled: false },
      muted_conversations: []
    });
    if (path === "/conversations/unread") return json(route, { conversations: [] });
    if (path === "/events") return route.fulfill({ status: 204, body: "" });
    if (path === "/dashboard") return json(route, { counts: { handoff: 0 } });
    if (path === "/scheduling/config/attendants") return json(route, { attendants: [], member_ids: [] });
    return json(route, {});
  };
  await page.route("**/api/**", handler);
  await page.route("**/backend/**", handler);
  return { capabilityTenants, requestedPaths };
}

test("switching tenants replaces every capability-driven navigation surface", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/perfil");
  await expect(page.getByRole("heading", { name: "Perfil" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Agenda" })).toBeVisible();

  await page.locator(".workspace-switcher__select").selectOption(tenantB.id);
  await expect(page.getByRole("heading", { name: "Perfil" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Agenda" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Conversas" })).toBeVisible();
  expect(state.capabilityTenants).toEqual(expect.arrayContaining([tenantA.id, tenantB.id]));
});

test("a direct disabled URL fails closed without mounting the module", async ({ page }) => {
  const state = await installFixture(page, { catalogError: true });
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Funcionalidade indisponível para esta empresa" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Voltar para Conversas" })).toBeVisible();
  expect(state.requestedPaths.some((path) => path.startsWith("/scheduling/appointments"))).toBe(false);
});

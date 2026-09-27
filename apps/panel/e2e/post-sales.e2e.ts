import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
] as const;

const member = { id: "member-1", user_id: "user-1", name: "Ana Operadora", email: "ana@example.test" };
const workspace = { id: "workspace-post-sales", name: "Empresa Pós-venda", slug: "qualquer-empresa", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" };
const operationalSession = {
  user: { id: "user-1", email: "ana@example.test", isRoot: false, name: "Ana Operadora" },
  activeWorkspace: workspace,
  workspaces: [workspace],
  permissions: ["dashboard.read", "leads.read", "post_sales.use", "post_sales.manage"],
  actorScope: "workspace"
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function portfolioClient(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "Marina Oliveira",
    phone_e164: "5511999999999",
    email: "marina@example.test",
    notes: null,
    responsible_member_id: member.id,
    responsible_name: member.name,
    responsible_email: member.email,
    next_action: "Confirmar implantação",
    next_action_at: "2026-08-20T12:00:00.000Z",
    next_action_queue: "upcoming",
    origin: "closed_sale",
    lead_id: "lead-1",
    archived_at: null,
    version: 1,
    created_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
    checklist_total: 2,
    checklist_completed: 0,
    checklist_accepted: 0,
    progress_percent: 0,
    state: "not_started",
    ...overrides
  };
}

function checklist(clientId: string) {
  return [
    {
      id: `${clientId}-entry-1`, item_id: "template-1", description: "Oferta de onboarding", position: 0,
      is_active: true, item_archived_at: null, item_version: 1, result: "pendente", note: null,
      version: 1, updated_at: "2026-08-19T10:00:00.000Z", updated_by_name: null
    },
    {
      id: `${clientId}-entry-2`, item_id: "template-2", description: "Confirmar implantação", position: 1,
      is_active: true, item_archived_at: null, item_version: 1, result: "pendente", note: null,
      version: 1, updated_at: "2026-08-19T10:00:00.000Z", updated_by_name: null
    }
  ];
}

async function expectNoOverflow(page: Page, context: string) {
  const metrics = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll, `${context} overflowed by ${metrics.scroll - metrics.client}px`).toBeLessThanOrEqual(metrics.client + 1);
}

async function installOperationalFixture(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("atendon_last_seen_version", "post-sales-e2e");
  });
  const state = {
    clients: [portfolioClient("client-1")],
    checklists: { "client-1": checklist("client-1") } as Record<string, ReturnType<typeof checklist>>,
    templates: [
      { id: "template-1", description: "Oferta de onboarding", position: 0, is_active: true, archived_at: null, version: 1, client_count: 1, answered_count: 0 },
      { id: "template-2", description: "Confirmar implantação", position: 1, is_active: true, archived_at: null, version: 1, client_count: 1, answered_count: 0 }
    ]
  };

  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/(?:api|backend)/, "");
    const method = request.method();
    if (path === "/me") return json(route, operationalSession);
    if (path === "/feature-flags") return json(route, { flags: {} });
    if (path === "/capabilities") return json(route, { capabilities: [{ key: "post_sales_v1", displayName: "Pós-venda", description: "Carteira", kind: "capability", tenantConfigurable: true, availabilityMode: "all", uiOrder: 50, dependencies: [], supported: true, tenantOverride: true, enabled: true, source: "tenant_override", blockedBy: [] }] });
    if (path === "/panel/version") return json(route, { version: "post-sales-e2e", changelog: [] });
    if (path === "/dashboard") return json(route, { counts: { handoff: 0 } });
    if (path === "/post-sales/options") return json(route, { members: [member] });
    if (path === "/post-sales/clients" && method === "GET") {
      return json(route, {
        summary: { active: state.clients.length, archived: 0, not_started: state.clients.filter((client) => client.state === "not_started").length, in_progress: state.clients.filter((client) => client.state === "in_progress").length, complete: 0, overdue: 0, today: 0, upcoming: state.clients.length },
        clients: state.clients,
        next_cursor: null
      });
    }
    if (path === "/post-sales/clients" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const client = portfolioClient("client-manual", {
        name: body.name,
        phone_e164: String(body.phone_e164).replace(/\D/g, ""),
        email: body.email ?? null,
        notes: body.notes ?? null,
        responsible_member_id: body.responsible_member_id ?? null,
        responsible_name: body.responsible_member_id ? member.name : null,
        responsible_email: body.responsible_member_id ? member.email : null,
        next_action: body.next_action ?? null,
        next_action_at: body.next_action_at ?? null,
        origin: "manual",
        lead_id: null
      });
      state.clients.unshift(client);
      state.checklists[client.id] = checklist(client.id);
      return json(route, { client }, 201);
    }
    const checklistMatch = path.match(/^\/post-sales\/clients\/([^/]+)\/checklist\/([^/]+)$/);
    if (checklistMatch && method === "PATCH") {
      const [, clientId, entryId] = checklistMatch;
      const body = request.postDataJSON() as { result: string; note: string | null };
      const entries = state.checklists[clientId] ?? [];
      const entry = entries.find((candidate) => candidate.id === entryId)!;
      Object.assign(entry, { result: body.result, note: body.note, version: entry.version + 1, updated_by_name: member.name });
      const client = state.clients.find((candidate) => candidate.id === clientId)!;
      const completed = entries.filter((candidate) => candidate.result !== "pendente").length;
      Object.assign(client, { checklist_completed: completed, checklist_accepted: entries.filter((candidate) => candidate.result === "aceito").length, progress_percent: Math.round(completed / entries.length * 100), state: completed ? "in_progress" : "not_started" });
      return json(route, { entry });
    }
    const detailMatch = path.match(/^\/post-sales\/clients\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const client = state.clients.find((candidate) => candidate.id === detailMatch[1]);
      return client ? json(route, { client, checklist: state.checklists[client.id] }) : json(route, { error: "not found" }, 404);
    }
    if (path === "/post-sales/checklist-template/items" && method === "GET") return json(route, { items: state.templates });
    if (path === "/post-sales/checklist-template/items" && method === "POST") {
      const body = request.postDataJSON() as { description: string };
      state.templates.push({ id: `template-${state.templates.length + 1}`, description: body.description, position: state.templates.length, is_active: true, archived_at: null, version: 1, client_count: state.clients.length, answered_count: 0 });
      return json(route, { item: state.templates.at(-1) }, 201);
    }
    if (path === "/post-sales/checklist-template/order" && method === "PUT") {
      const body = request.postDataJSON() as { items: Array<{ id: string }> };
      state.templates = body.items.map(({ id }, position) => ({ ...state.templates.find((item) => item.id === id)!, position, version: state.templates.find((item) => item.id === id)!.version + 1 }));
      return json(route, { items: state.templates });
    }
    return json(route, { error: `Unhandled fixture route: ${method} ${path}` }, 404);
  };
  await page.route("**/api/**", handler);
  await page.route("**/backend/**", handler);
}

test("portfolio workflow covers manual entry, result, progress, configuration, themes and responsive access", async ({ page }) => {
  await installOperationalFixture(page);
  await page.setViewportSize(viewports[2]);
  await page.goto("/pos-venda");
  // Desktop usa o rail: páginas fora dos primários ficam no popover "Mais itens do menu".
  await page.getByRole("button", { name: "Mais itens do menu" }).click();
  await expect(page.getByRole("link", { name: "Carteira" })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Marina Oliveira" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Abrir conversa" })).toHaveCount(0);

  await page.getByRole("button", { name: "Novo cliente" }).click();
  const dialog = page.getByRole("dialog", { name: "Adicionar à carteira" });
  await dialog.getByLabel("Nome").fill("Cliente Manual");
  await dialog.getByLabel("Telefone").fill("+55 21 98888-7777");
  await dialog.getByLabel("Responsável").selectOption(member.id);
  await dialog.getByLabel("Próxima ação").fill("Agendar treinamento");
  await dialog.getByLabel("Data da ação").fill("2026-08-20T09:00");
  await dialog.getByRole("button", { name: "Adicionar cliente" }).click();
  await expect(page.getByRole("heading", { name: "Cliente Manual" })).toBeVisible();
  await expect(page.getByText("Agendar treinamento")).toBeVisible();

  const result = page.getByLabel("Resultado de Oferta de onboarding");
  await result.selectOption("aceito");
  await result.locator("xpath=ancestor::form").getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("50%").first()).toBeVisible();
  await expect(page.getByText("Checklist atualizado.")).toBeVisible();

  const themeToggle = page.getByRole("button", { name: "Alternar tema" });
  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.goto("/pos-venda/configurar");
  const moveDown = page.getByRole("button", { name: "Mover Oferta de onboarding para baixo" });
  await moveDown.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".post-sales-template-item__copy strong").first()).toHaveText("Confirmar implantação");
  await page.getByLabel("Novo item").fill("Revisão de 30 dias");
  await page.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(page.getByText("Revisão de 30 dias")).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/pos-venda");
    await expect(page.getByRole("heading", { name: "Carteira de pós-venda" })).toBeVisible();
    await expectNoOverflow(page, viewport.name);
    if (viewport.width <= 820) {
      await page.getByRole("button", { name: "Cliente Manual" }).click();
      await expect(page.getByRole("button", { name: "Voltar à carteira" })).toBeVisible();
      await page.getByRole("button", { name: "Voltar à carteira" }).click();
    }
  }

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => `${node.target.join(" ")} :: ${node.failureSummary ?? ""}`) }))).toEqual([]);
});

test("ROOT controls supported modules through the generic workspace catalog", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("atendon_last_seen_version", "post-sales-e2e");
  });
  const rootSession = {
    user: { id: "root-user", email: "root@example.test", isRoot: true, name: "ROOT" },
    activeWorkspace: null,
    workspaces: [],
    permissions: [],
    actorScope: "root"
  };
  const tenantCapability = { key: "post_sales_v1", displayName: "Pós-venda", description: "Carteira e checklist", kind: "capability", tenantConfigurable: true, availabilityMode: "all", uiOrder: 50, dependencies: [], supported: true, tenantOverride: null as boolean | null, enabled: false, source: "default", blockedBy: [] };
  let overrideCalled = false;
  const handler = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/(?:api|backend)/, "");
    if (path === "/me") return json(route, rootSession);
    if (path === "/panel/version") return json(route, { version: "post-sales-e2e", changelog: [] });
    if (path === "/root/workspaces") return json(route, { workspaces: [{ id: workspace.id, name: workspace.name, slug: workspace.slug, status: "active", attendant_phone: null, created_at: "2026-08-19T10:00:00.000Z", updated_at: "2026-08-19T10:00:00.000Z", member_count: 2, pending_invites: 0 }] });
    if (path === `/root/workspaces/${workspace.id}/capabilities` && request.method() === "GET") return json(route, { capabilities: [{ ...tenantCapability, enabled: overrideCalled, tenantOverride: overrideCalled ? true : null, source: overrideCalled ? "tenant_override" : "default" }] });
    if (path === `/root/workspaces/${workspace.id}/capabilities` && request.method() === "PATCH") {
      overrideCalled = request.postDataJSON().changes[0].override === true;
      return json(route, { capabilities: [{ ...tenantCapability, enabled: overrideCalled, tenantOverride: overrideCalled, source: "tenant_override" }], changes: [], operationGroup: "e2e-operation" });
    }
    return json(route, { error: `Unhandled ROOT fixture route: ${request.method()} ${path}` }, 404);
  };
  await page.route("**/api/**", handler);
  await page.route("**/backend/**", handler);
  await page.goto("/root/workspaces");
  await page.getByRole("button", { name: "Editar" }).click();
  await page.getByRole("combobox", { name: "Estado de Pós-venda" }).selectOption("on");
  await expect.poll(() => overrideCalled).toBe(true);
  await expect(page.getByText(`Módulos de ${workspace.name} atualizados.`)).toBeVisible();
  await expect(page.getByText("Override da empresa")).toBeVisible();
});

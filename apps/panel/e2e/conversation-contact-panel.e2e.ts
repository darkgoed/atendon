import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
] as const;

const conversationId = "10000000-0000-4000-8000-000000000003";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const session = {
  user: { id: "20000000-0000-4000-8000-000000000001", email: "revisao.tripz@example.test", isRoot: false, name: "Revisão Tripz" },
  activeWorkspace: { id: "30000000-0000-4000-8000-000000000001", name: "Tripz Turismo", slug: "tripzturismo-a44ab4", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" },
  workspaces: [{ id: "30000000-0000-4000-8000-000000000001", name: "Tripz Turismo", slug: "tripzturismo-a44ab4", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" }],
  permissions: ["conversations.read", "conversations.reply", "conversations.reactivate"],
  actorScope: "workspace"
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixture(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("atendon_last_seen_version", "e2e");
  });
  const state = {
    contactName: "Marina Ribeiro",
    cleared: false,
    assetsPageCalls: 0,
    deleteCalls: 0,
    renameCalls: 0
  };
  const conversation = () => ({
    id: conversationId,
    contact_name: state.contactName,
    contact_phone: "+55 11 98765-4321",
    avatar_url: null,
    ai_active: false,
    handoff_reason: "manually_paused",
    last_message: state.cleared ? undefined : "Enviei o roteiro e as fotos.",
    last_message_at: "2026-08-17T16:10:00.000Z",
    assigned_user_id: session.user.id,
    assigned_user_email: session.user.email,
    assigned_user_first_name: "Revisão",
    status: "open",
    waiting_minutes: 7,
    contact_presence: "available",
    contact_presence_updated_at: new Date().toISOString(),
    signature_enabled: null,
    tags: [],
    unread_count: 0,
    last_message_sender: "contact",
    last_message_status: "read"
  });
  const threadMessages = () => state.cleared ? [] : [
    { id: "message-contact", sender: "contact", content: "Veja https://tripz.tur.br/roteiro", media_type: null, status: "read", created_at: "2026-08-17T16:00:00.000Z" },
    { id: "message-agent", sender: "human", sender_name: "Revisão", content: "Recebi. Vou conferir.", media_type: null, status: "read", created_at: "2026-08-17T16:02:00.000Z" }
  ];
  const firstAssets = [
    { id: "asset-image-new", content: "Vista do hotel https://tripz.tur.br/hotel", media_type: "image", media_mime_type: "image/png", media_file_name: "hotel-aruba.png", media_size_bytes: tinyPng.length },
    { id: "asset-document", content: "Documento do voo", media_type: "document", media_mime_type: "application/pdf", media_file_name: "voos-confirmados.pdf", media_size_bytes: 24_570 },
    { id: "asset-link", content: "Consulte https://tripz.tur.br/condicoes.", media_type: null }
  ];
  const olderAssets = [
    { id: "asset-image-old", content: "Imagem antiga do histórico", media_type: "image", media_mime_type: "image/png", media_file_name: "praia-historico.png", media_size_bytes: tinyPng.length }
  ];

  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/(?:api|backend)/, "");
    const method = request.method();

    if (path === "/me") return json(route, session);
    if (path === "/feature-flags") return json(route, { flags: { conversations_delta_v2: false, ai_turn_visibility_v1: false } });
    if (path === "/panel/version") return json(route, { version: "e2e", changelog: [] });
    if (path === "/me/notification-preferences") return json(route, { enabled: false, muted_conversations: [] });
    if (path === "/conversations/unread-counts") return json(route, { human: 0, ai: 0, scheduled: 0, resolved: 0 });
    if (path === "/conversations/assignees") return json(route, { assignees: [{ id: session.user.id, email: session.user.email }] });
    if (path === "/events") return route.fulfill({ status: 204, body: "" });
    if (path === "/conversations" && method === "GET") return json(route, { conversations: [conversation()] });
    if (path === `/conversations/${conversationId}/messages` && method === "GET") {
      return json(route, { conversation: conversation(), messages: threadMessages() });
    }
    if (path === `/conversations/${conversationId}/read` && method === "PATCH") return route.fulfill({ status: 204, body: "" });
    if (path === `/conversations/${conversationId}/assets` && method === "GET") {
      state.assetsPageCalls += 1;
      if (url.searchParams.has("before")) return json(route, { messages: olderAssets, has_more: false, next_cursor: null });
      return json(route, { messages: firstAssets, has_more: true, next_cursor: "older-page-cursor" });
    }
    if (/\/conversations\/[^/]+\/messages\/[^/]+\/media$/.test(path) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
    }
    if (path === `/conversations/${conversationId}/contact` && method === "PATCH") {
      const body = request.postDataJSON() as { name: string };
      state.renameCalls += 1;
      state.contactName = body.name;
      return json(route, { contact_name: state.contactName });
    }
    if (path === `/conversations/${conversationId}/messages` && method === "DELETE") {
      state.deleteCalls += 1;
      state.cleared = true;
      return route.fulfill({ status: 204, body: "" });
    }
    return json(route, {});
  };

  await page.route("**/api/**", handler);
  await page.route("**/backend/**", handler);
  return state;
}

async function expectNoOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    panelClient: document.querySelector<HTMLElement>(".conversation-contact-panel")?.clientWidth ?? 0,
    panelScroll: document.querySelector<HTMLElement>(".conversation-contact-panel")?.scrollWidth ?? 0
  }));
  expect(metrics.scroll, `document overflowed by ${metrics.scroll - metrics.client}px`).toBeLessThanOrEqual(metrics.client + 1);
  expect(metrics.panelScroll, `contact panel overflowed by ${metrics.panelScroll - metrics.panelClient}px`).toBeLessThanOrEqual(metrics.panelClient + 1);
}

async function expectA11y(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target }) => target) }))).toEqual([]);
}

test("contact drawer pushes the desktop chat and remains complete, paginated, accessible and responsive", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  const state = await installFixture(page);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`/conversas?id=${conversationId}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".action-overlay")).toHaveCount(0);
    const contactButton = page.locator(".conversation-thread__contact-name");
    await expect(contactButton).toHaveText("Marina Ribeiro");
    const before = await page.locator(".conversation-thread").boundingBox();
    await contactButton.click();
    const panel = page.getByRole("complementary", { name: "Dados do contato" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Fechar dados do contato" })).toBeFocused();
    await expect(panel.getByText("+55 11 98765-4321")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Editar nome do contato" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Limpar conversa" })).toBeVisible();

    if (viewport.name === "desktop") {
      const after = await page.locator(".conversation-thread").boundingBox();
      expect(before?.width).toBeGreaterThan(0);
      expect(after?.width).toBeLessThan(before!.width);
      await expect(page.locator(".conversation-list")).toBeVisible();
      await expect(page.locator(".conversation-thread")).toBeVisible();
    } else {
      await expect(page.locator(".conversation-list")).toBeHidden();
      await expect(page.locator(".conversation-thread")).toBeHidden();
    }

    const mediaTab = panel.getByRole("tab", { name: "Mídia" });
    await mediaTab.focus();
    await mediaTab.press("ArrowRight");
    await expect(panel.getByRole("tab", { name: "Links" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("link", { name: /tripz\.tur\.br\/hotel/ })).toBeVisible();
    await panel.getByRole("tab", { name: "Links" }).press("End");
    await expect(panel.getByRole("tab", { name: "Docs" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("link", { name: /voos-confirmados\.pdf/ })).toBeVisible();
    await panel.getByRole("button", { name: "Carregar mais conteúdo" }).click();
    await panel.getByRole("tab", { name: "Mídia" }).click();
    await expect(panel.getByRole("link", { name: "Abrir praia-historico.png" })).toBeVisible();

    await expectNoOverflow(page);
    await expectA11y(page);
    await page.screenshot({ path: testInfo.outputPath(`conversation-drawer-${viewport.name}.png`), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(contactButton).toBeFocused();
  }

  await page.setViewportSize(viewports[2]);
  await page.goto(`/conversas?id=${conversationId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".conversation-thread__contact-name").click();
  await page.getByRole("button", { name: "Editar nome do contato" }).click();
  await page.getByLabel("Nome do contato").fill("Marina Ribeiro Tripz");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("complementary", { name: "Dados do contato" }).getByText("Marina Ribeiro Tripz")).toBeVisible();
  expect(state.renameCalls).toBe(1);

  const contactPanel = page.getByRole("complementary", { name: "Dados do contato" });
  await contactPanel.getByRole("button", { name: "Limpar conversa" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirmar ação" });
  await confirmation.getByRole("button", { name: "Cancelar" }).click();
  expect(state.deleteCalls).toBe(0);
  await contactPanel.getByRole("button", { name: "Limpar conversa" }).click();
  await confirmation.getByRole("button", { name: "Limpar conversa" }).click();
  await expect.poll(() => state.deleteCalls).toBe(1);
  await expect(page.getByText("Conversa limpa.")).toBeVisible();

  expect(state.assetsPageCalls).toBeGreaterThanOrEqual(viewports.length * 2);
  expect(serverErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

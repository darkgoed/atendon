import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
] as const;
// The config emulates reduced motion (entrances shrink to .01ms), which would hide mid-animation geometry bugs.
test.use({ contextOptions: { reducedMotion: "no-preference" } });

const conversationId = "10000000-0000-4000-8000-000000000003";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
// Wide intrinsic size, so the 360px thumbnail grid and image viewer are really stressed for overflow.
const wideImageWidth = 2400;
const wideImage = `<svg xmlns="http://www.w3.org/2000/svg" width="${wideImageWidth}" height="1200"><rect width="100%" height="100%" fill="#3a7bd5"/></svg>`;

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
      if (path.endsWith("/asset-image-old/media")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: wideImage });
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

async function expectA11y(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  const result = await (include ? builder.include(include) : builder).analyze();
  expect(result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target }) => target) }))).toEqual([]);
}

// Pauses the next dialog entrance on its first frame (animationstart), so its geometry is sampled DURING the
// animation whatever the machine speed; the caller then seeks/resumes it through the Web Animations API.
async function holdDialogEntrance(page: Page) {
  await page.evaluate(() => {
    const hold = (event: AnimationEvent) => {
      const target = event.target as HTMLElement;
      if (target.getAttribute("role") !== "dialog") return;
      document.removeEventListener("animationstart", hold, true);
      for (const animation of target.getAnimations()) { animation.pause(); animation.currentTime = 0; }
      target.dataset.e2eEntrance = event.animationName;
    };
    document.addEventListener("animationstart", hold, true);
  });
}

// Soft, so one run reports every viewport/phase: the whole dialog stays inside the viewport and centered.
async function expectDialogInViewport(page: Page, dialog: Locator, phase: string) {
  const { width, height } = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  const at = `${phase} ${width}x${height}`;
  expect.soft(box.x, `${at}: left edge`).toBeGreaterThanOrEqual(0);
  expect.soft(box.y, `${at}: top edge`).toBeGreaterThanOrEqual(0);
  expect.soft(box.x + box.width, `${at}: right edge`).toBeLessThanOrEqual(width + 1);
  expect.soft(box.y + box.height, `${at}: bottom edge`).toBeLessThanOrEqual(height + 1);
  expect.soft(Math.abs(box.x + box.width / 2 - width / 2), `${at}: distance from horizontal center`).toBeLessThanOrEqual(1);
  return box;
}

// SPEC R2: an image thumbnail is a button (not a link) that opens the same
// authenticated media URL in a Dialog, without a new page. Escape and the
// backdrop close only the Dialog and return focus to the thumbnail.
async function expectImageViewer(page: Page, panel: Locator, screenshotPath: string) {
  const thumb = panel.getByRole("button", { name: "Abrir praia-historico.png" });
  const src = await thumb.locator("img").getAttribute("src");
  expect(src).toMatch(new RegExp(`/conversations/${conversationId}/messages/asset-image-old/media$`));
  await expect(panel.getByRole("link", { name: /praia-historico/ })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "praia-historico.png" });

  for (const dismiss of ["Escape", "backdrop"] as const) {
    await holdDialogEntrance(page);
    await thumb.click();
    await expect(dialog).toBeVisible();
    // Entrance held on its first frame: still transparent (really mid-animation), yet already centered in the viewport.
    await expect(dialog).toHaveAttribute("data-e2e-entrance", /\S/);
    expect(Number(await dialog.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(1);
    await expectDialogInViewport(page, dialog, "entrance onset");
    await expectNoOverflow(page);
    await dialog.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.currentTime = Number(animation.effect?.getComputedTiming().duration) / 2;
    });
    await expectDialogInViewport(page, dialog, "entrance midpoint");
    await dialog.evaluate(async (element) => {
      for (const animation of element.getAnimations()) animation.play();
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const image = dialog.getByRole("img", { name: "praia-historico.png" });
    await expect(image).toHaveAttribute("src", src!);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBe(wideImageWidth);
    const box = await expectDialogInViewport(page, dialog, "settled");
    const imageBox = (await image.boundingBox())!;
    expect(imageBox.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
    await expectNoOverflow(page);

    if (dismiss === "Escape") {
      await expectA11y(page, "[role='dialog']");
      await page.screenshot({ path: screenshotPath, animations: "disabled" });
      await page.keyboard.press("Escape");
    } else {
      await page.locator(".overlay-backdrop").click({ position: { x: 2, y: 2 } });
    }
    await expect(dialog).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(thumb).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/conversas\\?id=${conversationId}$`));
  }
}

test("contact drawer pushes the desktop chat and remains complete, paginated, accessible and responsive", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const serverErrors: string[] = [];
  const openedPages: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  // Popups are tabs/windows opened by the app; AxeBuilder's own blank finishRun pages are context pages, not popups.
  page.on("popup", (opened) => openedPages.push(opened.url()));
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
    await expectImageViewer(page, panel, testInfo.outputPath(`conversation-image-viewer-${viewport.name}.png`));

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
  expect(openedPages).toEqual([]);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const credentials = {
  email: process.env.PANEL_E2E_EMAIL ?? process.env.PANEL_SEED_EMAIL,
  password: process.env.PANEL_E2E_PASSWORD ?? process.env.PANEL_SEED_PASSWORD
};

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
] as const;

type FixtureState = {
  conversationStatus: "collecting" | "ready_for_review" | "ready_for_pdf" | "pdf_generated";
  processingStatus: "idle" | "queued" | "processing" | "failed";
  proposalRevision: number;
  messages: Record<string, unknown>[];
  attachment?: Record<string, unknown>;
  pollCount: number;
  sendCount: number;
  retryCount: number;
  preview?: Record<string, unknown>;
  pdf?: Record<string, unknown>;
};

const sessionFixture = {
  user: { id: "e2e-tripz-user", email: "tripz.qa@example.test", isRoot: false, name: "Tripz QA" },
  activeWorkspace: { id: "e2e-tripz-workspace", name: "Tripz QA", slug: "tripz-qa", status: "active", role: "OWNER" },
  workspaces: [{ id: "e2e-tripz-workspace", name: "Tripz QA", slug: "tripz-qa", status: "active", role: "OWNER" }],
  permissions: ["dashboard.read", "conversations.read", "leads.read", "appointments.read", "tripz_ai.use"],
  actorScope: "workspace"
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function conversation(state: FixtureState) {
  return {
    id: "tripz-e2e-conversation",
    title: "Aruba · Marina e Caio",
    status: state.conversationStatus,
    processingStatus: state.processingStatus,
    ...(state.processingStatus === "failed" ? { processingErrorCode: "TRIPZ_PROVIDER_TIMEOUT" } : {}),
    createdAt: "2026-08-17T09:00:00.000Z",
    updatedAt: "2026-08-17T09:04:00.000Z"
  };
}

function proposal(state: FixtureState) {
  return {
    id: "tripz-e2e-proposal",
    revision: state.proposalRevision,
    status: state.conversationStatus,
    title: "Aruba · Marina e Caio",
    clientName: "Marina e Caio",
    destination: "Aruba",
    startDate: "2026-10-12",
    endDate: "2026-10-18",
    missingInformation: state.proposalRevision > 1 ? [] : ["Regime de alimentação"],
    inconsistencies: [],
    state: {
      passengers: { adults: 2 },
      hotel: { name: "Bucuti & Tara", roomType: "Ocean view" },
      pricing: { totalPrice: 18450, currency: "BRL" },
      itinerary: [{ dayNumber: 1 }, { dayNumber: 2 }],
      flights: [{ id: "flight-1" }],
      includedItems: ["Café da manhã"]
    }
  };
}

async function installTripzFixture(page: Page) {
  const state: FixtureState = {
    conversationStatus: "collecting",
    processingStatus: "idle",
    proposalRevision: 1,
    messages: [],
    pollCount: 0,
    sendCount: 0,
    retryCount: 0
  };

  await page.addInitScript((session) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(requestUrl, window.location.origin).pathname.endsWith("/me")) {
        return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  }, sessionFixture);

  // Keep the real login/cookie flow, but make the authenticated page deterministic
  // and grant only the Tripz permission needed by this isolated fixture.
  await page.route("**/api/me", (route) => json(route, sessionFixture));
  await page.route("**/api/feature-flags", (route) => json(route, { flags: { tripz_ai_v1: true } }));
  await page.route("**/api/capabilities", (route) => json(route, { capabilities: [{ key: "tripz_ai_v1", displayName: "Tripz IA", description: "Propostas", kind: "capability", tenantConfigurable: true, availabilityMode: "provisioned", uiOrder: 60, dependencies: [], supported: true, tenantOverride: true, enabled: true, source: "tenant_override", blockedBy: [] }] }));
  await page.route("**/api/panel/version", (route) => json(route, { version: "e2e", changelog: [] }));
  await page.route("**/api/dashboard", (route) => json(route, { counts: { handoff: 0 } }));
  await page.route("**/api/scheduling/config/attendants", (route) => json(route, { attendants: [], member_ids: [] }));
  await page.route("**/api/me/notification-preferences", (route) => json(route, { enabled: false }));
  await page.route("**/api/conversations/unread", (route) => json(route, { count: 0 }));
  // A 204 tells EventSource not to reconnect and keeps the browser console
  // clean. Aborting the request would manufacture ERR_FAILED noise that the
  // test is specifically meant to detect in the application itself.
  await page.route("**/api/events**", (route) => route.fulfill({ status: 204, body: "" }));
  // Builds use /api in the checked-in .env; dev servers may retain the
  // historical /backend base, so the fixture accepts both local contracts.
  await page.route("**/backend/me", (route) => json(route, sessionFixture));
  await page.route("**/backend/feature-flags", (route) => json(route, { flags: { tripz_ai_v1: true } }));
  await page.route("**/backend/capabilities", (route) => json(route, { capabilities: [{ key: "tripz_ai_v1", displayName: "Tripz IA", description: "Propostas", kind: "capability", tenantConfigurable: true, availabilityMode: "provisioned", uiOrder: 60, dependencies: [], supported: true, tenantOverride: true, enabled: true, source: "tenant_override", blockedBy: [] }] }));

  await page.route("**/api/tripz-ai/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api/, "");
    const method = request.method();

    if (path === "/tripz-ai/conversations" && method === "GET") {
      return json(route, { conversations: state.processingStatus === "idle" && state.messages.length === 0 ? [] : [conversation(state)] });
    }
    if (path === "/tripz-ai/conversations" && method === "POST") {
      return json(route, { conversation: conversation(state), proposal: proposal(state) }, 201);
    }
    if (path.endsWith("/attachments") && method === "POST") {
      state.attachment = { id: "tripz-e2e-attachment", fileName: "voos.pdf", mimeType: "application/pdf", sizeBytes: 1024, processingStatus: "processed" };
      return json(route, { attachment: state.attachment }, 201);
    }
    if (path.endsWith("/messages") && method === "POST") {
      state.sendCount += 1;
      const body = request.postDataJSON() as { content?: string };
      state.processingStatus = "processing";
      state.pollCount = 0;
      state.messages = [{ id: "tripz-e2e-user-message", role: "user", content: body.content ?? "", createdAt: "2026-08-17T09:01:00.000Z", processingStatus: "queued", metadata: {}, attachments: state.attachment ? [{ ...state.attachment, processingStatus: "processed" }] : [] }];
      return json(route, { message: state.messages[0], conversation: conversation(state), proposal: proposal(state) }, 202);
    }
    if (path.endsWith("/messages/tripz-e2e-user-message/retry") && method === "POST") {
      state.retryCount += 1;
      state.processingStatus = "queued";
      state.conversationStatus = "ready_for_review";
      state.proposalRevision = 2;
      state.messages = [
        { id: "tripz-e2e-user-message", role: "user", content: "Seguem os voos e o hotel.", createdAt: "2026-08-17T09:01:00.000Z", processingStatus: "completed", metadata: {}, attachments: state.attachment ? [{ ...state.attachment, processingStatus: "processed" }] : [] },
        { id: "tripz-e2e-assistant-message", role: "assistant", content: "Encontrei os voos e a hospedagem. O resumo está pronto para revisão.", createdAt: "2026-08-17T09:03:00.000Z", processingStatus: "completed", metadata: {}, attachments: [] }
      ];
      return json(route, { message: state.messages[0] }, 202);
    }
    if (path.endsWith("/proposal") && method === "GET") return json(route, proposal(state));
    if (path.endsWith("/preview") && method === "POST") {
      state.preview = { id: "tripz-e2e-preview", kind: "preview", proposalRevision: state.proposalRevision, status: "ready", html: "<!doctype html><html><body><h1>Aruba</h1><p>Marina e Caio</p></body></html>" };
      return json(route, state.preview, 201);
    }
    if (path.endsWith("/pdf") && method === "POST") {
      state.conversationStatus = "pdf_generated";
      state.pdf = { id: "tripz-e2e-pdf", kind: "pdf", proposalRevision: state.proposalRevision, status: "ready", filename: "aruba-tripz.pdf" };
      return json(route, state.pdf, 201);
    }
    if (path.includes("/documents/tripz-e2e-pdf/content")) return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 e2e" });
    if (path.endsWith("/documents/tripz-e2e-preview/content")) return route.fulfill({ status: 200, contentType: "text/html", body: String(state.preview?.html ?? "") });
    if (/\/conversations\/[^/]+$/.test(path) && method === "GET") {
      // The first refresh proves the UI is polling; the next one exposes a retryable failure.
      state.pollCount += 1;
      if (state.processingStatus === "processing" && state.pollCount >= 4) state.processingStatus = "failed";
      if (state.processingStatus === "queued" && state.retryCount > 0) state.processingStatus = "idle";
      const messages = state.processingStatus === "failed"
        ? state.messages.map((message) => message.id === "tripz-e2e-user-message" ? { ...message, processingStatus: "failed" } : message)
        : state.messages;
      return json(route, { conversation: conversation(state), messages, proposal: proposal(state), attachments: [], documents: [state.preview, state.pdf].filter(Boolean) });
    }
    return json(route, { error: `Unhandled Tripz fixture route: ${method} ${path}` }, 500);
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(credentials.email!);
  await page.getByLabel("Senha", { exact: true }).fill(credentials.password!);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login"),
    page.getByRole("button", { name: "Entrar" }).click()
  ]);
}

async function expectNoOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll, `Tripz overflowed by ${metrics.scroll - metrics.client}px`).toBeLessThanOrEqual(metrics.client + 1);
}

async function expectA11y(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target }) => target) }))).toEqual([]);
}

test("authenticated Tripz IA covers flag-on create/upload/poll/retry/revision/preview/PDF and keyboard states", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const unexpectedTripzErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/tripz-ai/") && response.status() >= 500) {
      unexpectedTripzErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  await installTripzFixture(page);
  if (credentials.email && credentials.password) {
    await login(page);
    await page.goto("/tripz-ai");
  } else {
    // The fixture still exercises the authenticated shell contract through a
    // mocked /me response, so local QA does not require a shared test password.
    await page.goto("/tripz-ai");
  }
  const versionNotice = page.getByRole("button", { name: "Entendi" });
  await versionNotice.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.locator(".action-overlay")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Tripz IA" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Nova proposta", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Aruba · Marina e Caio" })).toBeVisible();

  const file = { name: "voos.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e") };
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("voos.pdf")).toBeVisible();
  await page.getByLabel("Envie informações da viagem").fill("Seguem os voos e o hotel.");
  await page.getByLabel("Envie informações da viagem").press("Shift+Enter");
  await expect(page.getByLabel("Envie informações da viagem")).toHaveValue("Seguem os voos e o hotel.\n");
  // The composer contract is Enter (without Shift); the newline remains part of the submitted text.
  await page.getByLabel("Envie informações da viagem").press("Enter");
  await expect(page.getByText("Analisando dados")).toBeVisible();
  await expect(page.getByText("A análise foi interrompida")).toBeVisible();
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Resumo da proposta atualizado")).toBeVisible();

  await page.locator("button").filter({ hasText: "Revisar proposta" }).first().click({ force: true });
  await expect(page.getByRole("dialog")).toBeVisible();
  const pdfButton = page.getByRole("button", { name: "Gerar PDF" });
  await expect(pdfButton).toBeDisabled();
  await page.getByRole("button", { name: "Gerar prévia" }).click();
  await expect(page.getByTitle("Prévia segura da proposta Tripz")).toBeVisible();
  await expect(pdfButton).toBeEnabled();
  await pdfButton.click();
  await expect(page.getByRole("link", { name: "Baixar PDF" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/tripz-ai", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main").first()).toBeVisible();
    const conversationRegion = page.getByRole("region", { name: "Conversa Aruba · Marina e Caio" });
    const conversationBox = await conversationRegion.boundingBox();
    expect(conversationBox?.width).toBeGreaterThanOrEqual(viewport.name === "desktop" ? 700 : viewport.name === "tablet" ? 480 : 350);
    if (viewport.name === "tablet") {
      const historyTrigger = page.getByRole("button", { name: "Abrir histórico de propostas" });
      await historyTrigger.click();
      const historyDialog = page.getByRole("dialog", { name: "Propostas" });
      await expect(historyDialog).toBeVisible();
      await expect(page.getByRole("button", { name: "Fechar histórico" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(historyDialog).toBeHidden();
      await expect(historyTrigger).toBeFocused();
    }
    const composerSendBox = await page.getByRole("button", { name: "Enviar mensagem" }).boundingBox();
    const notificationBox = await page.getByRole("button", { name: "Mensagens de contatos" }).boundingBox();
    expect(composerSendBox).not.toBeNull();
    expect(notificationBox).not.toBeNull();
    const overlapsComposerSend = !(
      notificationBox!.x + notificationBox!.width <= composerSendBox!.x
      || composerSendBox!.x + composerSendBox!.width <= notificationBox!.x
      || notificationBox!.y + notificationBox!.height <= composerSendBox!.y
      || composerSendBox!.y + composerSendBox!.height <= notificationBox!.y
    );
    expect(overlapsComposerSend, `${viewport.name}: notification trigger overlaps the Tripz send button`).toBe(false);
    await expectNoOverflow(page);
    await expectA11y(page);
    await page.screenshot({ path: testInfo.outputPath(`tripz-ai-${viewport.name}.png`), fullPage: true, animations: "disabled" });
  }
  expect(unexpectedTripzErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

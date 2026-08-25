import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const credentials = {
  email: process.env.PANEL_E2E_EMAIL ?? process.env.PANEL_SEED_EMAIL,
  password: process.env.PANEL_E2E_PASSWORD ?? process.env.PANEL_SEED_PASSWORD
};

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
] as const;

async function expectNoDocumentOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(metrics.scrollWidth, `document overflowed by ${metrics.scrollWidth - metrics.clientWidth}px`).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary }))
  }));
  expect(violations).toEqual([]);
}

async function login(page: Page) {
  if (!credentials.email || !credentials.password) return false;
  await page.goto("/login");
  const emailInput = page.getByLabel("E-mail");
  const passwordInput = page.getByLabel("Senha", { exact: true });
  await emailInput.fill(credentials.email);
  await passwordInput.fill(credentials.password);
  try {
    await Promise.all([
      page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 }),
      page.getByRole("button", { name: "Entrar" }).click()
    ]);
  } catch (cause) {
    const error = await page.getByRole("alert").first().textContent().catch(() => null);
    await emailInput.fill("").catch(() => undefined);
    await passwordInput.fill("").catch(() => undefined);
    throw new Error(error ? `Login failed: ${error.slice(0, 200)}` : "Login did not complete", { cause });
  }
  return true;
}

for (const viewport of viewports) {
  test(`login is accessible without horizontal overflow on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Boas-vindas" })).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expectNoAxeViolations(page);
  });
}

test("authorized panel routes remain responsive at all acceptance widths", async ({ page }) => {
  test.skip(!credentials.email || !credentials.password, "Set PANEL_E2E_EMAIL/PANEL_E2E_PASSWORD to exercise authenticated routes");
  await page.setViewportSize(viewports[0]);
  expect(await login(page)).toBe(true);

  const navigationLinks = page.locator('nav[aria-label="Navegação principal"] a');
  await expect.poll(() => navigationLinks.count()).toBeGreaterThan(3);
  const visibleRoutes = new Set(await navigationLinks.evaluateAll((links) =>
    links.map((link) => new URL((link as HTMLAnchorElement).href).pathname)
  ));
  const routes = ["/", "/conversas", "/leads", "/leads/pipeline", "/agenda", "/conexao", "/configuracoes", "/workspace/members", "/workspace/audit"]
    .filter((route) => visibleRoutes.has(route));

  expect(routes.length).toBeGreaterThan(3);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main").first()).toBeVisible();
      await expectNoDocumentOverflow(page);
      if (["/", "/conversas", "/leads", "/leads/pipeline", "/agenda"].includes(route)) await expectNoAxeViolations(page);
    }
  }
});

test("PWA exposes an installable manifest, offline fallback and non-caching service worker", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "AtendON",
    start_url: "/",
    display: "standalone"
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icon.png", sizes: "1024x1024" })
  ]));

  const [offline, worker] = await Promise.all([request.get("/offline"), request.get("/sw.js")]);
  expect(offline.ok()).toBe(true);
  expect(worker.ok()).toBe(true);
  const source = await worker.text();
  expect(source).toContain('url.pathname.startsWith("/api/")');
  expect(source).toContain("caches.match(OFFLINE_URL");
  expect(source).not.toContain("notification.actions");
});

test("push deep links validate the session before exposing panel records", async ({ page }) => {
  await page.goto("/conversas?id=10000000-0000-4000-8000-000000000003");
  await page.waitForURL((url) => url.pathname === "/login");
  await expect(page.getByRole("heading", { name: "Boas-vindas" })).toBeVisible();
});

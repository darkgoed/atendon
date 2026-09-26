import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hash } from "bcryptjs";
import { config as loadEnv } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

// Fixture espelha e2e/flow-create.e2e.ts: tenant ativo + capabilities + membro
// OWNER no banco de teste (loopback, nome contendo "test", mesma regra do
// playwright.config.ts). Credenciais aleatórias criadas aqui, usadas só no
// browser e removidas no afterAll com asserção de zero — o teste autorizado
// nunca fica skip por falta de credenciais em .env.test limpa.
const fileEnv: Record<string, string | undefined> = {};
loadEnv({ path: resolve(__dirname, "../../../.env.test"), processEnv: fileEnv, quiet: true });
const databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? fileEnv.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("TEST_DATABASE_URL ausente");
const database = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname.toLowerCase())
  || !/test/i.test(decodeURIComponent(database.pathname))) {
  throw new Error("Este E2E só roda contra um banco de testes em loopback");
}

// Mesmo conjunto de tests/helpers/capability-seed.ts (DEFAULT_SEEDED_CAPABILITIES).
const CAPABILITIES = ["dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1", "post_sales_v1", "workspace_admin_v1"];

const pool = new pg.Pool({ connectionString: databaseUrl });
const email = `smoke-e2e-${randomUUID()}@test.local`;
const password = randomBytes(24).toString("base64url");
let tenantId: string | undefined;
let userId: string | undefined;

test.beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Smoke E2E ${randomUUID()}`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       SELECT $1,k,true FROM unnest($2::text[]) AS k
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId, CAPABILITIES]
    );
    // Papel OWNER como em ensureWorkspaceDefaultRoles (auth/rbac.ts): todas as permissões fora de tripz_ai.
    const roleId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
       VALUES($1,'OWNER','Proprietario protegido do workspace',true,true)
       ON CONFLICT(workspace_id,name) DO UPDATE SET updated_at=now() RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_role_permissions(role_id,permission_key)
       SELECT $1,key FROM permissions WHERE module <> 'tripz_ai' ON CONFLICT DO NOTHING`,
      [roleId]
    );
    userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [email, await hash(password, 4)]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, userId, roleId]
    );
    const manage = await client.query(
      "SELECT 1 FROM workspace_role_permissions WHERE role_id=$1 AND permission_key='agent.manage'", [roleId]
    );
    if (manage.rowCount !== 1) throw new Error("Catálogo de permissões sem agent.manage no banco de testes");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    tenantId = undefined;
    userId = undefined;
    throw error;
  } finally {
    client.release();
  }
});

test.afterAll(async () => {
  try {
    if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    const left = await pool.query(
      "SELECT (SELECT count(*) FROM tenants WHERE id=$1)::int + (SELECT count(*) FROM users WHERE email=$2)::int AS n",
      [tenantId ?? randomUUID(), email]
    );
    expect(left.rows[0].n).toBe(0);
  } finally {
    await pool.end();
  }
});

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
  await page.goto("/login");
  const emailInput = page.getByLabel("E-mail");
  const passwordInput = page.getByLabel("Senha", { exact: true });
  await emailInput.fill(email);
  await passwordInput.fill(password);
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

/**
 * O modal "O que há de novo" cobre a página inteira e reabre a cada navegação
 * enquanto o localStorage não registrar exatamente a versão implantada, então
 * gravamos a versão real e reinstalamos o valor em todo document novo. Mesmo
 * padrão de e2e/agenda-responsive.e2e.ts: setup de teste, não prova de defeito.
 */
async function suppressVersionBanner(page: Page) {
  const version = await page.evaluate(async () => {
    const response = await fetch("/backend/panel/version", { credentials: "include" }).catch(() => null);
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    return typeof payload?.version === "string" ? payload.version : null;
  });
  if (!version) throw new Error("Não foi possível ler a versão implantada para suprimir o banner de novidades");
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("atendon_last_seen_version", value as string);
    } catch {
      // localStorage indisponível neste contexto.
    }
  }, version);
  await page.evaluate((value) => {
    try {
      localStorage.setItem("atendon_last_seen_version", value as string);
    } catch {
      // localStorage indisponível neste contexto.
    }
  }, version);
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
  await page.setViewportSize(viewports[0]);
  expect(await login(page)).toBe(true);
  await suppressVersionBanner(page);

  const navigationLinks = page.locator('nav[aria-label="Navegação principal"] a');
  await expect.poll(() => navigationLinks.count()).toBeGreaterThan(3);
  const visibleRoutes = new Set(await navigationLinks.evaluateAll((links) =>
    links.map((link) => new URL((link as HTMLAnchorElement).href).pathname)
  ));
  const routes = ["/", "/conversas", "/contatos", "/pipeline", "/agenda", "/conexao", "/configuracoes", "/workspace/members", "/workspace/audit"]
    .filter((route) => visibleRoutes.has(route));

  expect(routes.length).toBeGreaterThan(3);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main").first()).toBeVisible();
      await expectNoDocumentOverflow(page);
      if (["/", "/conversas", "/contatos", "/pipeline", "/agenda"].includes(route)) await expectNoAxeViolations(page);
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

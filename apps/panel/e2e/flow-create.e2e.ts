// E2E real (sem mocks de rede): login → "Novo fluxo" → editor → volta à lista.
// Banco de testes em loopback (TEST_DATABASE_URL do .env.test, mesma regra do
// playwright.config.ts). Fixture espelha backend/tests/flow-create-panel.integration.test.ts:
// tenant ativo + capabilities + membro OWNER (agent.manage). Credenciais aleatórias,
// só de teste, removidas no afterAll.
import { expect, test } from "@playwright/test";
import { hash } from "bcryptjs";
import { config as loadEnv } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

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
const email = `flow-e2e-${randomUUID()}@test.local`;
const password = randomBytes(24).toString("base64url");
let tenantId: string | undefined;
let userId: string | undefined;

test.beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Flow E2E ${randomUUID()}`]
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

async function noHorizontalOverflow(page: import("@playwright/test").Page) {
  const size = await page.evaluate(() => ({
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    client: document.documentElement.clientWidth
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.client);
}

test("Novo fluxo cria (201, revisão 1), abre o editor, persiste e aparece na lista", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login", { timeout: 20_000 }),
    page.getByRole("button", { name: "Entrar" }).click()
  ]);
  // Modal "O que há de novo" intercepta cliques até registrar a versão implantada
  // (mesmo padrão de e2e/agenda-responsive.e2e.ts): grava a versão real em todo document.
  const version = await page.evaluate(async () => {
    const response = await fetch("/backend/panel/version", { credentials: "include" });
    return response.ok ? ((await response.json()) as { version?: unknown }).version : null;
  });
  expect(typeof version).toBe("string");
  await page.addInitScript((value) => localStorage.setItem("atendon_last_seen_version", value), version as string);

  await page.goto("/fluxos");
  await expect(page.getByRole("heading", { name: "Fluxos", level: 1 })).toBeVisible();
  await expect(page.getByText("Nenhum fluxo")).toBeVisible();

  const putResponse = page.waitForResponse((response) =>
    response.request().method() === "PUT" && /\/qualification\/flows\/fluxo-[0-9a-f]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Novo fluxo" }).first().click();
  const put = await putResponse;
  expect(put.status()).toBe(201);
  const created = (await put.json()).flow as { id: string; nome: string; ativo: boolean; revisao: number };
  expect(created).toMatchObject({ nome: "Novo fluxo", ativo: false, revisao: 1 });
  const flowId = created.id;
  expect(new URL(put.url()).pathname.endsWith(`/${flowId}`)).toBe(true);

  // Editor: rota do fluxo recém-criado, renderizado com o nome e sem erro.
  await expect(page).toHaveURL(new RegExp(`/fluxos/${flowId}$`));
  await expect(page.getByRole("textbox", { name: "Nome do fluxo" })).toHaveValue("Novo fluxo");
  await expect(page.getByRole("heading", { name: "Novo fluxo", level: 1 })).toBeAttached();
  await expect(page.getByText("Fluxo não encontrado.")).toHaveCount(0);

  // Persistência real no banco de testes: linha + snapshot de criação.
  const row = (await pool.query<{ revision: number; name: string; active: boolean }>(
    "SELECT revision,name,active FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [tenantId, flowId]
  )).rows[0];
  expect(row).toEqual({ revision: 1, name: "Novo fluxo", active: false });
  const versions = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2", [tenantId, flowId]
  );
  expect(versions.rows[0].n).toBe(1);

  // Volta pela UI do editor: a lista mostra a linha do novo fluxo.
  await page.getByRole("link", { name: "Voltar para a lista de fluxos" }).click();
  await expect(page).toHaveURL(/\/fluxos$/);
  const listRow = page.getByRole("listitem").filter({ has: page.locator(`a[href="/fluxos/${flowId}"]`) });
  await expect(listRow).toHaveCount(1);
  await expect(listRow.getByRole("link", { name: "Novo fluxo" })).toBeVisible();
  await expect(listRow.getByText("Inativo")).toBeVisible();

  // Mobile 360x800: lista e editor sem overflow horizontal do documento.
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(listRow).toBeVisible();
  await noHorizontalOverflow(page);
  await page.goto(`/fluxos/${flowId}`);
  await expect(page.getByRole("textbox", { name: "Nome do fluxo" })).toHaveValue("Novo fluxo");
  await noHorizontalOverflow(page);
});

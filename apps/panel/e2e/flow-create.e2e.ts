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

  // ── Edição real: paleta → drag de conexão → save → reload → API/banco ──
  const messageText = "Olá! Já recebemos sua mensagem.";
  await page.getByRole("button", { name: "Mensagem Envia um texto ao contato" }).click();
  const canvas = page.getByTestId("flow-canvas");
  const nodeM = canvas.locator(".react-flow__node").filter({ hasText: "Mensagem" });
  await expect(nodeM).toHaveCount(1); // já vem selecionado pelo handleAddNode
  const newId = (await nodeM.getAttribute("data-id")) as string;
  expect(newId).toMatch(/^n_[0-9a-f]{12}$/);
  // O Field local do editor aninha textarea + contador "0/4000" dentro do
  // <label>, então o nome acessível é "Mensagem 0/4000 caracteres" (nunca
  // exato). O painel de propriedades da etapa message tem um único textarea.
  const messageField = page.getByRole("complementary", { name: "Propriedades da etapa" }).locator("textarea").first();
  await expect(messageField).toBeVisible();
  await messageField.fill(messageText);
  // fitView/zoomIn do React Flow animam (duration 200-300): espera o transform
  // do viewport estabilizar em vez de waitForTimeout fixo.
  const viewport = canvas.locator(".react-flow__viewport");
  async function settledTransform() {
    let prev: string | null = null;
    await expect.poll(async () => {
      const cur = await viewport.getAttribute("style");
      const done = cur !== null && cur === prev;
      prev = cur;
      return done;
    }).toBe(true);
  }
  await page.getByRole("button", { name: "Ajustar à tela" }).click(); // reenquadra o nó novo
  await settledTransform();

  async function dragTo(fromLoc: import("@playwright/test").Locator, toLoc: import("@playwright/test").Locator) {
    const a = await fromLoc.boundingBox();
    const b = await toLoc.boundingBox();
    if (!a || !b) throw new Error("Handle sem boundingBox para o drag");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  const edgePath = (edgeId: string) => canvas.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`);
  const handleOut = nodeM.locator(".react-flow__handle.source");
  const handleTarget = nodeM.locator(".react-flow__handle.target");

  // Drag real: 'out' do nó mensagem → target do E1 (step.next = E1).
  await dragTo(handleOut, canvas.locator(".react-flow__node[data-id='E1'] .react-flow__handle.target"));
  await expect(edgePath(`${newId}:out`)).toHaveCount(1);

  // Drag real: gatilho → novo nó (definition.start = newId).
  await dragTo(canvas.locator(".react-flow__node[data-id='__trigger__'] .react-flow__handle.source"), handleTarget);
  await expect(edgePath("__trigger__:out")).toHaveCount(1);

  // ── Reconexão e exclusão da aresta no browser (updater + duplo clique) ──
  // Segundo destino final via paleta: o nó novo é o único .selected
  // (handleAddNode seleciona e dá posição PRÓPRIA; E1 também é "Finalizar",
  // então data-id decide).
  await page.getByRole("button", { name: "Finalizar Encerra o fluxo com uma mensagem" }).click();
  const nodeEnd2 = canvas.locator(".react-flow__node.selected");
  await expect(nodeEnd2).toHaveCount(1);
  const end2Id = (await nodeEnd2.getAttribute("data-id")) as string;
  expect(end2Id).toMatch(/^n_[0-9a-f]{12}$/);
  // Etapa final exige mensagem (validateDefinition). O painel troca para as
  // propriedades da etapa selecionada; valor vazio prova que já não é o
  // textarea do nodeM ("Olá! Já recebemos sua mensagem.").
  const endMessage = page.getByRole("complementary", { name: "Propriedades da etapa" }).locator("textarea").first();
  await expect(endMessage).toBeVisible();
  await expect(endMessage).toHaveValue("");
  await endMessage.fill("Fim alternativo.");
  await page.getByRole("button", { name: "Ajustar à tela" }).click(); // reenquadra o nó novo
  await settledTransform();

  // Reconexão pelo updater-target (círculo sobre o handle do destino atual):
  // arrasto até o target do nó novo deixa a aresta ÚNICA, mesmo id, destino
  // novo (handleReconnect → setEdgeTarget atômico).
  const edgeSel = `.react-flow__edge[data-id="${newId}:out"]`;
  await dragTo(canvas.locator(`${edgeSel} .react-flow__edgeupdater-target`), nodeEnd2.locator(".react-flow__handle.target"));
  await expect(edgePath(`${newId}:out`)).toHaveCount(1);
  await expect(canvas.locator(edgeSel)).toHaveAttribute("aria-label", `Edge from ${newId} to ${end2Id}`);
  // Ponta FINAL do path ≈ handle target do destino novo (≤6px, mesmo padrão do
  // bloco de origem: handle 8px + stroke; getPointAtLength(total) via getScreenCTM).
  await expect.poll(async () =>
    page.evaluate(([sel, nodeSel]) => {
      const path = document.querySelector(`${sel} .react-flow__edge-path`) as SVGPathElement | null;
      const handle = document.querySelector(`${nodeSel} .react-flow__handle.target`);
      if (!path || !handle) return 999999;
      const matrix = path.getScreenCTM();
      if (!matrix) return 999999;
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
      const rect = handle.getBoundingClientRect();
      return Math.hypot(end.x - (rect.x + rect.width / 2), end.y - (rect.y + rect.height / 2));
    }, [edgeSel, `.react-flow__node[data-id="${end2Id}"]`])
  ).toBeLessThanOrEqual(6);

  // Duplo clique no MEIO do path exclui a aresta (onEdgeDoubleClick → next=null).
  const mid = await page.evaluate(([sel]) => {
    const path = document.querySelector(`${sel} .react-flow__edge-path`) as SVGPathElement | null;
    if (!path) return null;
    const matrix = path.getScreenCTM();
    if (!matrix) return null;
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  }, [edgeSel]);
  if (!mid) throw new Error("path ausente para o duplo clique");
  await page.mouse.dblclick(mid.x, mid.y);
  await expect(edgePath(`${newId}:out`)).toHaveCount(0);
  // O duplo clique pode dar zoom (zoomOnDoubleClick): reenquadra e espera o
  // transform estabilizar antes do drag de restauração.
  await page.getByRole("button", { name: "Ajustar à tela" }).click();
  await settledTransform();

  // Reconexão pela ORIGEM (drag source 'out' → E1) restaura o grafo p/ save.
  await dragTo(handleOut, canvas.locator(".react-flow__node[data-id='E1'] .react-flow__handle.target"));
  await expect(edgePath(`${newId}:out`)).toHaveCount(1);

  // A linha acompanha o nó movido: o path muda de forma e a origem fica no
  // handle 'out' movido. O menor x da bounding box pode ser do destino fixo,
  // então não se assume que a borda esquerda ande os 48 px do nó.
  const nodeBefore = await nodeM.boundingBox();
  const dBefore = await edgePath(`${newId}:out`).getAttribute("d");
  if (!nodeBefore || dBefore === null) throw new Error("bounds/path ausentes antes do arrasto do nó");
  await page.mouse.move(nodeBefore.x + nodeBefore.width / 2, nodeBefore.y + nodeBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBefore.x + nodeBefore.width / 2 + 48, nodeBefore.y + nodeBefore.height / 2, { steps: 8 });
  await page.mouse.up();
  const nodeAfter = await nodeM.boundingBox();
  if (!nodeAfter) throw new Error("bounds ausentes depois do arrasto do nó");
  // ≥20: prova de arrasto efetivo sem exatidão — o ponteiro anda 48px, mas
  // runs observados movem o nó 36px ou ≥40px, então 40 falha por flutuação
  // do próprio drag, não por arrasto ausente.
  expect(nodeAfter.x - nodeBefore.x).toBeGreaterThanOrEqual(20);
  const dAfter = await edgePath(`${newId}:out`).getAttribute("d");
  if (dAfter === null) throw new Error("path ausente depois do arrasto do nó");
  expect(dAfter).not.toBe(dBefore);
  // Origem da linha ≈ centro do handle 'out' movido (coordenadas de viewport):
  // getPointAtLength(0) via getScreenCTM cai no mesmo espaço do getBoundingClientRect.
  // Tolerância 6px: o handle tem 8px de diâmetro + 1px de borda (raio+stroke
  // ≈ 5px do centro), então a ponta do path pode ficar a alguns px do centro
  // sem romper a conexão visual — 4.47px observado estável nesse padrão.
  await expect.poll(async () =>
    page.evaluate(([edgeSel, nodeSel]) => {
      const path = document.querySelector(`${edgeSel} .react-flow__edge-path`) as SVGPathElement | null;
      const handle = document.querySelector(`${nodeSel} .react-flow__handle.source`);
      if (!path || !handle) return 999999; // ausente → falha e repete o poll
      const matrix = path.getScreenCTM();
      if (!matrix) return 999999;
      const origin = path.getPointAtLength(0).matrixTransform(matrix);
      const rect = handle.getBoundingClientRect();
      return Math.hypot(origin.x - (rect.x + rect.width / 2), origin.y - (rect.y + rect.height / 2));
    }, [`.react-flow__edge[data-id="${newId}:out"]`, `.react-flow__node[data-id="${newId}"]`])
  ).toBeLessThanOrEqual(6);

  // Zoom acompanha: aproximar escala a linha SVG junto do canvas.
  const zoomBefore = await edgePath(`${newId}:out`).boundingBox();
  if (!zoomBefore) throw new Error("bounds ausentes antes do zoom");
  await page.getByRole("button", { name: "Aproximar" }).click();
  await settledTransform(); // zoomIn anima (duration: 200)
  const zoomAfter = await edgePath(`${newId}:out`).boundingBox();
  if (!zoomAfter) throw new Error("bounds ausentes depois do zoom");
  expect(zoomAfter.width).toBeGreaterThan(zoomBefore.width);

  // Pan real (depois do zoom): arrastar uma área VAZIA do pane move a viewport
  // — comportamento nativo (panOnDrag default, sem space+drag, sem mock). O
  // ponto vem de elementFromPoint sobre uma grade do canvas, nunca de
  // coordenada de nó; a toolbar "Organizar" é irmã do ReactFlow, fora do
  // subtree do pane, então o closest('.react-flow__pane') já a exclui.
  const panPoint = await page.evaluate(() => {
    const rect = document.querySelector("[data-testid='flow-canvas']")?.getBoundingClientRect();
    if (!rect) throw new Error("canvas ausente para o pan");
    for (let y = rect.top + 24; y < rect.bottom - 24; y += 24) {
      for (let x = rect.left + 24; x < rect.right - 24; x += 24) {
        const el = document.elementFromPoint(x, y);
        if (!el?.closest(".react-flow__pane")) continue; // toolbar/paleta fora do pane
        if (el.closest(".react-flow__node")) continue;
        if (el.closest(".react-flow__edge")) continue; // inclui o path invisível de interação
        if (el.closest(".react-flow__controls") || el.closest(".react-flow__minimap")) continue;
        return { x, y };
      }
    }
    throw new Error("nenhum ponto vazio do pane disponível para o pan");
  });
  const panTransformBefore = await viewport.getAttribute("style");
  const panEdgeBefore = await edgePath(`${newId}:out`).boundingBox();
  if (!panTransformBefore || !panEdgeBefore) throw new Error("estado ausente antes do pan");
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down();
  await page.mouse.move(panPoint.x + 60, panPoint.y, { steps: 8 });
  await page.mouse.up();
  const panEdgeX = panEdgeBefore.x;
  const panEdgeY = panEdgeBefore.y;
  // Viewport acompanhou o arrasto (transform mudou) e a edge saiu do lugar.
  await expect.poll(async () =>
    (await viewport.getAttribute("style")) !== panTransformBefore
  ).toBe(true);
  await expect.poll(async () => {
    const now = await edgePath(`${newId}:out`).boundingBox();
    return now ? now.x !== panEdgeX || now.y !== panEdgeY : false;
  }).toBe(true);
  // A ponta da linha continua ≤6px do centro do handle 'out' movido — mesmo
  // método do bloco acima (getPointAtLength(0) via getScreenCTM ×
  // getBoundingClientRect do handle).
  await expect.poll(async () =>
    page.evaluate(([edgeSel, nodeSel]) => {
      const path = document.querySelector(`${edgeSel} .react-flow__edge-path`) as SVGPathElement | null;
      const handle = document.querySelector(`${nodeSel} .react-flow__handle.source`);
      if (!path || !handle) return 999999; // ausente → falha e repete o poll
      const matrix = path.getScreenCTM();
      if (!matrix) return 999999;
      const origin = path.getPointAtLength(0).matrixTransform(matrix);
      const rect = handle.getBoundingClientRect();
      return Math.hypot(origin.x - (rect.x + rect.width / 2), origin.y - (rect.y + rect.height / 2));
    }, [`.react-flow__edge[data-id="${newId}:out"]`, `.react-flow__node[data-id="${newId}"]`])
  ).toBeLessThanOrEqual(6);

  // Salvar: PUT 200 com revisão 2 (upsert do editor).
  const putSave = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith(`/qualification/flows/${flowId}`));
  await page.getByRole("button", { name: "Salvar", exact: true }).first().click();
  const saved = await putSave;
  expect(saved.status()).toBe(200);
  expect(((await saved.json()) as { flow: { revisao: number } }).flow.revisao).toBe(2);

  // Recarregar: a API devolve start/newId.next e revisão nova.
  const getAfterReload = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith(`/qualification/flows/${flowId}`));
  const [reloaded] = await Promise.all([getAfterReload, page.reload()]);
  expect(reloaded.status()).toBe(200);
  // GET /qualification/flows/:id devolve {flow:{...}} (backend qualification/routes.ts:128).
  const api = (await reloaded.json()) as { flow: { revisao: number; definition: { start: string; steps: Record<string, { next?: string }> } } };
  expect(api.flow.revisao).toBe(2);
  expect(api.flow.definition.start).toBe(newId);
  expect(api.flow.definition.steps[newId]?.next).toBe("E1");

  // Banco: revisão 2 e snapshot v2 com o grafo gatilho → mensagem → E1.
  const savedRow = (await pool.query<{ revision: number }>(
    "SELECT revision FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [tenantId, flowId]
  )).rows[0];
  expect(savedRow.revision).toBe(2);
  const v2 = (await pool.query<{ definition: unknown }>(
    "SELECT definition FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2 AND version=2", [tenantId, flowId]
  )).rows[0];
  const def = v2.definition as { start: string; steps: Record<string, { kind: string; message?: string; next?: string }> };
  expect(def.start).toBe(newId);
  expect(def.steps[newId]).toMatchObject({ kind: "message", message: messageText, next: "E1" });

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

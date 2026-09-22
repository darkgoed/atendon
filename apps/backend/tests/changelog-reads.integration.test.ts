// F3-r1 — read-state por usuário (SPEC: tests/changelog-reads.integration.test.ts).
// 2 usuários independentes, idempotência, estabilidade per-post, user_id do body ignorado.
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "light-my-request";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { buildChangelogApp, createTenant, createWorkspaceUser, insertUser, sessionCookieFor } from "./helpers/changelog-app.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildChangelogApp();
let userACookie = "";
let userBCookie = "";
let rootCookie = "";

type Method = "GET" | "POST";
async function inject(method: Method, url: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
  const injectOptions: InjectOptions = { method, url };
  if (options.cookie) injectOptions.headers = { cookie: options.cookie };
  if (options.payload !== undefined) injectOptions.payload = options.payload as InjectOptions["payload"];
  return app.inject(injectOptions);
}

async function publishPost(publishedAt: string): Promise<{ id: string; slug: string }> {
  const slug = `reads-${randomUUID().slice(0, 10)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO changelog_posts (slug,title,summary,published,published_at) VALUES ($1,'Novidades','Resumo',true,$2) RETURNING id`,
    [slug, publishedAt]
  );
  return { id: result.rows[0].id, slug };
}

beforeAll(async () => {
  await app.ready();
  const tenant = await createTenant(pool);
  const userA = await createWorkspaceUser(pool, tenant);
  const userB = await createWorkspaceUser(pool, tenant);
  const root = await insertUser(pool, true);
  userACookie = await sessionCookieFor(userA.id, userA.email, false, tenant);
  userBCookie = await sessionCookieFor(userB.id, userB.email, false, tenant);
  rootCookie = await sessionCookieFor(root.id, root.email, true);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("changelog painel — unread/read", () => {
  it("leituras independentes, idempotentes, com estabilidade per-post e flag read no feed", async () => {
    // Timestamps FUTUROS (2099): elegíveis (elegibilidade não filtra futuro) e no topo
    // global — latestPost e flag read no feed ficam determinísticos mesmo com os outros
    // arquivos da suíte publicando now()/passado em paralelo.
    const postNew = await publishPost("2099-01-02T10:00:00Z");
    const postOld = await publishPost("2099-01-01T10:00:00Z");

    const unreadA = await inject("GET", "/panel/changelog/unread", { cookie: userACookie });
    expect(unreadA.statusCode).toBe(200);
    // latestPost por SLUG (não por posição): 2099-01-02 é o mais novo elegível global.
    // Category é o DEFAULT 'outro' — INSERT direto via SQL não define category.
    expect(unreadA.json().latestPost).toMatchObject({ slug: postNew.slug, category: "outro" });

    // Delta cross-time: captura ANTES da leitura (imune a posts de outros arquivos em paralelo).
    const unreadBBefore = ((await inject("GET", "/panel/changelog/unread", { cookie: userBCookie })).json()).count as number;
    // B lê só o post NOVO: o post ANTIGO continua no unread de B (estado per-post).
    expect((await inject("POST", "/panel/changelog/read", { cookie: userBCookie, payload: { postId: postNew.id } })).statusCode).toBe(204);
    const unreadB = (await inject("GET", "/panel/changelog/unread", { cookie: userBCookie })).json();
    expect(unreadB.count).toBe(unreadBBefore - 1);

    // A lê o antigo 2× → idempotente (204, count inalterado).
    expect((await inject("POST", "/panel/changelog/read", { cookie: userACookie, payload: { postId: postOld.id } })).statusCode).toBe(204);
    const countAfterFirstRead = ((await inject("GET", "/panel/changelog/unread", { cookie: userACookie })).json()).count as number;
    expect((await inject("POST", "/panel/changelog/read", { cookie: userACookie, payload: { postId: postOld.id } })).statusCode).toBe(204);
    expect(((await inject("GET", "/panel/changelog/unread", { cookie: userACookie })).json()).count).toBe(countAfterFirstRead);

    // Feed com flag read POR SLUG (nunca por posição — o feed é global entre arquivos).
    const feedA = (await inject("GET", "/panel/changelog/feed?limit=10", { cookie: userACookie })).json() as { posts: Array<{ slug: string; read: boolean }> };
    const feedB = (await inject("GET", "/panel/changelog/feed?limit=10", { cookie: userBCookie })).json() as { posts: Array<{ slug: string; read: boolean }> };
    expect(feedA.posts.find((post) => post.slug === postOld.slug)?.read).toBe(true);
    expect(feedA.posts.find((post) => post.slug === postNew.slug)?.read).toBe(false);
    expect(feedB.posts.find((post) => post.slug === postNew.slug)?.read).toBe(true);
    expect(feedB.posts.find((post) => post.slug === postOld.slug)?.read).toBe(false);
  });

  it("postId não elegível → 404; user_id do body ignorado (sempre sessão); não autenticado → 401", async () => {
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO changelog_posts (slug,title,published) VALUES ($1,'Rascunho',false) RETURNING id`,
      [`draft-${randomUUID().slice(0, 10)}`]
    );
    expect((await inject("POST", "/panel/changelog/read", { cookie: userACookie, payload: { postId: draft.rows[0].id } })).statusCode).toBe(404);

    const otherUser = await pool.query<{ id: string }>(
      `INSERT INTO changelog_posts (slug,title,summary,published,published_at) VALUES ($1,'Outro','Resumo',true,now()) RETURNING id`,
      [`other-${randomUUID().slice(0, 10)}`]
    );
    await inject("POST", "/panel/changelog/read", { cookie: userACookie, payload: { postId: otherUser.rows[0].id, userId: rootCookie } });
    const reads = await pool.query("SELECT count(*)::int AS count FROM changelog_reads WHERE post_id = $1", [otherUser.rows[0].id]);
    expect(reads.rows[0].count).toBe(1);

    expect((await inject("GET", "/panel/changelog/unread")).statusCode).toBe(401);
    expect((await inject("GET", "/panel/changelog/feed")).statusCode).toBe(401);
    expect((await inject("POST", "/panel/changelog/read", { payload: { postId: otherUser.rows[0].id } })).statusCode).toBe(401);
  });
});

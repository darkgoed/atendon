// F3-r1 — rotas públicas /public/changelog (SPEC: tests/changelog-public-routes.integration.test.ts).
// Whitelist exata (toEqual), não-vazamento do legado por-tenant, 404 de tudo que não é elegível.
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "light-my-request";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { buildChangelogApp, insertUser, sessionCookieFor } from "./helpers/changelog-app.js";
import { sha256Of } from "../src/modules/changelog/media.js";
import { pngBytes } from "./helpers/changelog-app.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildChangelogApp();
const rootEmail = `changelog-public-${randomUUID()}@test.local`;
let rootCookie = "";
// Posts do teste de feed (globais) — removidos no afterAll; mídia/leitura cascateiam.
const feedTestSlugs: string[] = [];

type Method = "GET" | "POST";
async function inject(method: Method, url: string, cookie?: string) {
  const injectOptions: InjectOptions = { method, url };
  if (cookie) injectOptions.headers = { cookie };
  return app.inject(injectOptions);
}

interface PublicPost {
  slug: string;
  versionLabel: string | null;
  title: string;
  summary: string | null;
  category: string;
  author: string | null;
  publishedAt: string;
  contentText: string | null;
  relatedLinks: Array<{ label: string; url: string }>;
  modulesAffected: string[];
  affectedPlans: string[];
  media: Array<{ id: string; alt: string | null; mime: string }>;
}

beforeAll(async () => {
  await app.ready();
  const root = await insertUser(pool, true, rootEmail);
  rootCookie = await sessionCookieFor(root.id, root.email, true);
});

afterAll(async () => {
  await app.close();
  await pool.query("DELETE FROM changelog_posts WHERE slug = ANY($1)", [feedTestSlugs]);
  await pool.end();
});

async function insertPost(options: {
  slug: string;
  title: string;
  summary?: string;
  contentText?: string;
  published: boolean;
  publishedAt?: string;
  publishAt?: string | null;
  relatedLinks?: Array<{ label: string; url: string }>;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO changelog_posts (slug,title,summary,category,content_text,modules_affected,affected_plans,related_links,published,published_at,publish_at)
     VALUES ($1,$2,$3,'novo',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      options.slug,
      options.title,
      options.summary ?? null,
      options.contentText ?? null,
      ["painel"],
      [],
      JSON.stringify(options.relatedLinks ?? []),
      options.published,
      options.publishedAt ?? null,
      options.publishAt ?? null
    ]
  );
  return result.rows[0].id;
}

describe("changelog público — feed e permalink", () => {
  it("feed ordenado por chave relativa + paginação determinística (nextOffset null só no fim real)", async () => {
    const base = randomUUID().slice(0, 8);
    // Timestamps FUTUROS: elegíveis (a elegibilidade não filtra futuro) e no topo global —
    // imunes a posts now()/passado criados por outros arquivos da suíte em paralelo.
    const novoAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const antigoAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    // Controle positivo determinístico: post elegível DEPOIS do nosso antigo (+22h,
    // ainda na janela futura imune) — existe página seguinte ao nosso último post
    // próprio até isolado em DB limpo; nextOffset null só no fim REAL do feed.
    const controleAt = new Date(Date.now() + 22 * 60 * 60 * 1000).toISOString();
    await insertPost({ slug: `controle-${base}`, title: "Controle", summary: "s", published: true, publishedAt: controleAt });
    await insertPost({ slug: `antigo-${base}`, title: "Antigo", summary: "s", published: true, publishedAt: antigoAt });
    await insertPost({ slug: `novo-${base}`, title: "Novo", summary: "s", published: true, publishedAt: novoAt });
    feedTestSlugs.push(`controle-${base}`, `antigo-${base}`, `novo-${base}`);
    const full = (await inject("GET", "/public/changelog?limit=50")).json() as { posts: PublicPost[]; nextOffset: number | null };
    // O feed global do DB compartilhado pode ter ≥50 posts elegíveis: paginação
    // isomórfica exige a janela COMPLETA dos nossos 3 posts — busca só eles.
    const ours = full.posts.filter((post) => post.slug.endsWith(`-${base}`));
    expect(ours.map((post) => post.slug)).toEqual([`novo-${base}`, `antigo-${base}`, `controle-${base}`]);
    // Asserção RELATIVA (cross-time): ordem ENTRE os nossos posts, não posição absoluta no feed global.
    const idxNovo = full.posts.findIndex((post) => post.slug === `novo-${base}`);
    const idxAntigo = full.posts.findIndex((post) => post.slug === `antigo-${base}`);
    expect(idxNovo).toBeGreaterThanOrEqual(0);
    expect(idxAntigo).toBeGreaterThan(idxNovo);
    // Paginação é isomórfica ao feed completo: offset k devolve exatamente o post de índice k.
    const pageNovo = (await inject("GET", `/public/changelog?limit=1&offset=${idxNovo}`)).json() as { posts: PublicPost[]; nextOffset: number | null };
    expect(pageNovo.posts[0].slug).toBe(`novo-${base}`);
    expect(pageNovo.nextOffset).toBe(idxNovo + 1);
    // O fim dos NOSSOS posts NÃO é o fim do feed: âncora relativa ao antigo — o
    // controle garante página seguinte (RED se alguém voltar a exigir null aqui).
    const lastOffset = idxAntigo;
    const last = (await inject("GET", `/public/changelog?limit=1&offset=${lastOffset}`)).json() as { posts: PublicPost[]; nextOffset: number | null };
    expect(last.posts[0].slug).toBe(full.posts[lastOffset].slug);
    expect(last.nextOffset).toBe(lastOffset + 1);
    // Fim REAL: segue nextOffset em chunks de 50 (teto público) até null — sem
    // overfit a count global nem a inserts concorrentes.
    let offset = lastOffset + 1;
    let ended = false;
    const tail: string[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const page = (await inject("GET", `/public/changelog?limit=50&offset=${offset}`)).json() as { posts: PublicPost[]; nextOffset: number | null };
      tail.push(...page.posts.map((post) => post.slug));
      if (page.nextOffset === null) { ended = true; break; }
      expect(page.nextOffset).toBe(offset + 50);
      offset = page.nextOffset;
    }
    expect(ended).toBe(true);
    expect(tail).toContain(`controle-${base}`);
  });

  it("permalink 200 com whitelist EXATA (toEqual)", async () => {
    const slug = `whitelist-${randomUUID().slice(0, 8)}`;
    // UM único buffer: com nonce por chamada, sha/tamanho/bytes precisam vir da MESMA geração.
    const bytes = pngBytes();
    const sha = sha256Of(bytes);
    const media = await pool.query<{ id: string }>(
      `INSERT INTO changelog_media (sha256,mime,size_bytes,data,alt) VALUES ($1,'image/png',$2,$3,'Print da tela') RETURNING id`,
      [sha, bytes.length, bytes]
    );
    const postId = await insertPost({
      slug,
      title: "Post whitelist",
      summary: "Resumo público",
      contentText: "Primeiro parágrafo.\n\nSegundo parágrafo.",
      published: true,
      publishedAt: "2026-09-05T12:30:00Z",
      relatedLinks: [{ label: "Docs", url: "https://atendon.example/docs" }]
    });
    await pool.query("INSERT INTO changelog_post_media (post_id,media_id,position) VALUES ($1,$2,0)", [postId, media.rows[0].id]);

    const response = await inject("GET", `/public/changelog/${slug}`);
    expect(response.statusCode).toBe(200);
    const post = response.json().post as PublicPost;
    expect(post).toEqual({
      slug,
      versionLabel: null,
      title: "Post whitelist",
      summary: "Resumo público",
      category: "novo",
      author: null,
      publishedAt: "2026-09-05T12:30:00.000Z",
      contentText: "Primeiro parágrafo.\n\nSegundo parágrafo.",
      relatedLinks: [{ label: "Docs", url: "https://atendon.example/docs" }],
      modulesAffected: ["painel"],
      affectedPlans: [],
      media: [{ id: media.rows[0].id, alt: "Print da tela", mime: "image/png" }]
    });
  });

  it("draft, agendado futuro, despublicado, excluído e inexistente → 404", async () => {
    const base = randomUUID().slice(0, 8);
    await insertPost({ slug: `draft-${base}`, title: "d", published: false });
    await insertPost({ slug: `futuro-${base}`, title: "f", summary: "s", published: false, publishAt: "2099-01-01T00:00:00Z" });
    await insertPost({ slug: `despub-${base}`, title: "u", summary: "s", published: false, publishedAt: "2026-09-01T10:00:00Z" });
    for (const slug of [`draft-${base}`, `futuro-${base}`, `despub-${base}`, `sumiu-${base}`]) {
      expect((await inject("GET", `/public/changelog/${slug}`)).statusCode).toBe(404);
    }
  });

  it("feed e permalink sem cookie/sessão e com payload whitelisted (chave por chave)", async () => {
    const base = randomUUID().slice(0, 8);
    await insertPost({ slug: `chaves-${base}`, title: "Chaves", summary: "s", published: true, publishedAt: "2026-09-03T10:00:00Z" });
    const response = await inject("GET", `/public/changelog/chaves-${base}`);
    expect(response.statusCode).toBe(200);
    const post = response.json().post as Record<string, unknown>;
    expect(Object.keys(post).sort()).toEqual([
      "affectedPlans", "author", "category", "contentText", "media", "modulesAffected",
      "publishedAt", "relatedLinks", "slug", "summary", "title", "versionLabel"
    ]);
    const feed = (await inject("GET", "/public/changelog")).json() as { posts: Array<Record<string, unknown>> };
    for (const item of feed.posts) {
      expect(Object.keys(item).sort()).toEqual([
        "affectedPlans", "author", "category", "contentText", "media", "modulesAffected",
        "publishedAt", "relatedLinks", "slug", "summary", "title", "versionLabel"
      ]);
    }
  });
});

describe("changelog público — não-vazamento do legado por-tenant", () => {
  it("post de import de release GLOBAL nunca expõe campos do legado; release TENANT nunca gera post nem aparece", async () => {
    // Release GLOBAL publicada (legado, intocado) — simula proveniência de import curado.
    const globalSha = randomUUID().replaceAll("-", "").slice(0, 40);
    const globalRelease = await pool.query<{ id: string }>(
      `INSERT INTO releases (version,classification,commit_sha,scope,tenant_slugs_detected,technical_changelog,public_title,public_summary,published)
       VALUES ('9.9.9','RELEASE',$1,'GLOBAL','{}','commit interno confidencial','Título técnico legado','Resumo legado',true)
       RETURNING id`,
      [globalSha]
    );
    const tenantSha = randomUUID().replaceAll("-", "").slice(0, 40);
    await pool.query(
      `INSERT INTO releases (version,classification,commit_sha,scope,tenant_slugs_detected,public_title,public_summary,published)
       VALUES ('9.9.8','RELEASE',$1,'TENANT','{"tenant-restrito-xyz"}','Funcionalidade da empresa X','Resumo restrito',true)`,
      [tenantSha]
    );
    const slug = `import-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO changelog_posts (slug,title,summary,content_text,release_id,published,published_at)
       VALUES ($1,'Post importado','Resumo importado','Parágrafo importado.',$2,true,now())`,
      [slug, globalRelease.rows[0].id]
    );

    const response = await inject("GET", `/public/changelog/${slug}`);
    expect(response.statusCode).toBe(200);
    const post = response.json().post as Record<string, unknown>;
    for (const banned of [
      "releaseId", "release_id", "createdByUserId", "created_by_user_id", "publishAt", "publish_at", "id",
      "tenantSlugsDetected", "tenant_slugs_detected", "technicalChangelog", "technical_changelog",
      "diffExcerpt", "diff_excerpt", "commitSha", "commit_sha", "commitMessages", "commit_messages",
      "filesChanged", "files_changed", "additions", "deletions", "aiStatus", "ai_status", "buildNumber",
      "build_number", "manualOverride", "scope"
    ]) {
      expect(post[banned]).toBeUndefined();
    }
    const serialized = JSON.stringify(post);
    expect(serialized).not.toContain("confidencial");
    expect(serialized).not.toContain(globalSha);
    expect(serialized).not.toContain("tenant-restrito-xyz");

    // Release com escopo TENANT: nenhum post gerado, nada no feed (prova de ausência).
    const tenantPosts = await pool.query("SELECT count(*)::int AS count FROM changelog_posts WHERE release_id = (SELECT id FROM releases WHERE commit_sha=$1)", [tenantSha]);
    expect(tenantPosts.rows[0].count).toBe(0);
    const feed = JSON.stringify(await inject("GET", "/public/changelog?limit=50").then((r) => r.json()));
    expect(feed).not.toContain("Funcionalidade da empresa X");
    expect(feed).not.toContain("9.9.8");
    void rootCookie;
  });
});

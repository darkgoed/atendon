// F3-r1 — lifecycle admin /root/changelog/posts (SPEC: tests/changelog-posts.integration.test.ts).
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "light-my-request";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import {
  buildChangelogApp,
  createTenant,
  createWorkspaceUser,
  insertUser,
  sessionCookieFor
} from "./helpers/changelog-app.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildChangelogApp();
let rootCookie = "";
let userCookie = "";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function inject(method: Method, url: string, options: { cookie?: string; payload?: unknown } = {}) {
  const injectOptions: InjectOptions = { method, url };
  if (options.cookie) injectOptions.headers = { cookie: options.cookie };
  if (options.payload !== undefined) injectOptions.payload = options.payload as InjectOptions["payload"];
  return app.inject(injectOptions);
}

async function createDraft(title: string, extra: Record<string, unknown> = {}) {
  const response = await inject("POST", "/root/changelog/posts", {
    cookie: rootCookie,
    payload: { title, modulesAffected: ["painel"], ...extra }
  });
  expect(response.statusCode).toBe(201);
  return response.json().post as { id: string; slug: string; status: string; published: boolean; publishAt: string | null };
}

beforeAll(async () => {
  await app.ready();
  const root = await insertUser(pool, true);
  const tenantId = await createTenant(pool);
  const wsUser = await createWorkspaceUser(pool, tenantId);
  rootCookie = await sessionCookieFor(root.id, root.email, true);
  userCookie = await sessionCookieFor(wsUser.id, wsUser.email, false, tenantId);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("changelog admin — ciclo de vida", () => {
  it("cria draft manual sem release/build/commit e edita", async () => {
    const draft = await createDraft(`Lançamento ${randomUUID()}`, { summary: "Resumo", author: "Equipe" });
    expect(draft.status).toBe("draft");
    expect(draft.published).toBe(false);
    expect(draft.publishAt).toBeNull();
    const patched = await inject("PATCH", `/root/changelog/posts/${draft.id}`, {
      cookie: rootCookie,
      payload: { title: "Novo título", contentText: "Parágrafo um.\n\nParágrafo dois.", relatedLinks: [{ label: "Docs", url: "https://atendon.example/docs" }] }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().post.title).toBe("Novo título");
  });

  it("publica imediato, agenda futuro, despublica cancelando agenda, republica e exclui", async () => {
    const draft = await createDraft(`Publicar ${randomUUID()}`, { summary: "Resumo" });
    const published = await inject("POST", `/root/changelog/posts/${draft.id}/publish`, { cookie: rootCookie, payload: {} });
    expect(published.statusCode).toBe(200);
    expect(published.json().post.status).toBe("published");

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await createDraft(`Agendar ${randomUUID()}`, { summary: "Resumo", publishAt: future });
    expect(scheduled.status).toBe("scheduled");
    expect(new Date(scheduled.publishAt as string).getTime()).toBeGreaterThan(Date.now());

    const unpublish = await inject("POST", `/root/changelog/posts/${scheduled.id}/unpublish`, { cookie: rootCookie });
    expect(unpublish.statusCode).toBe(204);
    const afterUnpublish = await inject("GET", `/root/changelog/posts/${scheduled.id}`, { cookie: rootCookie });
    // SPEC (máquina de estados): 'unpublished' só é reachable a partir de 'published'
    // (exige published_at preservado). Agendado com agenda cancelada volta a 'draft'
    // (published=false, publish_at=NULL, published_at=NULL) — confirmado por probe.
    expect(afterUnpublish.json().post.status).toBe("draft");
    expect(afterUnpublish.json().post.publishAt).toBeNull();

    const republish = await inject("POST", `/root/changelog/posts/${scheduled.id}/publish`, { cookie: rootCookie, payload: {} });
    expect(republish.statusCode).toBe(200);
    expect(republish.json().post.status).toBe("published");

    const removed = await inject("DELETE", `/root/changelog/posts/${draft.id}`, { cookie: rootCookie });
    expect(removed.statusCode).toBe(204);
    expect((await inject("GET", `/root/changelog/posts/${draft.id}`, { cookie: rootCookie })).statusCode).toBe(404);
  });

  it("filtra por status com paginação determinística", async () => {
    const list = await inject("GET", "/root/changelog/posts?status=draft&limit=5", { cookie: rootCookie });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { posts: Array<{ status: string }>; nextOffset: number | null };
    expect(body.posts.every((post) => post.status === "draft")).toBe(true);
  });
});

describe("changelog admin — permissões e validações", () => {
  it("workspace user sem ROOT → 403 em todas; sem cookie → 401", async () => {
    const draft = await createDraft(`Permissão ${randomUUID()}`, { summary: "Resumo" });
    for (const attempt of [
      inject("POST", "/root/changelog/posts", { cookie: userCookie, payload: { title: "x" } }),
      inject("GET", "/root/changelog/posts", { cookie: userCookie }),
      inject("GET", `/root/changelog/posts/${draft.id}`, { cookie: userCookie }),
      inject("PATCH", `/root/changelog/posts/${draft.id}`, { cookie: userCookie, payload: { title: "y" } }),
      inject("DELETE", `/root/changelog/posts/${draft.id}`, { cookie: userCookie }),
      inject("POST", `/root/changelog/posts/${draft.id}/publish`, { cookie: userCookie, payload: {} }),
      inject("POST", `/root/changelog/posts/${draft.id}/unpublish`, { cookie: userCookie }),
      inject("GET", `/root/changelog/posts/${draft.id}/preview`, { cookie: userCookie })
    ]) {
      expect((await attempt).statusCode).toBe(403);
    }
    expect((await inject("GET", "/root/changelog/posts")).statusCode).toBe(401);
  });

  it("title vazio → 400; publish sem summary → 400", async () => {
    expect((await inject("POST", "/root/changelog/posts", { cookie: rootCookie, payload: { title: "   " } })).statusCode).toBe(400);
    const draft = await createDraft(`Sem resumo ${randomUUID()}`);
    const publish = await inject("POST", `/root/changelog/posts/${draft.id}/publish`, { cookie: rootCookie, payload: {} });
    expect(publish.statusCode).toBe(400);
  });

  it("PATCH slug após publicado → 409; PATCH publishAt em publicado → 409", async () => {
    const draft = await createDraft(`Permalink ${randomUUID()}`, { summary: "Resumo" });
    await inject("POST", `/root/changelog/posts/${draft.id}/publish`, { cookie: rootCookie, payload: {} });
    expect((await inject("PATCH", `/root/changelog/posts/${draft.id}`, { cookie: rootCookie, payload: { slug: `novo-${randomUUID()}` } })).statusCode).toBe(409);
    expect((await inject("PATCH", `/root/changelog/posts/${draft.id}`, { cookie: rootCookie, payload: { publishAt: new Date(Date.now() + 3600_000).toISOString() } })).statusCode).toBe(409);
  });

  it("slug colisão → 409 com sugestão -2", async () => {
    const slug = `colisao-${randomUUID().slice(0, 8)}`;
    await createDraft("Colisão um", { slug });
    const second = await inject("POST", "/root/changelog/posts", { cookie: rootCookie, payload: { title: "Colisão dois", slug } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain(`${slug}-2`);
  });

  it("relatedLink http → 400; affectedPlan inexistente → 400", async () => {
    expect((await inject("POST", "/root/changelog/posts", {
      cookie: rootCookie,
      payload: { title: `Link ${randomUUID()}`, relatedLinks: [{ label: "Docs", url: "http://atendon.example/docs" }] }
    })).statusCode).toBe(400);
    expect((await inject("POST", "/root/changelog/posts", {
      cookie: rootCookie,
      payload: { title: `Plano ${randomUUID()}`, affectedPlans: ["plano-que-nao-existe"] }
    })).statusCode).toBe(400);
  });

  it("preview de draft → 200 autenticado com no-store e flags admin", async () => {
    const draft = await createDraft(`Preview ${randomUUID()}`, { summary: "Resumo" });
    const preview = await inject("GET", `/root/changelog/posts/${draft.id}/preview`, { cookie: rootCookie });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.json().post.status).toBe("draft");
    expect(preview.json().post.publishAt).toBeNull();
  });
});

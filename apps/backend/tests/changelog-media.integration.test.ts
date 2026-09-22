// F3-r1 — mídia multipart condicional e revogável (SPEC: tests/changelog-media.integration.test.ts).
// Headers exatos (no-store), elegibilidade ANTES de 304, 413/415/400/409, revogação imediata.
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "light-my-request";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { replacePostMedia } from "../src/modules/changelog/repository.js";
import {
  buildChangelogApp,
  createTenant,
  createWorkspaceUser,
  exeBytes,
  gifBytes,
  htmlBytes,
  insertUser,
  jpegBytes,
  mp4Bytes,
  multipartBody,
  pngBytes,
  sessionCookieFor,
  svgBytes,
  webpBytes
} from "./helpers/changelog-app.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildChangelogApp();
let rootCookie = "";
let userCookie = "";
let tenantId = "";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function inject(method: Method, url: string, options: { cookie?: string; payload?: Buffer | Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const injectOptions: InjectOptions = { method, url };
  if (options.cookie) injectOptions.headers = { ...options.headers, cookie: options.cookie };
  else if (options.headers) injectOptions.headers = options.headers;
  if (options.payload !== undefined) injectOptions.payload = options.payload as InjectOptions["payload"];
  return app.inject(injectOptions);
}

async function upload(data: Buffer, mime: string, extra: Record<string, string> = {}) {
  const body = multipartBody([
    ...Object.entries(extra).map(([name, value]) => ({ name, value })),
    { name: "file", data, mime, filename: "arquivo" }
  ]);
  return inject("POST", "/root/changelog/media", { cookie: rootCookie, payload: body.payload, headers: body.headers });
}

async function createPost(options: { published: boolean; publishedAt?: string }): Promise<string> {
  const slug = `media-${randomUUID().slice(0, 10)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO changelog_posts (slug,title,summary,published,published_at) VALUES ($1,'Post mídia','Resumo',$2,$3) RETURNING id`,
    [slug, options.published, options.publishedAt ?? null]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const root = await insertUser(pool, true);
  tenantId = await createTenant(pool);
  const wsUser = await createWorkspaceUser(pool, tenantId);
  rootCookie = await sessionCookieFor(root.id, root.email, true);
  userCookie = await sessionCookieFor(wsUser.id, wsUser.email, false, tenantId);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("changelog mídia — upload admin", () => {
  it("PNG/JPEG/GIF/WEBP/MP4 → 201; re-upload idêntico → mesmo id", async () => {
    for (const [data, mime] of [[pngBytes(), "image/png"], [jpegBytes(), "image/jpeg"], [gifBytes(), "image/gif"], [webpBytes(), "image/webp"], [mp4Bytes(), "video/mp4"]] as const) {
      const response = await upload(data, mime);
      expect(response.statusCode).toBe(201);
      const media = response.json().media as { id: string; sha256: string; mime: string; sizeBytes: number; alt: string | null };
      expect(media.mime).toBe(mime);
      expect(media.sizeBytes).toBe(data.length);
      const again = await upload(data, mime);
      expect(again.json().media.id).toBe(media.id);
    }
  });

  it("declared ≠ magic bytes → 415; SVG/HTML/EXE → 415; >10MB → 413; vazio/sem campo → 400", async () => {
    expect((await upload(jpegBytes(), "image/png")).statusCode).toBe(415);
    expect((await upload(svgBytes(), "image/svg+xml")).statusCode).toBe(415);
    expect((await upload(htmlBytes(), "text/html")).statusCode).toBe(415);
    expect((await upload(exeBytes(), "application/x-msdownload")).statusCode).toBe(415);
    const big = Buffer.concat([pngBytes(), Buffer.alloc(10 * 1024 * 1024, 1)]);
    expect((await upload(big, "image/png")).statusCode).toBe(413);
    const emptyBody = multipartBody([{ name: "file", data: Buffer.alloc(0), mime: "image/png", filename: "vazio" }]);
    expect((await inject("POST", "/root/changelog/media", { cookie: rootCookie, payload: emptyBody.payload, headers: emptyBody.headers })).statusCode).toBe(400);
    const noFile = multipartBody([{ name: "alt", value: "sem arquivo" }]);
    expect((await inject("POST", "/root/changelog/media", { cookie: rootCookie, payload: noFile.payload, headers: noFile.headers })).statusCode).toBe(400);
    expect((await inject("POST", "/root/changelog/media", { cookie: userCookie })).statusCode).toBe(403);
  });

  it("PUT media substitui conjunto completo; DELETE referenciada → 409; PATCH alt; lista sem data", async () => {
    const a = (await upload(pngBytes(), "image/png", { alt: "A" })).json().media as { id: string };
    const b = (await upload(gifBytes(), "image/gif")).json().media as { id: string };
    const post = await createPost({ published: false });
    const put = await inject("PUT", `/root/changelog/posts/${post}/media`, { cookie: rootCookie, payload: { mediaIds: [b.id, a.id] } });
    expect(put.statusCode).toBe(200);
    const list = put.json().media as Array<{ id: string }>;
    expect(list.map((item) => item.id)).toEqual([b.id, a.id]);

    const dup = await inject("PUT", `/root/changelog/posts/${post}/media`, { cookie: rootCookie, payload: { mediaIds: [a.id, a.id] } });
    expect((dup.json().media as Array<{ id: string }>).map((item) => item.id)).toEqual([a.id]);
    expect((await inject("PUT", `/root/changelog/posts/${post}/media`, { cookie: rootCookie, payload: { mediaIds: [randomUUID()] } })).statusCode).toBe(404);

    expect((await inject("DELETE", `/root/changelog/media/${a.id}`, { cookie: rootCookie })).statusCode).toBe(409);
    const detach = await inject("PUT", `/root/changelog/posts/${post}/media`, { cookie: rootCookie, payload: { mediaIds: [] } });
    expect(detach.statusCode).toBe(200);
    expect((await inject("DELETE", `/root/changelog/media/${a.id}`, { cookie: rootCookie })).statusCode).toBe(204);

    const patched = await inject("PATCH", `/root/changelog/media/${b.id}`, { cookie: rootCookie, payload: { alt: "GIF animado" } });
    expect(patched.json().media.alt).toBe("GIF animado");
    expect((await inject("PATCH", `/root/changelog/media/${randomUUID()}`, { cookie: rootCookie, payload: { alt: "x" } })).statusCode).toBe(404);

    const listing = await inject("GET", "/root/changelog/media?limit=10", { cookie: rootCookie });
    expect(listing.statusCode).toBe(200);
    expect(JSON.stringify(listing.json())).not.toContain('"data"');
  });

  it("replacePostMedia é transacional: FK violation no INSERT preserva as mídias antigas (rollback)", async () => {
    const keep = (await upload(pngBytes(), "image/png", { alt: "mantida" })).json().media as { id: string };
    const post = await createPost({ published: false });
    await pool.query("INSERT INTO changelog_post_media (post_id,media_id,position) VALUES ($1,$2,0)", [post, keep.id]);

    // Direto no repository (sem a pré-validação da rota): mídia inexistente →
    // FK violation depois do DELETE — o rollback deve manter a mídia antiga.
    await expect(replacePostMedia(post, [randomUUID()])).rejects.toThrow();

    const survived = await pool.query<{ media_id: string }>(
      "SELECT media_id FROM changelog_post_media WHERE post_id = $1",
      [post]
    );
    expect(survived.rows.map((row) => row.media_id)).toEqual([keep.id]);
  });
});

describe("changelog mídia — revogabilidade pública", () => {
  it("200 no-store p/ post elegível; 304 só com elegibilidade re-verificada; unpublish → 404; draft → 404; delete de post → 404", async () => {
    const media = (await upload(pngBytes(), "image/png", { alt: "Print" })).json().media as { id: string };
    const publishedPost = await createPost({ published: true, publishedAt: "2026-09-10T10:00:00Z" });
    await pool.query("INSERT INTO changelog_post_media (post_id,media_id,position) VALUES ($1,$2,0)", [publishedPost, media.id]);
    const draftPost = await createPost({ published: false });
    const draftMedia = (await upload(gifBytes(), "image/gif")).json().media as { id: string };
    await pool.query("INSERT INTO changelog_post_media (post_id,media_id,position) VALUES ($1,$2,0)", [draftPost, draftMedia.id]);

    const ok = await inject("GET", `/public/changelog/media/${media.id}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["content-type"]).toBe("image/png");

    const etag = ok.headers.etag as string;
    expect(typeof etag).toBe("string");
    const conditional = await inject("GET", `/public/changelog/media/${media.id}`, { headers: { "if-none-match": etag } });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers["cache-control"]).toBe("no-store");

    // Elegibilidade ANTES de 304: draft com If-None-Match válido → 404, nunca 304.
    const draftEtag = (await inject("GET", `/public/changelog/media/${draftMedia.id}`)).statusCode;
    expect(draftEtag).toBe(404);
    const draftConditional = await inject("GET", `/public/changelog/media/${draftMedia.id}`, { headers: { "if-none-match": etag } });
    expect(draftConditional.statusCode).toBe(404);
    expect(draftConditional.headers["cache-control"]).toBe("no-store");

    // Preview admin de draft com mídia → 200 autenticado no-store.
    const preview = await inject("GET", `/root/changelog/posts/${draftPost}/preview`, { cookie: rootCookie });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect((preview.json().post.media as Array<{ id: string }>)[0].id).toBe(draftMedia.id);

    // unpublish → GET público 404 no request seguinte (sem janela residual).
    const unpublished = await inject("POST", `/root/changelog/posts/${publishedPost}/unpublish`, { cookie: rootCookie });
    expect(unpublished.statusCode).toBe(204);
    const revoked = await inject("GET", `/public/changelog/media/${media.id}`, { headers: { "if-none-match": etag } });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.headers["cache-control"]).toBe("no-store");

    // Bytes admin continuam acessíveis (no-store).
    const adminBytes = await inject("GET", `/root/changelog/media/${media.id}/bytes`, { cookie: rootCookie });
    expect(adminBytes.statusCode).toBe(200);
    expect(adminBytes.headers["cache-control"]).toBe("no-store");

    // Delete do post → mídia fica órfã → 404 no público.
    await inject("DELETE", `/root/changelog/posts/${draftPost}`, { cookie: rootCookie });
    expect((await inject("GET", `/public/changelog/media/${draftMedia.id}`)).statusCode).toBe(404);
  });
});

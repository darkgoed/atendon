// F3-r1 — worker de agendamento do changelog (SPEC: tests/changelog-worker.integration.test.ts).
// Só posts, nunca releases; idempotente; sem re-publicação de despublicado/draft; zero sync.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { publishScheduledChangelogPosts } from "../src/modules/changelog/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function insertScheduledPost(options: { summary?: string; publishAt?: string | null; publishedAt?: string | null }): Promise<string> {
  const slug = `worker-${randomUUID().slice(0, 10)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO changelog_posts (slug,title,summary,published,published_at,publish_at)
     VALUES ($1,'Worker post',$2,false,$3,$4) RETURNING id`,
    [slug, options.summary ?? null, options.publishedAt ?? null, options.publishAt ?? null]
  );
  return result.rows[0].id;
}

describe("changelog worker — publicação agendada", () => {
  it("agendada vencida publica no tick; futura/draft/despublicada intocadas", async () => {
    const vencida = await insertScheduledPost({ summary: "s", publishAt: "2026-01-01T00:00:00Z" });
    const futura = await insertScheduledPost({ summary: "s", publishAt: "2099-01-01T00:00:00Z" });
    const draft = await insertScheduledPost({});
    const despublicada = await insertScheduledPost({ summary: "s", publishedAt: "2026-01-01T00:00:00Z" });

    const published = await publishScheduledChangelogPosts(pool);
    expect(published).toContain(vencida);
    expect(published).not.toContain(futura);
    expect(published).not.toContain(draft);
    expect(published).not.toContain(despublicada);

    const states = await pool.query<{ id: string; published: boolean; publish_at: Date | null }>(
      "SELECT id, published, publish_at FROM changelog_posts WHERE id = ANY($1::uuid[])",
      [[vencida, futura, draft, despublicada]]
    );
    const byId = new Map(states.rows.map((row) => [row.id, row]));
    expect(byId.get(vencida)?.published).toBe(true);
    expect(byId.get(vencida)?.publish_at).toBeNull();
    expect(byId.get(futura)?.published).toBe(false);
    expect(byId.get(futura)?.publish_at).not.toBeNull();
    expect(byId.get(draft)?.published).toBe(false);
    expect(byId.get(draft)?.publish_at).toBeNull();
    expect(byId.get(despublicada)?.published).toBe(false);
    expect(byId.get(despublicada)?.publish_at).toBeNull();
  });

  it("idempotente: 2ª execução publica 0 rows", async () => {
    const post = await insertScheduledPost({ summary: "s", publishAt: "2026-01-02T00:00:00Z" });
    expect(await publishScheduledChangelogPosts(pool)).toContain(post);
    expect(await publishScheduledChangelogPosts(pool)).not.toContain(post);
    expect(await publishScheduledChangelogPosts(pool)).toEqual([]);
  });

  it("worker não toca releases e nunca cria post por re-publish de release (sync removido)", async () => {
    const sha = randomUUID().replaceAll("-", "").slice(0, 40);
    const release = await pool.query<{ id: string; published: boolean }>(
      `INSERT INTO releases (version,classification,commit_sha,scope,public_title,public_summary,published)
       VALUES ('8.8.8','RELEASE',$1,'GLOBAL','Título','Resumo',false) RETURNING id, published`,
      [sha]
    );
    const before = release.rows[0];
    await publishScheduledChangelogPosts(pool);
    const after = await pool.query<{ published: boolean; published_at: Date | null }>(
      "SELECT published, published_at FROM releases WHERE id = $1",
      [before.id]
    );
    expect(after.rows[0].published).toBe(false);
    expect(after.rows[0].published_at).toBeNull();
    const posts = await pool.query("SELECT count(*)::int AS count FROM changelog_posts WHERE release_id = $1", [before.id]);
    expect(posts.rows[0].count).toBe(0);
  });
});

// F3-r1 — CHECKs e constraints da migration 0183 (SPEC: tests/changelog-migration.integration.test.ts).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe("changelog migration 0183 — constraints", () => {
  it("published ⇒ summary (23514)", async () => {
    await expect(pool.query(
      `INSERT INTO changelog_posts (slug,title,published,published_at) VALUES ($1,'t',true,now())`,
      [`mig-${randomUUID().slice(0, 10)}`]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("published ⇒ publish_at NULL (23514)", async () => {
    await expect(pool.query(
      `INSERT INTO changelog_posts (slug,title,summary,published,published_at,publish_at) VALUES ($1,'t','s',true,now(),'2099-01-01')`,
      [`mig-${randomUUID().slice(0, 10)}`]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("slug UNIQUE → 23505", async () => {
    const slug = `mig-unique-${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO changelog_posts (slug,title) VALUES ($1,'t1')`, [slug]);
    await expect(pool.query(`INSERT INTO changelog_posts (slug,title) VALUES ($1,'t2')`, [slug])).rejects.toMatchObject({ code: "23505" });
  });

  it("category inválida → 23514; slug fora do shape → 23514", async () => {
    const slugA = `mig-${randomUUID().slice(0, 10)}`;
    await expect(pool.query(
      `INSERT INTO changelog_posts (slug,title,category) VALUES ($1,'t','banana')`, [slugA]
    )).rejects.toMatchObject({ code: "23514" });
    const slugB = `Mig Invalido ${randomUUID().slice(0, 6)}`;
    await expect(pool.query(
      `INSERT INTO changelog_posts (slug,title) VALUES ($1,'t')`, [slugB]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("release_id 1:1 (UNIQUE parcial) → 23505; category válida aceita", async () => {
    const release = await pool.query<{ id: string }>(
      `INSERT INTO releases (version,classification,commit_sha,scope,public_title,public_summary,published)
       VALUES ('7.7.7','RELEASE',$1,'GLOBAL','Título','Resumo',false) RETURNING id`,
      [randomUUID().replaceAll("-", "").slice(0, 40)]
    );
    const slugA = `mig-rel-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO changelog_posts (slug,title,summary,category,release_id,published,published_at)
       VALUES ($1,'t','s','melhoria',$2,true,now())`,
      [slugA, release.rows[0].id]
    );
    await expect(pool.query(
      `INSERT INTO changelog_posts (slug,title,summary,release_id) VALUES ($1,'t2','s2',$2)`,
      [`mig-rel-${randomUUID().slice(0, 8)}`, release.rows[0].id]
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("changelog_reads PK (user_id, post_id) → 23505 em duplicado; cascata de post", async () => {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id`,
      [`mig-${randomUUID()}@test.local`]
    );
    const post = await pool.query<{ id: string }>(
      `INSERT INTO changelog_posts (slug,title,summary,published,published_at) VALUES ($1,'t','s',true,now()) RETURNING id`,
      [`mig-reads-${randomUUID().slice(0, 8)}`]
    );
    await pool.query(`INSERT INTO changelog_reads (user_id,post_id) VALUES ($1,$2)`, [user.rows[0].id, post.rows[0].id]);
    await expect(pool.query(
      `INSERT INTO changelog_reads (user_id,post_id) VALUES ($1,$2)`,
      [user.rows[0].id, post.rows[0].id]
    )).rejects.toMatchObject({ code: "23505" });
    await pool.query(`DELETE FROM changelog_posts WHERE id = $1`, [post.rows[0].id]);
    const remaining = await pool.query("SELECT count(*)::int AS count FROM changelog_reads WHERE post_id = $1", [post.rows[0].id]);
    expect(remaining.rows[0].count).toBe(0);
  });
});

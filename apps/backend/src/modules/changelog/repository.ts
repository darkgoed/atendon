// F3-r1 — Changelog editorial GLOBAL (SPEC v3 / decisões A1–A14).
// Uma única timeline global: nenhuma coluna, filtro ou payload de tenant aqui.
// Zero sync runtime release→post: release_id nunca é escrito por este módulo.
import type { Pool } from "pg";
// withTransaction (BEGIN/COMMIT/ROLLBACK no client do pool) — mesmo padrão já
// usado por custom-fields e pelas próprias rotas do changelog (httpError).
import { withTransaction } from "../scheduling/service.js";

export interface ChangelogPostRow {
  id: string;
  release_id: string | null;
  version_label: string | null;
  slug: string;
  title: string;
  summary: string | null;
  category: string;
  author: string | null;
  content_text: string | null;
  modules_affected: string[];
  affected_plans: string[];
  related_links: Array<{ label: string; url: string }>;
  publish_at: Date | null;
  published: boolean;
  published_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChangelogMediaRow {
  id: string;
  sha256: string;
  mime: string;
  size_bytes: number;
  alt: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

export type Db = Pick<Pool, "query">;

export const CHANGELOG_CATEGORIES = ["novo", "melhoria", "correcao", "seguranca", "integracao", "performance", "outro"] as const;

// Elegibilidade pública única (fonte de verdade para feed, permalink e mídia).
const ELIGIBLE = "p.published = true AND p.publish_at IS NULL";
const ORDER = "ORDER BY COALESCE(p.publish_at, p.published_at) DESC, p.id DESC";

const POST_COLUMNS = `p.id, p.release_id, p.version_label, p.slug, p.title, p.summary, p.category,
  p.author, p.content_text, p.modules_affected, p.affected_plans, p.related_links,
  p.publish_at, p.published, p.published_at, p.created_by_user_id, p.created_at, p.updated_at`;
// Sem alias de tabela: INSERT ... RETURNING não aceita qualificação "p.".
const POST_COLUMNS_RAW = `id, release_id, version_label, slug, title, summary, category,
  author, content_text, modules_affected, affected_plans, related_links,
  publish_at, published, published_at, created_by_user_id, created_at, updated_at`;

function normalizeLinks(value: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { label: unknown; url: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({
      label: typeof item.label === "string" ? item.label : "",
      url: typeof item.url === "string" ? item.url : ""
    }))
    .filter((item) => item.label !== "" && item.url !== "");
}

export function deriveStatus(row: Pick<ChangelogPostRow, "published" | "publish_at" | "published_at">): "draft" | "scheduled" | "published" | "unpublished" {
  if (row.published) return "published";
  if (row.publish_at) return "scheduled";
  return row.published_at ? "unpublished" : "draft";
}

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug !== "") return slug.slice(0, 120).replace(/-+$/g, "");
  return `atendon-post-${Date.now()}`;
}

export interface CreatePostInput {
  title: string;
  summary?: string | null;
  slug?: string;
  category?: string;
  author?: string | null;
  contentText?: string | null;
  modulesAffected?: string[];
  affectedPlans?: string[];
  relatedLinks?: Array<{ label: string; url: string }>;
  publishAt?: Date | null;
}

export async function createPost(db: Db, input: CreatePostInput, userId: string | null): Promise<ChangelogPostRow> {
  const result = await db.query<ChangelogPostRow>(
    `INSERT INTO changelog_posts
      (title, summary, slug, category, author, content_text, modules_affected, affected_plans, related_links, publish_at, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${POST_COLUMNS_RAW}`,
    [
      input.title,
      input.summary ?? null,
      input.slug ?? null,
      input.category ?? "outro",
      input.author ?? null,
      input.contentText ?? null,
      input.modulesAffected ?? [],
      input.affectedPlans ?? [],
      JSON.stringify(input.relatedLinks ?? []),
      input.publishAt ?? null,
      userId
    ]
  );
  return { ...result.rows[0], related_links: normalizeLinks(result.rows[0].related_links) };
}

export type AdminStatusFilter = "draft" | "scheduled" | "published" | "unpublished" | "all";

const STATUS_PREDICATES: Record<Exclude<AdminStatusFilter, "all">, string> = {
  draft: "p.published = false AND p.publish_at IS NULL AND p.published_at IS NULL",
  scheduled: "p.published = false AND p.publish_at IS NOT NULL",
  published: "p.published = true",
  unpublished: "p.published = false AND p.publish_at IS NULL AND p.published_at IS NOT NULL"
};

export async function listPostsAdmin(db: Db, options: { status: AdminStatusFilter; limit: number; offset: number }): Promise<ChangelogPostRow[]> {
  const predicate = options.status === "all" ? "true" : STATUS_PREDICATES[options.status];
  const result = await db.query<ChangelogPostRow>(
    `SELECT ${POST_COLUMNS} FROM changelog_posts p WHERE ${predicate} ${ORDER} LIMIT $1 OFFSET $2`,
    [options.limit, options.offset]
  );
  return result.rows.map((row) => ({ ...row, related_links: normalizeLinks(row.related_links) }));
}

export async function getPostById(db: Db, id: string): Promise<ChangelogPostRow | null> {
  const result = await db.query<ChangelogPostRow>(`SELECT ${POST_COLUMNS} FROM changelog_posts p WHERE p.id = $1`, [id]);
  const row = result.rows[0];
  return row ? { ...row, related_links: normalizeLinks(row.related_links) } : null;
}

export async function getPostBySlug(db: Db, slug: string): Promise<ChangelogPostRow | null> {
  const result = await db.query<ChangelogPostRow>(`SELECT ${POST_COLUMNS} FROM changelog_posts p WHERE p.slug = $1`, [slug]);
  const row = result.rows[0];
  return row ? { ...row, related_links: normalizeLinks(row.related_links) } : null;
}

export async function listEligiblePosts(db: Db, limit: number, offset: number): Promise<ChangelogPostRow[]> {
  const result = await db.query<ChangelogPostRow>(
    `SELECT ${POST_COLUMNS} FROM changelog_posts p WHERE ${ELIGIBLE} ${ORDER} LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows.map((row) => ({ ...row, related_links: normalizeLinks(row.related_links) }));
}

export interface PatchPostInput {
  title?: string;
  summary?: string | null;
  category?: string;
  author?: string | null;
  contentText?: string | null;
  modulesAffected?: string[];
  affectedPlans?: string[];
  relatedLinks?: Array<{ label: string; url: string }>;
  slug?: string;
  publishAt?: Date | null;
}

export async function updatePost(db: Db, id: string, patch: PatchPostInput): Promise<ChangelogPostRow> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  // Guarda por VALOR (!== undefined), nunca por presença ("in"): o route constrói o
  // objeto com todas as chaves explícitas, e "x" in patch é true mesmo com undefined —
  // isso NULLava category/summary/content_text a cada PATCH (500 / perda de dados).
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.summary !== undefined) push("summary", patch.summary ?? null);
  if (patch.category !== undefined) push("category", patch.category);
  if (patch.author !== undefined) push("author", patch.author ?? null);
  if (patch.contentText !== undefined) push("content_text", patch.contentText ?? null);
  if (patch.modulesAffected !== undefined) push("modules_affected", patch.modulesAffected ?? []);
  if (patch.affectedPlans !== undefined) push("affected_plans", patch.affectedPlans ?? []);
  if (patch.relatedLinks !== undefined) push("related_links", JSON.stringify(patch.relatedLinks ?? []));
  if (patch.slug !== undefined) push("slug", patch.slug);
  if (patch.publishAt !== undefined) push("publish_at", patch.publishAt ?? null);
  const result = await db.query<ChangelogPostRow>(
    `UPDATE changelog_posts p SET ${sets.join(", ")} WHERE p.id = $1 RETURNING ${POST_COLUMNS}`,
    values
  );
  return { ...result.rows[0], related_links: normalizeLinks(result.rows[0].related_links) };
}

export async function deletePost(db: Db, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM changelog_posts WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// Máquina de publicação (SPEC "Estado"): futuro → scheduled; ausente/passado → published.
export async function setPostPublishState(db: Db, id: string, publishAt: Date | null): Promise<ChangelogPostRow> {
  const now = new Date();
  const immediate = !publishAt || publishAt.getTime() <= now.getTime();
  const result = immediate
    ? await db.query<ChangelogPostRow>(
        `UPDATE changelog_posts p SET published = true, published_at = now(), publish_at = NULL WHERE p.id = $1 RETURNING ${POST_COLUMNS}`,
        [id]
      )
    : await db.query<ChangelogPostRow>(
        `UPDATE changelog_posts p SET published = false, publish_at = $2 WHERE p.id = $1 RETURNING ${POST_COLUMNS}`,
        [id, publishAt]
      );
  return { ...result.rows[0], related_links: normalizeLinks(result.rows[0].related_links) };
}

// Despublicar SEMPRE cancela a agenda pendente (publish_at = NULL); published_at fica como histórico.
export async function unpublishPost(db: Db, id: string): Promise<ChangelogPostRow | null> {
  const result = await db.query<ChangelogPostRow>(
    `UPDATE changelog_posts p SET published = false, publish_at = NULL WHERE p.id = $1 RETURNING ${POST_COLUMNS}`,
    [id]
  );
  const row = result.rows[0];
  return row ? { ...row, related_links: normalizeLinks(row.related_links) } : null;
}

// Worker de agendamento: só posts, nunca releases; idempotente.
export async function publishScheduledChangelogPosts(db: Db): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE changelog_posts SET published = true, published_at = now(), publish_at = NULL
     WHERE published = false AND publish_at IS NOT NULL AND publish_at <= now()
     RETURNING id`
  );
  return result.rows.map((row) => row.id);
}

// --- Mídia ---

export async function upsertMedia(
  db: Db,
  input: { sha256: string; mime: string; sizeBytes: number; data: Buffer; alt: string | null },
  userId: string | null
): Promise<ChangelogMediaRow> {
  const result = await db.query<ChangelogMediaRow>(
    `INSERT INTO changelog_media (sha256, mime, size_bytes, data, alt, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO UPDATE SET alt = COALESCE(EXCLUDED.alt, changelog_media.alt)
     RETURNING id, sha256, mime, size_bytes, alt, created_by_user_id, created_at`,
    [input.sha256, input.mime, input.sizeBytes, input.data, input.alt, userId]
  );
  return result.rows[0];
}

export async function listMedia(db: Db, limit: number, offset: number): Promise<ChangelogMediaRow[]> {
  const result = await db.query<ChangelogMediaRow>(
    `SELECT id, sha256, mime, size_bytes, alt, created_by_user_id, created_at
     FROM changelog_media ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

export async function getMediaById(db: Db, id: string): Promise<ChangelogMediaRow | null> {
  const result = await db.query<ChangelogMediaRow>(
    `SELECT id, sha256, mime, size_bytes, alt, created_by_user_id, created_at FROM changelog_media WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getMediaBytes(db: Db, id: string): Promise<{ sha256: string; mime: string; data: Buffer } | null> {
  const result = await db.query<{ sha256: string; mime: string; data: Buffer }>(
    `SELECT sha256, mime, data FROM changelog_media WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateMediaAlt(db: Db, id: string, alt: string | null): Promise<ChangelogMediaRow | null> {
  const result = await db.query<ChangelogMediaRow>(
    `UPDATE changelog_media SET alt = $2 WHERE id = $1
     RETURNING id, sha256, mime, size_bytes, alt, created_by_user_id, created_at`,
    [id, alt]
  );
  return result.rows[0] ?? null;
}

export async function countMediaReferences(db: Db, mediaId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM changelog_post_media WHERE media_id = $1`,
    [mediaId]
  );
  return result.rows[0]?.count ?? 0;
}

export async function deleteMedia(db: Db, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM changelog_media WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// PUT /root/changelog/posts/:id/media — substitui o conjunto completo.
// ATÔMICO: DELETE + INSERTs numa única transação — falha no meio (ex. mídia
// apagada entre a checagem da rota e o INSERT → FK violation) faz ROLLBACK e
// preserva o conjunto anterior em vez de deixar o post sem mídias.
// Sem param db: a transação usa o client do pool global (withTransaction).
export async function replacePostMedia(postId: string, mediaIds: string[]): Promise<ChangelogMediaRow[]> {
  return withTransaction(async (client) => {
    await client.query("DELETE FROM changelog_post_media WHERE post_id = $1", [postId]);
    for (const [index, mediaId] of mediaIds.entries()) {
      await client.query(
        `INSERT INTO changelog_post_media (post_id, media_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [postId, mediaId, index]
      );
    }
    return listPostMedia(client, postId);
  });
}

export async function listPostMedia(db: Db, postId: string): Promise<ChangelogMediaRow[]> {
  const result = await db.query<ChangelogMediaRow>(
    `SELECT m.id, m.sha256, m.mime, m.size_bytes, m.alt, m.created_by_user_id, m.created_at
     FROM changelog_post_media pm JOIN changelog_media m ON m.id = pm.media_id
     WHERE pm.post_id = $1 ORDER BY pm.position, m.created_at`,
    [postId]
  );
  return result.rows;
}

// Predicado de elegibilidade da mídia pública — re-executado a cada request (sem cache de decisão).
export async function isMediaPubliclyEligible(db: Db, mediaId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM changelog_post_media m JOIN changelog_posts p ON p.id = m.post_id
     WHERE m.media_id = $1 AND p.published AND p.publish_at IS NULL LIMIT 1`,
    [mediaId]
  );
  return result.rows.length > 0;
}

// --- Read-state por usuário (painel "Novidades") ---

export async function countUnreadPosts(db: Db, userId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM changelog_posts p
     WHERE ${ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM changelog_reads r WHERE r.user_id = $1 AND r.post_id = p.id)`,
    [userId]
  );
  return result.rows[0]?.count ?? 0;
}

export async function getLatestEligiblePost(db: Db): Promise<Pick<ChangelogPostRow, "slug" | "title" | "category" | "published_at"> | null> {
  const result = await db.query<Pick<ChangelogPostRow, "slug" | "title" | "category" | "published_at">>(
    `SELECT p.slug, p.title, p.category, p.published_at FROM changelog_posts p WHERE ${ELIGIBLE} ${ORDER} LIMIT 1`
  );
  return result.rows[0] ?? null;
}

export interface FeedItem extends ChangelogPostRow {
  read: boolean;
}

export async function listFeedForUser(db: Db, userId: string, limit: number, offset: number): Promise<FeedItem[]> {
  const result = await db.query<ChangelogPostRow & { read: boolean }>(
    `SELECT ${POST_COLUMNS}, (r.user_id IS NOT NULL) AS read
     FROM changelog_posts p
     LEFT JOIN changelog_reads r ON r.post_id = p.id AND r.user_id = $1
     WHERE ${ELIGIBLE} ${ORDER} LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows.map((row) => ({ ...row, related_links: normalizeLinks(row.related_links), read: row.read }));
}

// user_id SEMPRE da sessão; post não elegível → null (rota responde 404); idempotente.
export async function markPostRead(db: Db, userId: string, postId: string): Promise<boolean> {
  const eligible = await db.query(
    `SELECT 1 FROM changelog_posts p WHERE p.id = $1 AND ${ELIGIBLE} LIMIT 1`,
    [postId]
  );
  if (eligible.rows.length === 0) return false;
  await db.query(`INSERT INTO changelog_reads (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, postId]);
  return true;
}

export async function getPlanNames(db: Db): Promise<Set<string>> {
  const result = await db.query<{ name: string }>(`SELECT name FROM plans`);
  return new Set(result.rows.map((row) => row.name));
}

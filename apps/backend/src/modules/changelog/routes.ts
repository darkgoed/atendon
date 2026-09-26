// F3-r1 — rotas do changelog editorial GLOBAL (SPEC v3 / decisões A1–A14).
// Plugin autocontido: registra @fastify/multipart no próprio escopo (dono único) e o
// mapeamento de erros para as suas rotas. NADA aqui é registrado em src/app.ts — o
// patch de registro é do worker de integração (A11): app.register(registerChangelogRoutes).
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.js";
import { requireRoot, requireWorkspace } from "../../auth/session.js";
import { httpError } from "../scheduling/service.js";
import {
  CHANGELOG_CATEGORIES,
  countMediaReferences,
  countUnreadPosts,
  createPost,
  deleteMedia,
  deletePost,
  deriveStatus,
  getLatestEligiblePost,
  getMediaById,
  getMediaBytes,
  getPlanNames,
  getPostById,
  getPostBySlug,
  listEligiblePosts,
  listFeedForUser,
  listMedia,
  listPostMedia,
  listPostsAdmin,
  markPostRead,
  isMediaPubliclyEligible,
  replacePostMedia,
  setPostPublishState,
  slugify,
  unpublishPost,
  updateMediaAlt,
  updatePost,
  upsertMedia,
  type ChangelogMediaRow,
  type ChangelogPostRow
} from "./repository.js";
import { mediaAltFromFields, readMediaFile, sha256Of, validateMediaMime, MEDIA_MAX_BYTES } from "./media.js";

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const categorySchema = z.enum(CHANGELOG_CATEGORIES);
const relatedLinkSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2000)
}).strict().refine((link) => {
  try {
    return new URL(link.url).protocol === "https:";
  } catch {
    return false;
  }
}, "relatedLinks aceita apenas URLs https");

const modulesAffectedSchema = z.array(z.string().trim().min(1).max(120)).max(50);
const affectedPlansSchema = z.array(z.string().trim().min(1).max(120)).max(50);

const createPostSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(600).optional(),
  slug: z.string().trim().max(120).optional(),
  category: categorySchema.optional(),
  author: z.string().trim().max(120).optional(),
  contentText: z.string().max(50_000).optional(),
  modulesAffected: modulesAffectedSchema.optional(),
  relatedLinks: z.array(relatedLinkSchema).max(50).optional(),
  affectedPlans: affectedPlansSchema.optional(),
  publishAt: z.coerce.date().optional()
}).strict();

const patchPostSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(600).nullable().optional(),
  category: categorySchema.optional(),
  author: z.string().trim().max(120).nullable().optional(),
  contentText: z.string().max(50_000).nullable().optional(),
  modulesAffected: modulesAffectedSchema.optional(),
  relatedLinks: z.array(relatedLinkSchema).max(50).optional(),
  affectedPlans: affectedPlansSchema.optional(),
  slug: z.string().trim().max(120).optional(),
  publishAt: z.coerce.date().nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

const publishSchema = z.object({ publishAt: z.coerce.date().optional() }).strict();
const idParams = z.object({ id: z.string().uuid() });
const mediaIdParams = z.object({ id: z.string().uuid() });
const mediaBytesParams = z.object({ id: z.string().uuid() });
const publicMediaParams = z.object({ mediaId: z.string().uuid() });
const slugParams = z.object({ slug: z.string().max(120) });
const adminListQuery = z.object({
  status: z.enum(["draft", "scheduled", "published", "unpublished", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const publicListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});
const mediaListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const replaceMediaSchema = z.object({ mediaIds: z.array(z.string().uuid()).max(100) }).strict();
const markReadSchema = z.object({ postId: z.string().uuid() });
const patchMediaSchema = z.object({ alt: z.string().trim().max(300).nullable() }).strict();

// Whitelist pública EXATA (SPEC: payload público fechado; banidos id interno, release_id,
// created_by_user_id, publish_at e qualquer campo herdado do legado de releases).
function toPublicPost(row: ChangelogPostRow, media: ChangelogMediaRow[]) {
  return {
    slug: row.slug,
    versionLabel: row.version_label,
    title: row.title,
    summary: row.summary,
    category: row.category,
    author: row.author,
    publishedAt: row.published_at,
    contentText: row.content_text,
    relatedLinks: row.related_links.map((link) => ({ label: link.label, url: link.url })),
    modulesAffected: row.modules_affected,
    affectedPlans: row.affected_plans,
    media: media.map((item) => ({ id: item.id, alt: item.alt, mime: item.mime }))
  };
}

function toAdminPost(row: ChangelogPostRow, media: ChangelogMediaRow[]) {
  return {
    id: row.id,
    releaseId: row.release_id,
    slug: row.slug,
    versionLabel: row.version_label,
    title: row.title,
    summary: row.summary,
    category: row.category,
    author: row.author,
    contentText: row.content_text,
    modulesAffected: row.modules_affected,
    affectedPlans: row.affected_plans,
    relatedLinks: row.related_links,
    publishAt: row.publish_at,
    published: row.published,
    publishedAt: row.published_at,
    status: deriveStatus(row),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media: media.map((item) => ({ id: item.id, alt: item.alt, mime: item.mime, sizeBytes: item.size_bytes }))
  };
}

function toMediaRecord(row: ChangelogMediaRow) {
  return { id: row.id, sha256: row.sha256, mime: row.mime, sizeBytes: row.size_bytes, alt: row.alt };
}

function isEligible(row: ChangelogPostRow): boolean {
  return row.published && row.publish_at === null;
}

export async function registerChangelogRoutes(app: FastifyInstance): Promise<void> {
  // Multipart condicional (A10): @fastify/multipart 9.x (Fastify 5), dono único,
  // caps exigidos pela SPEC. NÃO registrar novamente no app.
  await app.register(multipart, {
    limits: { fileSize: MEDIA_MAX_BYTES, files: 1 }
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: error.issues[0]?.message ?? "Payload inválido" });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number") {
      return reply.status(statusCode).send({ error: (error as { message?: string }).message ?? "Erro" });
    }
    app.log.error({ err: error instanceof Error ? error : new Error(String(error)) }, "changelog route error");
    return reply.status(500).send({ error: "Erro interno" });
  });

  const ensureSlugAvailable = async (slug: string, excludeId?: string) => {
    if (!SLUG_SHAPE.test(slug)) throw httpError(400, "Slug inválido (use minúsculas, números e hífens)");
    const existing = await getPostBySlug(db, slug);
    if (existing && existing.id !== excludeId) {
      let suggestion = `${slug}-2`;
      for (let attempt = 2; attempt < 50; attempt += 1) {
        suggestion = `${slug}-${attempt}`;
        if (!(await getPostBySlug(db, suggestion))) break;
      }
      throw httpError(409, `Slug já existe. Sugestão: ${suggestion}`);
    }
  };

  const validateAffectedPlans = async (plans: string[] | undefined) => {
    if (!plans || plans.length === 0) return;
    const names = await getPlanNames(db);
    const unknown = plans.filter((plan) => !names.has(plan));
    if (unknown.length > 0) throw httpError(400, `Plano(s) inexistente(s): ${unknown.join(", ")}`);
  };

  // ---------- Administração ROOT ----------

  app.post("/root/changelog/posts", async (request, reply) => {
    const root = await requireRoot(request);
    const body = createPostSchema.parse(request.body);
    const slug = body.slug !== undefined ? body.slug : slugify(body.title);
    await ensureSlugAvailable(slug);
    await validateAffectedPlans(body.affectedPlans);
    // Agenda residual no create: publish_at passado só é aceito quando pode virar
    // publicação imediata (invariante published⇒summary do banco).
    const now = Date.now();
    const immediatePublish = body.publishAt !== undefined && body.publishAt.getTime() <= now;
    if (immediatePublish && body.summary === undefined) {
      throw httpError(400, "Resumo (summary) é obrigatório para publicar");
    }
    const row = await createPost(db, {
      title: body.title,
      summary: body.summary ?? null,
      slug,
      category: body.category,
      author: body.author ?? null,
      contentText: body.contentText ?? null,
      modulesAffected: body.modulesAffected,
      affectedPlans: body.affectedPlans,
      relatedLinks: body.relatedLinks,
      publishAt: body.publishAt ?? null
    }, root.userId);
    let final = row;
    if (immediatePublish) {
      final = await setPostPublishState(db, row.id, null);
    }
    app.log.info({ postId: final.id, action: final.published ? "publish" : final.publish_at ? "schedule" : "create" }, "changelog post created");
    return reply.status(201).send({ post: toAdminPost(final, await listPostMedia(db, final.id)) });
  });

  app.get("/root/changelog/posts", async (request) => {
    await requireRoot(request);
    const query = adminListQuery.parse(request.query);
    const posts = await listPostsAdmin(db, { status: query.status, limit: query.limit, offset: query.offset });
    return {
      posts: await Promise.all(posts.map(async (row) => toAdminPost(row, await listPostMedia(db, row.id)))),
      nextOffset: posts.length === query.limit ? query.offset + query.limit : null
    };
  });

  app.get("/root/changelog/posts/:id", async (request) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const row = await getPostById(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    return { post: toAdminPost(row, await listPostMedia(db, id)) };
  });

  app.patch("/root/changelog/posts/:id", async (request) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const body = patchPostSchema.parse(request.body);
    const row = await getPostById(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    // Permalink estável: slug só até a primeira publicação.
    if (body.slug !== undefined && body.slug !== row.slug && row.published_at !== null) {
      throw httpError(409, "Slug não pode mudar após a publicação");
    }
    // Agenda só em draft/scheduled; publicado exige unpublish antes.
    if (body.publishAt !== undefined && row.published) {
      throw httpError(409, "publishAt não pode ser alterado com o post publicado (despublique antes)");
    }
    if (row.published && "summary" in body && body.summary === null) {
      throw httpError(400, "Post publicado exige summary");
    }
    if (body.slug !== undefined) await ensureSlugAvailable(body.slug, id);
    await validateAffectedPlans(body.affectedPlans);
    const pastPublish = body.publishAt instanceof Date && body.publishAt.getTime() <= Date.now();
    if (pastPublish && (body.summary === undefined ? row.summary : body.summary) === null) {
      throw httpError(400, "Resumo (summary) é obrigatório para publicar");
    }
    const updated = await updatePost(db, id, {
      title: body.title,
      summary: body.summary,
      category: body.category,
      author: body.author,
      contentText: body.contentText,
      modulesAffected: body.modulesAffected,
      affectedPlans: body.affectedPlans,
      relatedLinks: body.relatedLinks,
      slug: body.slug,
      publishAt: body.publishAt ?? undefined
    });
    app.log.info({ postId: id, action: body.publishAt !== undefined ? "schedule" : "edit" }, "changelog post updated");
    return { post: toAdminPost(updated, await listPostMedia(db, id)) };
  });

  app.delete("/root/changelog/posts/:id", async (request, reply) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const deleted = await deletePost(db, id);
    if (!deleted) throw httpError(404, "Post não encontrado");
    app.log.info({ postId: id, action: "delete" }, "changelog post deleted");
    return reply.status(204).send();
  });

  app.post("/root/changelog/posts/:id/publish", async (request) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const body = publishSchema.parse(request.body ?? {});
    const row = await getPostById(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    if (!row.summary) throw httpError(400, "Resumo (summary) é obrigatório para publicar");
    const updated = await setPostPublishState(db, id, body.publishAt ?? null);
    app.log.info(
      { postId: id, action: updated.published ? "publish" : "schedule" },
      updated.published ? "changelog post published" : "changelog post scheduled"
    );
    return { post: toAdminPost(updated, await listPostMedia(db, id)) };
  });

  app.post("/root/changelog/posts/:id/unpublish", async (request, reply) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const row = await unpublishPost(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    app.log.info({ postId: id, action: "unpublish" }, "changelog post unpublished (agenda cancelada)");
    return reply.status(204).send();
  });

  // Preview: mesmo shape público + flags admin; sempre no-store (revogável).
  app.get("/root/changelog/posts/:id/preview", async (request, reply) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const row = await getPostById(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    reply.header("cache-control", "no-store");
    return {
      post: {
        ...toPublicPost(row, await listPostMedia(db, id)),
        status: deriveStatus(row),
        publishAt: row.publish_at
      }
    };
  });

  // ---------- Mídia (admin) ----------

  app.post("/root/changelog/media", async (request, reply) => {
    const root = await requireRoot(request);
    const fields: Record<string, unknown> = {};
    let buffer: Buffer | null = null;
    let declaredMime: string | null = null;
    let fileCount = 0;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > 1) throw httpError(400, "Envie apenas um arquivo por vez");
        declaredMime = part.mimetype;
        buffer = await readMediaFile(part.file);
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (!buffer || fileCount === 0) throw httpError(400, "Campo 'file' é obrigatório");
    const sniffedMime = validateMediaMime(buffer, declaredMime);
    const media = await upsertMedia(db, {
      sha256: sha256Of(buffer),
      mime: sniffedMime,
      sizeBytes: buffer.length,
      data: buffer,
      alt: mediaAltFromFields(fields)
    }, root.userId);
    return reply.status(201).send({ media: toMediaRecord(media) });
  });

  app.get("/root/changelog/media", async (request) => {
    await requireRoot(request);
    const query = mediaListQuery.parse(request.query);
    const rows = await listMedia(db, query.limit, query.offset);
    return { media: rows.map(toMediaRecord), nextOffset: rows.length === query.limit ? query.offset + query.limit : null };
  });

  app.patch("/root/changelog/media/:id", async (request) => {
    await requireRoot(request);
    const { id } = mediaIdParams.parse(request.params);
    const body = patchMediaSchema.parse(request.body);
    const row = await updateMediaAlt(db, id, body.alt);
    if (!row) throw httpError(404, "Mídia não encontrada");
    return { media: toMediaRecord(row) };
  });

  app.delete("/root/changelog/media/:id", async (request, reply) => {
    await requireRoot(request);
    const { id } = mediaIdParams.parse(request.params);
    const existing = await getMediaById(db, id);
    if (!existing) throw httpError(404, "Mídia não encontrada");
    const references = await countMediaReferences(db, id);
    if (references > 0) throw httpError(409, "Mídia referenciada por posts (dissocie antes de excluir)");
    await deleteMedia(db, id);
    app.log.info({ mediaId: id, action: "media-delete" }, "changelog media deleted");
    return reply.status(204).send();
  });

  app.put("/root/changelog/posts/:id/media", async (request) => {
    await requireRoot(request);
    const { id } = idParams.parse(request.params);
    const body = replaceMediaSchema.parse(request.body);
    const row = await getPostById(db, id);
    if (!row) throw httpError(404, "Post não encontrado");
    const uniqueIds = [...new Set(body.mediaIds)];
    for (const mediaId of uniqueIds) {
      if (!(await getMediaById(db, mediaId))) throw httpError(404, `Mídia não encontrada: ${mediaId}`);
    }
    await replacePostMedia(id, uniqueIds);
    return { media: (await listPostMedia(db, id)).map((item) => ({ id: item.id, alt: item.alt, mime: item.mime, sizeBytes: item.size_bytes })) };
  });

  app.get("/root/changelog/media/:id/bytes", async (request, reply) => {
    await requireRoot(request);
    const { id } = mediaBytesParams.parse(request.params);
    const media = await getMediaBytes(db, id);
    if (!media) throw httpError(404, "Mídia não encontrada");
    reply.header("content-type", media.mime);
    reply.header("cache-control", "no-store");
    return reply.send(media.data);
  });

  // ---------- Público (sem auth) ----------

  app.get("/public/changelog", async (request) => {
    const query = publicListQuery.parse(request.query);
    // limit+1 para decidir nextOffset sem contar o total.
    const rows = await listEligiblePosts(db, query.limit + 1, query.offset);
    const page = rows.slice(0, query.limit);
    const posts = await Promise.all(page.map(async (row) => toPublicPost(row, await listPostMedia(db, row.id))));
    return { posts, nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });

  app.get("/public/changelog/:slug", async (request) => {
    const { slug } = slugParams.parse(request.params);
    const row = await getPostBySlug(db, slug);
    if (!row || !isEligible(row)) throw httpError(404, "Post não encontrado");
    return { post: toPublicPost(row, await listPostMedia(db, row.id)) };
  });

  // Mídia pública REVOGÁVEL: elegibilidade re-executada ANTES de qualquer 304 (sem cache de decisão).
  app.get("/public/changelog/media/:mediaId", async (request, reply) => {
    const { mediaId } = publicMediaParams.parse(request.params);
    const eligible = await isMediaPubliclyEligible(db, mediaId);
    if (!eligible) {
      app.log.info({ mediaId, action: "media-revoked-404" }, "changelog media not publicly eligible");
      reply.header("cache-control", "no-store");
      throw httpError(404, "Mídia não encontrada");
    }
    const media = await getMediaBytes(db, mediaId);
    if (!media) {
      app.log.info({ mediaId, action: "media-revoked-404" }, "changelog media missing");
      reply.header("cache-control", "no-store");
      throw httpError(404, "Mídia não encontrada");
    }
    const etag = `"${media.sha256}"`;
    const ifNoneMatch = request.headers["if-none-match"];
    reply.header("content-type", media.mime);
    reply.header("cache-control", "no-store");
    reply.header("etag", etag);
    if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").map((value) => value.trim()).includes(etag)) {
      return reply.status(304).send();
    }
    return reply.send(media.data);
  });

  // ---------- Painel "Novidades" (autenticado = MESMO feed global + read por usuário) ----------

  app.get("/panel/changelog/unread", async (request) => {
    const session = await requireWorkspace(request);
    const [count, latest] = await Promise.all([countUnreadPosts(db, session.userId), getLatestEligiblePost(db)]);
    return {
      count,
      latestPost: latest ? { slug: latest.slug, title: latest.title, category: latest.category, publishedAt: latest.published_at } : null
    };
  });

  app.get("/panel/changelog/feed", async (request) => {
    const session = await requireWorkspace(request);
    const query = publicListQuery.parse(request.query);
    const rows = await listFeedForUser(db, session.userId, query.limit + 1, query.offset);
    const page = rows.slice(0, query.limit);
    // `id` só no feed autenticado (o público segue a whitelist sem id): é o
    // que o painel manda em POST /panel/changelog/read para marcar leitura.
    const posts = await Promise.all(page.map(async (row) => ({
      id: row.id,
      ...toPublicPost(row, await listPostMedia(db, row.id)),
      read: row.read
    })));
    return { posts, nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });

  app.post("/panel/changelog/read", async (request, reply) => {
    const session = await requireWorkspace(request);
    const body = markReadSchema.parse(request.body);
    // user_id SEMPRE da sessão (nunca do body).
    const marked = await markPostRead(db, session.userId, body.postId);
    if (!marked) throw httpError(404, "Post não encontrado");
    return reply.status(204).send();
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { requireRoot, requireWorkspace } from "../../auth/session.js";
import { httpError } from "../scheduling/service.js";
import {
  editRelease,
  getReleaseById,
  listReleases,
  resetReleaseForRegeneration,
  setReleasePublished,
  type ReleaseRow
} from "./repository.js";
import { getChangelogAiSettings, updateChangelogAiSettings } from "./ai-settings-repository.js";
import { runAiGenerationForRelease } from "./reconciler.js";

const releaseIdParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  tenantSlug: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const scopedChangeSchema = z.object({
  text: z.string().trim().min(1).max(240),
  tenant_slugs: z.array(z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(20)
}).strict();
const editBodySchema = z.object({
  publicTitle: z.string().trim().min(1).max(120).optional(),
  publicSummary: z.string().trim().min(1).max(400).optional(),
  publicChanges: z.array(scopedChangeSchema).min(1).max(20).optional(),
  technicalChangelog: z.string().trim().min(1).max(5000).optional(),
  scope: z.enum(["GLOBAL", "TENANT"]).optional(),
  tenantSlugsOverride: z.array(z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(50).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar");
const aiSettingsBodySchema = z.object({
  apiKey: z.string().trim().min(16).optional(),
  clearApiKey: z.boolean().optional(),
  primaryModel: z.string().trim().min(1).max(200).optional(),
  fallbackModel: z.string().trim().min(1).max(200).nullable().optional(),
  autoGenerateEnabled: z.boolean().optional(),
  autoPublishEnabled: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para atualizar");

function serializeRelease(row: ReleaseRow) {
  return {
    id: row.id,
    buildNumber: Number(row.build_number),
    version: row.version,
    classification: row.classification,
    classificationReason: row.classification_reason,
    bumpSource: row.bump_source,
    commitSha: row.commit_sha,
    branch: row.branch,
    additions: row.additions,
    deletions: row.deletions,
    filesChanged: row.files_changed,
    modulesAffected: row.modules_affected,
    scope: row.scope,
    tenantSlugsDetected: row.tenant_slugs_detected,
    commitMessages: row.commit_messages,
    diffExcerpt: row.diff_excerpt,
    technicalChangelog: row.technical_changelog,
    publicTitle: row.public_title,
    publicSummary: row.public_summary,
    publicChanges: row.public_changes,
    aiStatus: row.ai_status,
    aiError: row.ai_error,
    aiModelUsed: row.ai_model_used,
    aiAttemptCount: row.ai_attempt_count,
    aiLastAttemptAt: row.ai_last_attempt_at,
    published: row.published,
    publishedAt: row.published_at,
    manualOverride: row.manual_override,
    overriddenByUserId: row.overridden_by_user_id,
    overriddenAt: row.overridden_at,
    isLegacyImport: row.is_legacy_import,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function registerReleaseRoutes(app: FastifyInstance): Promise<void> {
  // ROOT sees every release regardless of scope/publication state and can
  // filter by tenant slug for auditing. Non-ROOT tenant-scoped visibility
  // continues to flow through GET /panel/version (modules/root/version.ts).
  app.get("/root/versions", async (request) => {
    await requireRoot(request);
    const query = listQuery.parse(request.query);
    const releases = await listReleases(db, {
      tenantSlug: query.tenantSlug,
      includeUnpublished: true,
      limit: query.limit,
      offset: query.offset
    });
    return { releases: releases.map(serializeRelease) };
  });

  app.get("/root/versions/:id", async (request) => {
    await requireRoot(request);
    const { id } = releaseIdParams.parse(request.params);
    const release = await getReleaseById(db, id);
    if (!release) throw httpError(404, "Release não encontrada");
    return { release: serializeRelease(release) };
  });

  app.patch("/root/versions/:id", async (request) => {
    const root = await requireRoot(request);
    const { id } = releaseIdParams.parse(request.params);
    const body = editBodySchema.parse(request.body);
    const existing = await getReleaseById(db, id);
    if (!existing) throw httpError(404, "Release não encontrada");
    if (body.tenantSlugsOverride) {
      const validTenants = await db.query<{ slug: string }>(
        "SELECT slug FROM tenants WHERE slug = ANY($1::text[])",
        [body.tenantSlugsOverride]
      );
      const validSlugs = new Set(validTenants.rows.map((row) => row.slug));
      const unknown = body.tenantSlugsOverride.filter((slug) => !validSlugs.has(slug));
      if (unknown.length > 0) throw httpError(400, `Slug(s) de empresa inexistente(s): ${unknown.join(", ")}`);
    }
    const updated = await editRelease(db, id, {
      publicTitle: body.publicTitle,
      publicSummary: body.publicSummary,
      publicChanges: body.publicChanges,
      technicalChangelog: body.technicalChangelog,
      scope: body.scope,
      tenantSlugsOverride: body.tenantSlugsOverride
    }, root.userId);
    return { release: serializeRelease(updated) };
  });

  app.post("/root/versions/:id/publish", async (request) => {
    await requireRoot(request);
    const { id } = releaseIdParams.parse(request.params);
    const existing = await getReleaseById(db, id);
    if (!existing) throw httpError(404, "Release não encontrada");
    if (!existing.public_title || !existing.public_summary) {
      throw httpError(409, "A release precisa de título e resumo públicos (gere com IA ou edite manualmente) antes de publicar");
    }
    const updated = await setReleasePublished(db, id, true);
    return { release: serializeRelease(updated) };
  });

  app.post("/root/versions/:id/unpublish", async (request) => {
    await requireRoot(request);
    const { id } = releaseIdParams.parse(request.params);
    const existing = await getReleaseById(db, id);
    if (!existing) throw httpError(404, "Release não encontrada");
    const updated = await setReleasePublished(db, id, false);
    return { release: serializeRelease(updated) };
  });

  app.post("/root/versions/:id/regenerate", async (request) => {
    await requireRoot(request);
    const { id } = releaseIdParams.parse(request.params);
    const existing = await getReleaseById(db, id);
    if (!existing) throw httpError(404, "Release não encontrada");
    await resetReleaseForRegeneration(db, id);
    // Fire-and-forget: the panel polls ai_status via GET; a slow/failed
    // OpenRouter call must not block this HTTP response.
    void runAiGenerationForRelease(id).catch((error) => {
      app.log.error({ err: error, releaseId: id }, "Manual changelog AI regeneration failed");
    });
    return { status: "regenerating" };
  });

  app.get("/root/settings/changelog-ai", async (request) => {
    await requireRoot(request);
    return { settings: await getChangelogAiSettings(db) };
  });

  app.put("/root/settings/changelog-ai", async (request) => {
    const root = await requireRoot(request);
    const body = aiSettingsBodySchema.parse(request.body);
    if (body.apiKey && body.clearApiKey) throw httpError(400, "Informe apiKey ou clearApiKey, não ambos");
    const settings = await updateChangelogAiSettings(db, config.DATA_ENCRYPTION_KEY, body, root.userId);
    return { settings };
  });

  // Tenant-scoped public changelog list, for a "Ver changelog público" link
  // in the footer alongside the version string. GLOBAL releases plus the
  // caller's own tenant releases, published only — same contract as
  // GET /panel/version's changelog array, but paginated for a dedicated page.
  app.get("/panel/versions", async (request) => {
    const session = await requireWorkspace(request);
    const tenant = await db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id=$1", [session.tenantId]);
    const query = listQuery.parse(request.query);
    const releases = await listReleases(db, {
      tenantSlug: tenant.rows[0]?.slug,
      includeUnpublished: false,
      limit: query.limit,
      offset: query.offset
    });
    return {
      releases: releases.map((release) => ({
        buildNumber: Number(release.build_number),
        version: release.version,
        publicTitle: release.public_title,
        publicSummary: release.public_summary,
        publicChanges: release.public_changes,
        publishedAt: release.published_at,
        createdAt: release.created_at
      }))
    };
  });
}

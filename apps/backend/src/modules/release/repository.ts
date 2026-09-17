import type { Pool, PoolClient } from "pg";

export interface ScopedChange {
  text: string;
  tenant_slugs: string[];
}

export interface ReleaseRow {
  id: string;
  build_number: string;
  version: string;
  classification: "PATCH" | "DROP" | "RELEASE";
  classification_reason: string;
  bump_source: string;
  commit_sha: string;
  branch: string;
  additions: number;
  deletions: number;
  files_changed: unknown;
  modules_affected: string[];
  scope: "GLOBAL" | "TENANT";
  tenant_slugs_detected: string[];
  commit_messages: string[];
  diff_excerpt: string;
  technical_changelog: string;
  public_title: string | null;
  public_summary: string | null;
  public_changes: ScopedChange[];
  ai_status: "pending" | "generating" | "generated" | "failed";
  ai_error: string | null;
  ai_model_used: string | null;
  ai_attempt_count: number;
  ai_last_attempt_at: Date | string | null;
  published: boolean;
  published_at: Date | string | null;
  manual_override: boolean;
  overridden_by_user_id: string | null;
  overridden_at: Date | string | null;
  is_legacy_import: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateReleaseInput {
  version: string;
  classification: "PATCH" | "DROP" | "RELEASE";
  classificationReason: string;
  bumpSource: "auto" | "manual_override";
  commitSha: string;
  branch: string;
  additions: number;
  deletions: number;
  filesChanged: Array<{ path: string; status: string; additions: number; deletions: number }>;
  modulesAffected: string[];
  scope: "GLOBAL" | "TENANT";
  tenantSlugsDetected: string[];
  commitMessages: string[];
  diffExcerpt: string;
  technicalChangelog: string;
  createdBy: string;
}

export async function createRelease(db: Pick<Pool, "query">, input: CreateReleaseInput): Promise<ReleaseRow> {
  const result = await db.query<ReleaseRow>(
    `INSERT INTO releases(
       version,classification,classification_reason,bump_source,commit_sha,branch,
       additions,deletions,files_changed,modules_affected,scope,tenant_slugs_detected,
       commit_messages,diff_excerpt,technical_changelog,ai_status,created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16)
     RETURNING *`,
    [
      input.version,
      input.classification,
      input.classificationReason,
      input.bumpSource,
      input.commitSha,
      input.branch,
      input.additions,
      input.deletions,
      JSON.stringify(input.filesChanged),
      input.modulesAffected,
      input.scope,
      input.tenantSlugsDetected,
      input.commitMessages,
      input.diffExcerpt,
      input.technicalChangelog,
      input.createdBy
    ]
  );
  return result.rows[0];
}

export async function getLastRelease(db: Pick<Pool, "query">): Promise<ReleaseRow | null> {
  const result = await db.query<ReleaseRow>("SELECT * FROM releases ORDER BY build_number DESC LIMIT 1");
  return result.rows[0] ?? null;
}

export async function findReleaseByCommit(db: Pick<Pool, "query">, commitSha: string): Promise<ReleaseRow | null> {
  const result = await db.query<ReleaseRow>(
    "SELECT * FROM releases WHERE commit_sha=$1 ORDER BY build_number DESC LIMIT 1",
    [commitSha]
  );
  return result.rows[0] ?? null;
}

export interface ListReleasesOptions {
  tenantSlug?: string;
  includeUnpublished?: boolean;
  limit?: number;
  offset?: number;
}

/** Tenant scoping mirrors the legacy filterChangelogHistory contract: a
 * release with an empty tenant_slugs_detected is GLOBAL and visible to
 * everyone; otherwise it is visible only to the tenants it names. ROOT (no
 * tenantSlug + includeUnpublished) sees everything regardless of scope. */
export async function listReleases(db: Pick<Pool, "query">, options: ListReleasesOptions = {}): Promise<ReleaseRow[]> {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const result = await db.query<ReleaseRow>(
    `SELECT * FROM releases
     WHERE ($1::boolean OR published=true)
       AND (
         $1::boolean
         OR $2::text IS NULL
         OR scope='GLOBAL'
         OR $2::text = ANY(tenant_slugs_detected)
       )
     ORDER BY build_number DESC
     LIMIT $3 OFFSET $4`,
    [options.includeUnpublished === true, options.tenantSlug ?? null, limit, offset]
  );
  return result.rows;
}

export async function getReleaseById(db: Pick<Pool, "query">, id: string): Promise<ReleaseRow | null> {
  const result = await db.query<ReleaseRow>("SELECT * FROM releases WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

export interface AiGenerationResult {
  publicTitle: string;
  publicSummary: string;
  publicChanges: ScopedChange[];
  scope: "GLOBAL" | "TENANT";
  modelUsed: string;
}

export async function claimReleaseForAiGeneration(
  db: Pick<Pool, "connect">,
  id: string
): Promise<ReleaseRow | null> {
  const client: PoolClient = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ReleaseRow>(
      `UPDATE releases SET ai_status='generating',ai_last_attempt_at=now(),ai_attempt_count=ai_attempt_count+1
       WHERE id=$1 AND ai_status IN ('pending','failed')
       RETURNING *`,
      [id]
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAiGeneration(
  db: Pick<Pool, "query">,
  id: string,
  result: AiGenerationResult,
  autoPublish: boolean
): Promise<ReleaseRow> {
  const updated = await db.query<ReleaseRow>(
    `UPDATE releases SET
       ai_status='generated',
       ai_error=NULL,
       ai_model_used=$2,
       public_title=$3,
       public_summary=$4,
       public_changes=$5,
       scope=$6,
       published=CASE WHEN $7::boolean THEN true ELSE published END,
       published_at=CASE WHEN $7::boolean AND published_at IS NULL THEN now() ELSE published_at END
     WHERE id=$1
     RETURNING *`,
    [id, result.modelUsed, result.publicTitle, result.publicSummary, JSON.stringify(result.publicChanges), result.scope, autoPublish]
  );
  if (!updated.rows[0]) throw new Error(`Release ${id} not found while completing AI generation`);
  return updated.rows[0];
}

export async function failAiGeneration(db: Pick<Pool, "query">, id: string, error: string): Promise<void> {
  await db.query(
    "UPDATE releases SET ai_status='failed',ai_error=$2 WHERE id=$1",
    [id, error.slice(0, 2000)]
  );
}

export async function listReleasesPendingAiGeneration(
  db: Pick<Pool, "query">,
  options: { maxAttempts: number; retryBackoffMs: number; limit: number }
): Promise<ReleaseRow[]> {
  const result = await db.query<ReleaseRow>(
    `SELECT * FROM releases
     WHERE ai_status IN ('pending','failed')
       AND ai_attempt_count < $1
       AND (ai_last_attempt_at IS NULL OR ai_last_attempt_at < now() - ($2::text || ' milliseconds')::interval)
     ORDER BY build_number ASC
     LIMIT $3`,
    [options.maxAttempts, options.retryBackoffMs, options.limit]
  );
  return result.rows;
}

// A release can be stuck in 'generating' only if the worker died mid-call; the
// reconciler must be able to reclaim it rather than leaving it stuck forever.
export async function reclaimStaleGenerating(db: Pick<Pool, "query">, staleAfterMs: number): Promise<number> {
  const result = await db.query(
    `UPDATE releases SET ai_status='pending'
     WHERE ai_status='generating' AND ai_last_attempt_at < now() - ($1::text || ' milliseconds')::interval`,
    [staleAfterMs]
  );
  return result.rowCount ?? 0;
}

export interface EditReleaseInput {
  publicTitle?: string;
  publicSummary?: string;
  publicChanges?: ScopedChange[];
  technicalChangelog?: string;
  scope?: "GLOBAL" | "TENANT";
  tenantSlugsOverride?: string[];
}

export async function editRelease(
  db: Pick<Pool, "query">,
  id: string,
  input: EditReleaseInput,
  userId: string
): Promise<ReleaseRow> {
  const result = await db.query<ReleaseRow>(
    `UPDATE releases SET
       public_title=COALESCE($2,public_title),
       public_summary=COALESCE($3,public_summary),
       public_changes=COALESCE($4,public_changes),
       technical_changelog=COALESCE($5,technical_changelog),
       scope=COALESCE($6,scope),
       tenant_slugs_detected=COALESCE($7,tenant_slugs_detected),
       manual_override=true,
       overridden_by_user_id=$8,
       overridden_at=now()
     WHERE id=$1
     RETURNING *`,
    [
      id,
      input.publicTitle ?? null,
      input.publicSummary ?? null,
      input.publicChanges ? JSON.stringify(input.publicChanges) : null,
      input.technicalChangelog ?? null,
      input.scope ?? null,
      input.tenantSlugsOverride ?? null,
      userId
    ]
  );
  if (!result.rows[0]) throw new Error(`Release ${id} not found`);
  return result.rows[0];
}

export async function setReleasePublished(
  db: Pick<Pool, "query">,
  id: string,
  published: boolean
): Promise<ReleaseRow> {
  const result = await db.query<ReleaseRow>(
    `UPDATE releases SET published=$2,published_at=CASE WHEN $2 AND published_at IS NULL THEN now() ELSE published_at END
     WHERE id=$1
     RETURNING *`,
    [id, published]
  );
  if (!result.rows[0]) throw new Error(`Release ${id} not found`);
  return result.rows[0];
}

export async function resetReleaseForRegeneration(db: Pick<Pool, "query">, id: string): Promise<ReleaseRow> {
  const result = await db.query<ReleaseRow>(
    `UPDATE releases SET ai_status='pending',ai_error=NULL,ai_attempt_count=0,ai_last_attempt_at=NULL
     WHERE id=$1
     RETURNING *`,
    [id]
  );
  if (!result.rows[0]) throw new Error(`Release ${id} not found`);
  return result.rows[0];
}

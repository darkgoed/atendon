import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { generateChangelogWithAi } from "./ai-generator.js";
import { getChangelogAiCredentials, getChangelogAiSettings } from "./ai-settings-repository.js";
import {
  claimReleaseForAiGeneration,
  completeAiGeneration,
  failAiGeneration,
  getReleaseById,
  listReleasesPendingAiGeneration,
  reclaimStaleGenerating
} from "./repository.js";

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60_000;
const STALE_GENERATING_MS = 15 * 60_000;
const RECONCILER_BATCH_SIZE = 5;

/** Runs the AI changelog step for one release. Never called from the deploy
 * script/pipeline — only from the worker's periodic reconciler or a manual
 * "regenerate" click. A failure here sets ai_status='failed' with a visible
 * ai_error and is retried later; it never blocks or rolls back the deploy
 * that already shipped the code this release describes. */
export async function runAiGenerationForRelease(releaseId: string): Promise<void> {
  const settings = await getChangelogAiSettings(db);
  if (!settings.autoGenerateEnabled) {
    logger.info({ releaseId }, "Changelog AI generation is disabled; skipping");
    return;
  }
  const credentials = await getChangelogAiCredentials(db, config.DATA_ENCRYPTION_KEY);
  if (!credentials) {
    await failAiGeneration(db, releaseId, "CHANGELOG_OPENROUTER_API_KEY não configurada em /root/configuracoes");
    return;
  }

  const claimed = await claimReleaseForAiGeneration(db, releaseId);
  if (!claimed) {
    logger.info({ releaseId }, "Release is not in a claimable AI status; skipping");
    return;
  }

  try {
    const result = await generateChangelogWithAi({
      diffStat: claimed.technical_changelog,
      diffText: claimed.diff_excerpt,
      commitMessages: claimed.commit_messages,
      knownTenantSlugs: claimed.tenant_slugs_detected,
      apiKey: credentials.apiKey,
      primaryModel: credentials.primaryModel,
      fallbackModel: credentials.fallbackModel
    });
    const scope = result.changes.every((change) => change.tenant_slugs.length === 0) ? "GLOBAL" as const : "TENANT" as const;
    await completeAiGeneration(db, releaseId, {
      publicTitle: result.title,
      publicSummary: result.summary,
      publicChanges: result.changes,
      scope,
      modelUsed: result.modelUsed
    }, settings.autoPublishEnabled);
    logger.info({ releaseId, modelUsed: result.modelUsed, scope }, "Changelog AI generation succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failAiGeneration(db, releaseId, message);
    logger.error({ releaseId, err: error }, "Changelog AI generation failed");
  }
}

/** Periodic worker tick: reclaims stuck 'generating' releases, then attempts
 * AI generation for anything pending/failed within the retry budget. */
export async function reconcileChangelogAiGeneration(): Promise<void> {
  const reclaimed = await reclaimStaleGenerating(db, STALE_GENERATING_MS);
  if (reclaimed > 0) logger.warn({ reclaimed }, "Reclaimed stale changelog AI generations");

  const pending = await listReleasesPendingAiGeneration(db, {
    maxAttempts: MAX_ATTEMPTS,
    retryBackoffMs: RETRY_BACKOFF_MS,
    limit: RECONCILER_BATCH_SIZE
  });
  for (const release of pending) {
    await runAiGenerationForRelease(release.id).catch((error) => {
      logger.error({ releaseId: release.id, err: error }, "Changelog AI reconciler tick failed for a release");
    });
  }
}

export async function ensureReleaseExists(releaseId: string): Promise<boolean> {
  return (await getReleaseById(db, releaseId)) !== null;
}

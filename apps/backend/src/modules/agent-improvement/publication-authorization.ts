import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RUBRIC_VERSION } from "./rubric.js";
import type { AgentVersionSnapshot } from "./versions.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface ReplayPublicationAuthorization {
  orchestratorVersion: string;
  rubricVersion: string;
  baselineVersionId: string;
  candidateVersionId: string;
  baselineFingerprint: string;
  candidateFingerprint: string;
  executionContextFingerprint: string;
  regressionSuiteFingerprint: string;
}

export const REPLAY_ORCHESTRATOR_VERSION = "v2";

export interface ReplayExecutionContext {
  provider: string | null;
  encryptedApiKey: string | null;
}

export async function lockReplaySuite(db: Queryable, tenantId: string): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('ai_replay_suite:' || $1::text,0))",
    [tenantId]
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function agentVersionFingerprint(version: AgentVersionSnapshot): string {
  return fingerprint({
    systemPrompt: version.system_prompt,
    aiModel: version.ai_model,
    modelParams: version.model_params,
    enabledTools: version.enabled_tools
  });
}

async function regressionSuiteFingerprint(db: Queryable, tenantId: string): Promise<string> {
  const cases = await db.query<{
    id: string;
    severity: string;
    scenario: unknown;
    expected_behavior: unknown;
    updated_at: Date;
  }>(
    `SELECT id,severity,scenario,expected_behavior,updated_at
     FROM ai_regression_cases
     WHERE tenant_id=$1 AND is_active
     ORDER BY id`,
    [tenantId]
  );
  return fingerprint(cases.rows.map((item) => ({
    id: item.id,
    severity: item.severity,
    scenario: item.scenario,
    expectedBehavior: item.expected_behavior,
    updatedAt: item.updated_at.toISOString()
  })));
}

export async function buildReplayPublicationAuthorization(
  db: Queryable,
  input: {
    tenantId: string;
    baseline: AgentVersionSnapshot;
    candidate: AgentVersionSnapshot;
    executionContext?: ReplayExecutionContext;
  }
): Promise<ReplayPublicationAuthorization> {
  const settings = await db.query<{
    openrouter_provider: string | null;
    openrouter_api_key_encrypted: string | null;
  }>(
    `SELECT openrouter_provider,openrouter_api_key_encrypted
     FROM tenant_ai_settings WHERE tenant_id=$1`,
    [input.tenantId]
  );
  return {
    orchestratorVersion: REPLAY_ORCHESTRATOR_VERSION,
    rubricVersion: RUBRIC_VERSION,
    baselineVersionId: input.baseline.id,
    candidateVersionId: input.candidate.id,
    baselineFingerprint: agentVersionFingerprint(input.baseline),
    candidateFingerprint: agentVersionFingerprint(input.candidate),
    executionContextFingerprint: fingerprint(input.executionContext ?? (settings.rows[0] ? {
      provider: settings.rows[0].openrouter_provider,
      encryptedApiKey: settings.rows[0].openrouter_api_key_encrypted
    } : null)),
    regressionSuiteFingerprint: await regressionSuiteFingerprint(db, input.tenantId)
  };
}

export async function assertApprovedReplayForPublication(
  db: Queryable,
  input: {
    tenantId: string;
    proposalId: string;
    baseline: AgentVersionSnapshot;
    candidate: AgentVersionSnapshot;
  }
): Promise<void> {
  await lockReplaySuite(db, input.tenantId);
  const run = await db.query<{ aggregate_metrics: { publicationAuthorization?: ReplayPublicationAuthorization } }>(
    `SELECT aggregate_metrics
     FROM ai_evaluation_runs
     WHERE tenant_id=$1 AND proposal_id=$2 AND baseline_version_id=$3
       AND candidate_version_id=$4 AND rubric_version=$5
       AND status='passed' AND completed_at IS NOT NULL
     ORDER BY completed_at DESC NULLS LAST,created_at DESC
     LIMIT 1`,
    [input.tenantId, input.proposalId, input.baseline.id, input.candidate.id, RUBRIC_VERSION]
  );
  const approved = run.rows[0]?.aggregate_metrics.publicationAuthorization;
  const proposal = await db.query<{
    created_by: string;
    expected_impact: { _manualTenantAiSettings?: ReplayExecutionContext };
  }>(
    "SELECT created_by,expected_impact FROM ai_improvement_proposals WHERE id=$1 AND tenant_id=$2",
    [input.proposalId, input.tenantId]
  );
  const executionContext = proposal.rows[0]?.created_by === "human"
    && input.candidate.source === "manual"
    ? proposal.rows[0].expected_impact._manualTenantAiSettings
    : undefined;
  const current = await buildReplayPublicationAuthorization(db, { ...input, executionContext });
  if (!approved || canonical(approved) !== canonical(current)) {
    throw Object.assign(
      new Error("A publicação exige replay aprovado para o conteúdo, configuração e corpus atuais"),
      { statusCode: 409 }
    );
  }
}

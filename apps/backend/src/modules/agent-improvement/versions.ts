import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertApprovedReplayForPublication } from "./publication-authorization.js";
import type { ReplayExecutionContext } from "./publication-authorization.js";
import { RUBRIC_VERSION } from "./rubric.js";

export interface AgentVersionSnapshot {
  id: string;
  tenant_id: string;
  agent_config_id: string;
  version_number: number;
  source: "bootstrap" | "manual" | "proposal" | "rollback";
  status: "candidate" | "active" | "retired" | "rejected";
  system_prompt: string;
  ai_model: string;
  model_params: Record<string, unknown>;
  enabled_tools: string[];
  created_by_user_id: string | null;
  source_proposal_id?: string | null;
  created_at: Date;
  activated_at: Date | null;
  retired_at: Date | null;
}

type AuditActor = {
  userId: string;
  actorScope: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function auditVersion(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    action: string;
    versionId: string;
    metadata?: Record<string, unknown>;
  }
) {
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,
       metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,'agent_config_version',$5,$6,$7,$8)`,
    [
      input.userId,
      input.tenantId,
      input.actorScope,
      input.action,
      input.versionId,
      input.metadata ?? {},
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );
}

export interface CandidateReplayEnvelope {
  version: AgentVersionSnapshot;
  proposalId: string;
  runId: string | null;
}

export type PromptEvaluationPolicy = "required" | "bypassed";

export interface PendingManualTenantAiSettings extends ReplayExecutionContext {
  mediaFallbackAudio: string;
  mediaFallbackImage: string;
  mediaFallbackDocument: string;
}

type CurrentAgent = {
  id: string;
  active_version_id: string;
  system_prompt: string;
  ai_model: string;
  model_params: Record<string, unknown>;
  enabled_tools: string[];
};

async function insertManualCandidateForReplay(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    systemPrompt: string;
    aiModel: string;
    modelParams: Record<string, unknown>;
    enabledTools?: string[];
    pendingTenantAiSettings?: PendingManualTenantAiSettings;
    evaluationPolicy?: PromptEvaluationPolicy;
  },
  current: CurrentAgent,
  auditAction: string,
  title: string,
  rationale: string
): Promise<CandidateReplayEnvelope> {
  const evaluationPolicy = input.evaluationPolicy ?? "required";
  const next = await client.query<{ version_number: number }>(
    `SELECT COALESCE(max(version_number),0)+1 version_number
     FROM agent_config_versions
     WHERE agent_config_id=$1`,
    [current.id]
  );
  const enabledTools = input.enabledTools ?? current.enabled_tools;
  const proposalId = randomUUID();
  await client.query(
    `UPDATE ai_improvement_proposals
     SET status='superseded',updated_at=now()
     WHERE tenant_id=$1 AND candidate_version_id IN (
       SELECT id FROM agent_config_versions
       WHERE tenant_id=$1 AND agent_config_id=$2 AND source='manual' AND status='candidate'
     ) AND status IN ('draft','proposed','testing','test_failed','ready')`,
    [input.tenantId, current.id]
  );
  await client.query(
    `UPDATE agent_config_versions SET status='rejected'
     WHERE tenant_id=$1 AND agent_config_id=$2 AND source='manual' AND status='candidate'`,
    [input.tenantId, current.id]
  );
  const versionResult = await client.query<AgentVersionSnapshot>(
    `INSERT INTO agent_config_versions(
       tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,
       model_params,enabled_tools,created_by_user_id,source_proposal_id
     ) VALUES($1,$2,$3,'manual','candidate',$4,$5,$6,$7::jsonb,$8,$9)
     RETURNING *`,
    [
      input.tenantId,
      current.id,
      next.rows[0].version_number,
      input.systemPrompt,
      input.aiModel,
      input.modelParams,
      JSON.stringify(enabledTools),
      input.userId,
      proposalId
    ]
  );
  const version = versionResult.rows[0];
  await client.query(
    `INSERT INTO ai_improvement_proposals(
       id,tenant_id,baseline_version_id,candidate_version_id,title,rationale,
       target_issue_codes,evidence_evaluation_ids,expected_impact,status,created_by,
       reviewed_by_user_id,reviewed_at
     ) VALUES($1,$2,$3,$4,$5,$6,'[]','[]',$7,$8,'human',$9,now())`,
    [
      proposalId,
      input.tenantId,
      current.active_version_id,
      version.id,
      title,
      evaluationPolicy === "bypassed"
        ? "Avaliação temporariamente desativada; publicação direta solicitada por usuário."
        : rationale,
      {
        targetDimensions: [],
        ...(input.pendingTenantAiSettings
          ? { _manualTenantAiSettings: input.pendingTenantAiSettings }
          : {})
      },
      evaluationPolicy === "bypassed" ? "ready" : "testing",
      input.userId
    ]
  );
  const runId = evaluationPolicy === "required"
    ? (await client.query<{ id: string }>(
      `INSERT INTO ai_evaluation_runs(
         tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,status
       ) VALUES($1,$2,$3,$4,$5,'queued') RETURNING id`,
      [input.tenantId, proposalId, current.active_version_id, version.id, RUBRIC_VERSION]
    )).rows[0].id
    : null;
  await auditVersion(client, {
    ...input,
    action: auditAction,
    versionId: version.id,
    metadata: {
      activeVersionId: current.active_version_id,
      versionNumber: next.rows[0].version_number,
      proposalId,
      runId,
      evaluationPolicy
    }
  });
  return { version, proposalId, runId };
}

export async function createManualCandidate(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    systemPrompt: string;
    aiModel: string;
    modelParams: Record<string, unknown>;
    enabledTools?: string[];
    pendingTenantAiSettings?: PendingManualTenantAiSettings;
    evaluationPolicy?: PromptEvaluationPolicy;
  }
): Promise<CandidateReplayEnvelope> {
  const agent = await client.query<CurrentAgent>(
    `SELECT a.id,a.active_version_id,v.system_prompt,v.ai_model,v.model_params,v.enabled_tools
     FROM agent_configs a
     JOIN agent_config_versions v ON v.id=a.active_version_id AND v.tenant_id=a.tenant_id
     WHERE a.tenant_id=$1
     ORDER BY a.updated_at DESC,a.id
     LIMIT 1
     FOR UPDATE OF a`,
    [input.tenantId]
  );
  if (!agent.rows[0]) throw httpError(404, "Agente ativo não encontrado");
  return insertManualCandidateForReplay(
    client,
    input,
    agent.rows[0],
    "agent.version.manual_candidate_created",
    "Alteração manual da configuração do agente",
    "Configuração editada por usuário e condicionada à aprovação do replay."
  );
}

/**
 * Compatibility adapter for internal callers. It intentionally no longer publishes:
 * every manual edit is returned as a candidate pending replay authorization.
 */
export async function publishManualVersion(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    systemPrompt: string;
    aiModel: string;
    modelParams: Record<string, unknown>;
    enabledTools?: string[];
    isActive?: boolean;
    audit?: boolean;
    pendingTenantAiSettings?: PendingManualTenantAiSettings;
  }
): Promise<AgentVersionSnapshot> {
  return (await createManualCandidate(client, input)).version;
}

export async function createTemplateCandidate(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    systemPrompt: string;
    evaluationPolicy?: PromptEvaluationPolicy;
  }
): Promise<CandidateReplayEnvelope> {
  const agent = await client.query<CurrentAgent>(
    `SELECT a.id,a.active_version_id,v.system_prompt,v.ai_model,v.model_params,v.enabled_tools
     FROM agent_configs a
     JOIN agent_config_versions v ON v.id=a.active_version_id AND v.tenant_id=a.tenant_id
     WHERE a.tenant_id=$1
     ORDER BY a.updated_at DESC,a.id
     LIMIT 1
     FOR UPDATE OF a`,
    [input.tenantId]
  );
  const current = agent.rows[0];
  if (!current) throw httpError(404, "Agente ativo não encontrado");
  if (current.system_prompt === input.systemPrompt) throw httpError(409, "O template já corresponde ao prompt ativo");
  return insertManualCandidateForReplay(
    client,
    {
      ...input,
      aiModel: current.ai_model,
      modelParams: current.model_params,
      enabledTools: current.enabled_tools
    },
    current,
    "agent.template.candidate_created",
    "Aplicação do template versionado",
    "Template criado como candidato e condicionado à aprovação do replay."
  );
}

export async function publishCandidateVersion(
  client: PoolClient,
  input: AuditActor & {
    tenantId: string;
    candidateVersionId: string;
    auditAction?: string;
    evaluationPolicy?: PromptEvaluationPolicy;
  }
): Promise<AgentVersionSnapshot> {
  const agent = await client.query<{ id: string; active_version_id: string; is_active: boolean }>(
    `SELECT id,active_version_id,is_active FROM agent_configs
     WHERE tenant_id=$1 ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE`,
    [input.tenantId]
  );
  if (!agent.rows[0]) throw httpError(404, "Agente não encontrado");
  const candidate = await client.query<AgentVersionSnapshot>(
    `SELECT * FROM agent_config_versions
     WHERE id=$1 AND tenant_id=$2 AND agent_config_id=$3 AND status='candidate'`,
    [input.candidateVersionId, input.tenantId, agent.rows[0].id]
  );
  if (!candidate.rows[0]) throw httpError(404, "Versão candidata não encontrada");
  const proposal = await client.query<{
    id: string;
    baseline_version_id: string;
    status: string;
    created_by: string;
    expected_impact: { _manualTenantAiSettings?: PendingManualTenantAiSettings };
  }>(
    `SELECT id,baseline_version_id,status,created_by,expected_impact
     FROM ai_improvement_proposals
     WHERE tenant_id=$1 AND candidate_version_id=$2
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [input.tenantId, input.candidateVersionId]
  );
  if (!proposal.rows[0] || proposal.rows[0].status !== "ready") {
    throw httpError(409, "Somente candidata com replay aprovado pode ser publicada");
  }
  const evaluationPolicy = input.evaluationPolicy ?? "required";
  const evaluationBypassAllowed = evaluationPolicy === "bypassed"
    && proposal.rows[0].created_by === "human"
    && candidate.rows[0].source === "manual";
  if (evaluationPolicy === "bypassed" && !evaluationBypassAllowed) {
    throw httpError(409, "A dispensa de avaliação só é permitida para alterações humanas");
  }
  if (candidate.rows[0].source_proposal_id !== proposal.rows[0].id) {
    throw httpError(409, "A versão candidata não pertence à proposta de replay");
  }
  if (proposal.rows[0].baseline_version_id !== agent.rows[0].active_version_id) {
    throw httpError(409, "A baseline deixou de ser a versão ativa");
  }
  const baseline = await client.query<AgentVersionSnapshot>(
    "SELECT * FROM agent_config_versions WHERE id=$1 AND tenant_id=$2 AND status='active'",
    [proposal.rows[0].baseline_version_id, input.tenantId]
  );
  if (!baseline.rows[0]) throw httpError(409, "Baseline ativa não encontrada");
  if (!evaluationBypassAllowed) {
    await assertApprovedReplayForPublication(client, {
      tenantId: input.tenantId,
      proposalId: proposal.rows[0].id,
      baseline: baseline.rows[0],
      candidate: candidate.rows[0]
    });
  }

  await client.query(
    "UPDATE agent_config_versions SET status='retired',retired_at=now() WHERE id=$1 AND tenant_id=$2 AND status='active'",
    [agent.rows[0].active_version_id, input.tenantId]
  );
  const activated = await client.query<AgentVersionSnapshot>(
    `UPDATE agent_config_versions
     SET status='active',activated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND status='candidate'
     RETURNING *`,
    [input.candidateVersionId, input.tenantId]
  );
  const version = activated.rows[0];
  const pendingSettings = proposal.rows[0].created_by === "human" && version.source === "manual"
    ? proposal.rows[0].expected_impact._manualTenantAiSettings
    : undefined;
  if (pendingSettings) {
    await client.query(
      `INSERT INTO tenant_ai_settings(
         tenant_id,openrouter_provider,openrouter_api_key_encrypted,
         media_fallback_audio,media_fallback_image,media_fallback_document
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(tenant_id) DO UPDATE SET
         openrouter_provider=EXCLUDED.openrouter_provider,
         openrouter_api_key_encrypted=EXCLUDED.openrouter_api_key_encrypted,
         media_fallback_audio=EXCLUDED.media_fallback_audio,
         media_fallback_image=EXCLUDED.media_fallback_image,
         media_fallback_document=EXCLUDED.media_fallback_document,
         updated_at=now()`,
      [
        input.tenantId,
        pendingSettings.provider,
        pendingSettings.encryptedApiKey,
        pendingSettings.mediaFallbackAudio,
        pendingSettings.mediaFallbackImage,
        pendingSettings.mediaFallbackDocument
      ]
    );
  }
  await client.query(
    `UPDATE agent_configs SET
       system_prompt=$3,ai_model=$4,model_params=$5,enabled_tools=$6::jsonb,
       active_version_id=$2,updated_at=now()
     WHERE id=$1 AND tenant_id=$7`,
    [
      agent.rows[0].id,
      version.id,
      version.system_prompt,
      version.ai_model,
      version.model_params,
      JSON.stringify(version.enabled_tools),
      input.tenantId
    ]
  );
  await auditVersion(client, {
    ...input,
    action: input.auditAction ?? "agent.template.candidate_published",
    versionId: version.id,
    metadata: {
      previousVersionId: agent.rows[0].active_version_id,
      evaluationPolicy
    }
  });
  await client.query(
    `UPDATE ai_improvement_proposals
     SET status='published',reviewed_by_user_id=$3,reviewed_at=now(),
       published_at=now(),updated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND status='ready'`,
    [proposal.rows[0].id, input.tenantId, input.userId]
  );
  return version;
}

export async function rollbackToVersion(
  client: PoolClient,
  input: AuditActor & { tenantId: string; sourceVersionId: string; reason: string }
): Promise<AgentVersionSnapshot> {
  const agent = await client.query<{ id: string; active_version_id: string; is_active: boolean }>(
    `SELECT id,active_version_id,is_active
     FROM agent_configs
     WHERE tenant_id=$1
     ORDER BY updated_at DESC,id
     LIMIT 1
     FOR UPDATE`,
    [input.tenantId]
  );
  if (!agent.rows[0]) throw httpError(404, "Agente não encontrado");
  if (agent.rows[0].active_version_id === input.sourceVersionId) {
    throw httpError(409, "A versão escolhida já está ativa");
  }
  const source = await client.query<AgentVersionSnapshot>(
    `SELECT * FROM agent_config_versions
     WHERE id=$1 AND tenant_id=$2 AND agent_config_id=$3`,
    [input.sourceVersionId, input.tenantId, agent.rows[0].id]
  );
  if (!source.rows[0]) throw httpError(404, "Versão não encontrada");
  const next = await client.query<{ version_number: number }>(
    "SELECT COALESCE(max(version_number),0)+1 version_number FROM agent_config_versions WHERE agent_config_id=$1",
    [agent.rows[0].id]
  );

  await client.query(
    "UPDATE agent_config_versions SET status='retired',retired_at=now() WHERE id=$1 AND tenant_id=$2 AND status='active'",
    [agent.rows[0].active_version_id, input.tenantId]
  );
  const version = await client.query<AgentVersionSnapshot>(
    `INSERT INTO agent_config_versions(
       tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,
       model_params,enabled_tools,created_by_user_id,source_proposal_id,activated_at
     ) VALUES($1,$2,$3,'rollback','active',$4,$5,$6,$7::jsonb,$8,$9,now())
     RETURNING *`,
    [
      input.tenantId,
      agent.rows[0].id,
      next.rows[0].version_number,
      source.rows[0].system_prompt,
      source.rows[0].ai_model,
      source.rows[0].model_params,
      JSON.stringify(source.rows[0].enabled_tools),
      input.userId,
      source.rows[0].source_proposal_id ?? null
    ]
  );
  await client.query(
    `UPDATE agent_configs SET
       system_prompt=$3,ai_model=$4,model_params=$5,enabled_tools=$6::jsonb,
       active_version_id=$2,updated_at=now()
     WHERE id=$1 AND tenant_id=$7`,
    [
      agent.rows[0].id,
      version.rows[0].id,
      source.rows[0].system_prompt,
      source.rows[0].ai_model,
      source.rows[0].model_params,
      JSON.stringify(source.rows[0].enabled_tools),
      input.tenantId
    ]
  );
  await auditVersion(client, {
    ...input,
    action: "agent.improvement.rolled_back",
    versionId: version.rows[0].id,
    metadata: {
      sourceVersionId: input.sourceVersionId,
      previousVersionId: agent.rows[0].active_version_id,
      reason: input.reason
    }
  });
  return version.rows[0];
}

export async function listVersions(db: Pool, tenantId: string): Promise<AgentVersionSnapshot[]> {
  return (await db.query<AgentVersionSnapshot>(
    `SELECT v.*
     FROM agent_config_versions v
     JOIN agent_configs a ON a.id=v.agent_config_id AND a.tenant_id=v.tenant_id
     WHERE v.tenant_id=$1
     ORDER BY v.version_number DESC`,
    [tenantId]
  )).rows;
}

export function diffVersions(baseline: AgentVersionSnapshot, target: AgentVersionSnapshot) {
  return {
    systemPrompt: baseline.system_prompt === target.system_prompt ? null : {
      before: baseline.system_prompt,
      after: target.system_prompt
    },
    aiModel: baseline.ai_model === target.ai_model ? null : {
      before: baseline.ai_model,
      after: target.ai_model
    },
    modelParams: JSON.stringify(baseline.model_params) === JSON.stringify(target.model_params) ? null : {
      before: baseline.model_params,
      after: target.model_params
    },
    enabledTools: JSON.stringify(baseline.enabled_tools) === JSON.stringify(target.enabled_tools) ? null : {
      before: baseline.enabled_tools,
      after: target.enabled_tools
    }
  };
}

ALTER TABLE tenant_ai_settings
  ADD COLUMN evaluator_model TEXT,
  ADD COLUMN ai_evaluations_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE usage_logs
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'attendance';

ALTER TABLE usage_logs
  ADD CONSTRAINT usage_logs_purpose_check
  CHECK (purpose IN ('attendance','evaluation','replay'));

CREATE TABLE ai_attendance_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  agent_config_version_id UUID NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('closed','handoff','tool_error','manual','sampled')),
  rubric_version TEXT NOT NULL,
  evaluator_model TEXT NOT NULL,
  evaluator_prompt_version TEXT NOT NULL,
  scores JSONB NOT NULL CHECK (jsonb_typeof(scores)='object'),
  violations JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(violations)='array'),
  overall_score INT NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  has_critical_failure BOOLEAN NOT NULL DEFAULT false,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'automatic' CHECK (status IN ('automatic','confirmed','rejected')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,agent_config_version_id,rubric_version,trigger),
  UNIQUE (id,tenant_id),
  FOREIGN KEY (conversation_id,tenant_id)
    REFERENCES conversations(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_config_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id)
);

CREATE INDEX idx_ai_evaluations_tenant_created
  ON ai_attendance_evaluations(tenant_id,created_at DESC);
CREATE INDEX idx_ai_evaluations_tenant_status
  ON ai_attendance_evaluations(tenant_id,status,created_at DESC);

CREATE TABLE ai_regression_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_evaluation_id UUID REFERENCES ai_attendance_evaluations(id) ON DELETE SET NULL,
  scenario JSONB NOT NULL CHECK (jsonb_typeof(scenario)='object'),
  expected_behavior JSONB NOT NULL CHECK (jsonb_typeof(expected_behavior)='object'),
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,tenant_id)
);

CREATE INDEX idx_ai_regression_cases_tenant_active
  ON ai_regression_cases(tenant_id,is_active,created_at DESC);

CREATE TABLE ai_improvement_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  baseline_version_id UUID NOT NULL,
  candidate_version_id UUID NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  target_issue_codes JSONB NOT NULL CHECK (jsonb_typeof(target_issue_codes)='array'),
  evidence_evaluation_ids JSONB NOT NULL CHECK (jsonb_typeof(evidence_evaluation_ids)='array'),
  expected_impact JSONB NOT NULL CHECK (jsonb_typeof(expected_impact)='object'),
  status TEXT NOT NULL CHECK (status IN ('draft','proposed','testing','test_failed','ready','published','rejected','superseded')),
  created_by TEXT NOT NULL CHECK (created_by IN ('ai','human')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,tenant_id),
  FOREIGN KEY (baseline_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id),
  FOREIGN KEY (candidate_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id),
  CHECK (baseline_version_id <> candidate_version_id)
);

CREATE INDEX idx_ai_proposals_tenant_status
  ON ai_improvement_proposals(tenant_id,status,created_at DESC);

ALTER TABLE agent_config_versions
  ADD CONSTRAINT agent_config_versions_source_proposal_fk
  FOREIGN KEY (source_proposal_id,tenant_id)
  REFERENCES ai_improvement_proposals(id,tenant_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE ai_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL,
  baseline_version_id UUID NOT NULL,
  candidate_version_id UUID NOT NULL,
  rubric_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','technical_error')),
  aggregate_metrics JSONB NOT NULL DEFAULT '{}',
  estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,tenant_id),
  FOREIGN KEY (proposal_id,tenant_id)
    REFERENCES ai_improvement_proposals(id,tenant_id),
  FOREIGN KEY (baseline_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id),
  FOREIGN KEY (candidate_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id)
);

CREATE INDEX idx_ai_evaluation_runs_tenant_created
  ON ai_evaluation_runs(tenant_id,created_at DESC);

CREATE TABLE ai_evaluation_case_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  regression_case_id UUID NOT NULL,
  baseline_response TEXT NOT NULL,
  candidate_response TEXT NOT NULL,
  baseline_scores JSONB NOT NULL CHECK (jsonb_typeof(baseline_scores)='object'),
  candidate_scores JSONB NOT NULL CHECK (jsonb_typeof(candidate_scores)='object'),
  baseline_violations JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(baseline_violations)='array'),
  candidate_violations JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(candidate_violations)='array'),
  score_delta JSONB NOT NULL CHECK (jsonb_typeof(score_delta)='object'),
  simulated_tool_calls JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(simulated_tool_calls)='array'),
  passed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id,regression_case_id),
  FOREIGN KEY (run_id,tenant_id)
    REFERENCES ai_evaluation_runs(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (regression_case_id,tenant_id)
    REFERENCES ai_regression_cases(id,tenant_id)
);

CREATE INDEX idx_ai_case_results_run ON ai_evaluation_case_results(run_id);

CREATE OR REPLACE FUNCTION validate_ai_regression_case_sources()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations WHERE id=NEW.source_conversation_id AND tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'regression case conversation belongs to another tenant';
  END IF;
  IF NEW.source_evaluation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ai_attendance_evaluations WHERE id=NEW.source_evaluation_id AND tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'regression case evaluation belongs to another tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_regression_cases_validate_sources
BEFORE INSERT OR UPDATE OF tenant_id,source_conversation_id,source_evaluation_id ON ai_regression_cases
FOR EACH ROW EXECUTE FUNCTION validate_ai_regression_case_sources();

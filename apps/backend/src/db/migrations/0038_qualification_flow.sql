CREATE TABLE IF NOT EXISTS qualification_flows (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

-- Leads criados pelo fluxo de qualificação nascem antes de categoria/unidade existirem.
ALTER TABLE scheduling_leads ALTER COLUMN interest_category_id DROP NOT NULL;
ALTER TABLE scheduling_leads ALTER COLUMN unit_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS lead_qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  flow_id TEXT NOT NULL,
  current_step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','pausado','concluido')),
  answers JSONB NOT NULL DEFAULT '{}',
  history JSONB NOT NULL DEFAULT '[]',
  pending_value TEXT,
  ask_pending BOOLEAN NOT NULL DEFAULT false,
  faturamento TEXT,
  investimento TEXT,
  instagram TEXT,
  resultado_final TEXT,
  classificacao TEXT,
  answered_count INT NOT NULL DEFAULT 0,
  total_questions INT NOT NULL,
  last_inbound_external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES scheduling_leads(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, flow_id) REFERENCES qualification_flows(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_lead_qualifications_filters
  ON lead_qualifications(tenant_id, status, faturamento, resultado_final, investimento);

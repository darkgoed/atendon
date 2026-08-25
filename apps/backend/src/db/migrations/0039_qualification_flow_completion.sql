ALTER TABLE lead_qualifications
  ADD COLUMN IF NOT EXISTS definition_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS trigger_type TEXT,
  ADD COLUMN IF NOT EXISTS attribution JSONB NOT NULL DEFAULT '{}';

ALTER TABLE qualification_flows ALTER COLUMN active SET DEFAULT false;

UPDATE lead_qualifications q
SET definition_snapshot = f.definition
FROM qualification_flows f
WHERE q.definition_snapshot IS NULL
  AND f.tenant_id = q.tenant_id
  AND f.id = q.flow_id;

ALTER TABLE lead_qualifications ALTER COLUMN definition_snapshot SET NOT NULL;

ALTER TABLE lead_qualifications DROP CONSTRAINT IF EXISTS lead_qualifications_trigger_type_check;
ALTER TABLE lead_qualifications ADD CONSTRAINT lead_qualifications_trigger_type_check
  CHECK (trigger_type IS NULL OR trigger_type IN ('ctwa','session','keyword'));

-- O fluxo legado podia deixar mais de uma definição ativa. Mantém apenas a mais
-- recentemente atualizada antes de instalar a garantia por organização.
WITH ranked AS (
  SELECT tenant_id, id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY updated_at DESC, id) AS position
  FROM qualification_flows
  WHERE active
)
UPDATE qualification_flows f
SET active = false, updated_at = now()
FROM ranked r
WHERE f.tenant_id = r.tenant_id AND f.id = r.id AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_qualification_flows_one_active_per_tenant
  ON qualification_flows(tenant_id) WHERE active;

CREATE TABLE IF NOT EXISTS qualification_message_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qualification_id UUID NOT NULL REFERENCES lead_qualifications(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  contact_jid TEXT,
  step_id TEXT NOT NULL,
  inbound_external_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('question','clarification','confirmation','final')),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  external_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (qualification_id, step_id, inbound_external_id, message_kind)
);

CREATE INDEX IF NOT EXISTS idx_qualification_outbox_reconcile
  ON qualification_message_outbox(status, next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lead_qualifications_phone_lookup
  ON lead_qualifications(tenant_id, lead_id, status);

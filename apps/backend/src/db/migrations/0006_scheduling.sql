CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'IA de atendimento',
  key_hash TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduling_categories (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS scheduling_partners (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority_order INT NOT NULL CHECK (priority_order >= 1),
  proposal_link TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  UNIQUE (tenant_id, priority_order)
);

CREATE TABLE IF NOT EXISTS scheduling_units (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  opening_time TIME NOT NULL,
  closing_time TIME NOT NULL,
  operating_days SMALLINT[] NOT NULL,
  slot_duration_min INT NOT NULL DEFAULT 60 CHECK (slot_duration_min > 0),
  simultaneous_capacity INT NOT NULL DEFAULT 1 CHECK (simultaneous_capacity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK (opening_time < closing_time),
  CHECK (cardinality(operating_days) > 0),
  CHECK (operating_days <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
);

CREATE TABLE IF NOT EXISTS scheduling_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT,
  interest_category_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  partner_id TEXT,
  status TEXT NOT NULL DEFAULT 'em_qualificacao' CHECK (status IN (
    'em_qualificacao', 'aguardando_proposta', 'aprovado', 'recusado',
    'agendado', 'cancelado', 'transferido'
  )),
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone),
  CONSTRAINT scheduling_leads_id_tenant_unique UNIQUE (id, tenant_id),
  FOREIGN KEY (tenant_id, interest_category_id) REFERENCES scheduling_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES scheduling_units(tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES scheduling_partners(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS scheduling_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN (
    'confirmado', 'reagendado', 'cancelado', 'concluido', 'no_show'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES scheduling_units(tenant_id, id),
  CONSTRAINT scheduling_appointments_lead_tenant_fkey FOREIGN KEY (lead_id, tenant_id) REFERENCES scheduling_leads(id, tenant_id) ON DELETE RESTRICT,
  CHECK (end_at > start_at)
);

CREATE TABLE IF NOT EXISTS scheduling_lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ,CONSTRAINT scheduling_lead_events_lead_tenant_fkey FOREIGN KEY (lead_id, tenant_id) REFERENCES scheduling_leads(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduling_transfer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id TEXT,
  reason TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'webhook',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT scheduling_transfer_notifications_lead_tenant_fkey FOREIGN KEY (lead_id, tenant_id) REFERENCES scheduling_leads(id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE scheduling_leads ALTER COLUMN interest_category_id SET NOT NULL;
ALTER TABLE scheduling_leads ALTER COLUMN unit_id SET NOT NULL;
ALTER TABLE scheduling_leads ALTER COLUMN source SET NOT NULL;
ALTER TABLE scheduling_appointments DROP CONSTRAINT IF EXISTS scheduling_appointments_lead_id_fkey;
ALTER TABLE scheduling_lead_events DROP CONSTRAINT IF EXISTS scheduling_lead_events_lead_id_fkey;
ALTER TABLE scheduling_transfer_notifications DROP CONSTRAINT IF EXISTS scheduling_transfer_notifications_lead_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scheduling_leads_id_tenant_unique') THEN
    ALTER TABLE scheduling_leads ADD CONSTRAINT scheduling_leads_id_tenant_unique UNIQUE(id,tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scheduling_appointments_lead_tenant_fkey') THEN
    ALTER TABLE scheduling_appointments ADD CONSTRAINT scheduling_appointments_lead_tenant_fkey
      FOREIGN KEY(lead_id,tenant_id) REFERENCES scheduling_leads(id,tenant_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scheduling_lead_events_lead_tenant_fkey') THEN
    ALTER TABLE scheduling_lead_events ADD CONSTRAINT scheduling_lead_events_lead_tenant_fkey
      FOREIGN KEY(lead_id,tenant_id) REFERENCES scheduling_leads(id,tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scheduling_transfer_notifications_lead_tenant_fkey') THEN
    ALTER TABLE scheduling_transfer_notifications ADD CONSTRAINT scheduling_transfer_notifications_lead_tenant_fkey
      FOREIGN KEY(lead_id,tenant_id) REFERENCES scheduling_leads(id,tenant_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_filters
  ON scheduling_leads(tenant_id, status, unit_id, interest_category_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_availability
  ON scheduling_appointments(tenant_id, unit_id, start_at, status);
CREATE INDEX IF NOT EXISTS idx_scheduling_lead_events_timeline
  ON scheduling_lead_events(tenant_id, lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_hash ON tenant_api_keys(key_hash) WHERE active;

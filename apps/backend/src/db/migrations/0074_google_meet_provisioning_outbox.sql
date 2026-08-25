ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS meeting_provisioning_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS meeting_provisioning_error TEXT,
  ADD COLUMN IF NOT EXISTS creation_idempotency_key TEXT;

UPDATE scheduling_appointments
SET meeting_provisioning_status = CASE
  WHEN meeting_url IS NOT NULL THEN 'ready'
  ELSE 'not_required'
END
WHERE meeting_provisioning_status = 'not_required';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_appointments_meeting_provisioning_status_check'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_meeting_provisioning_status_check
      CHECK (meeting_provisioning_status IN (
        'not_required', 'pending', 'processing', 'ready', 'failed', 'uncertain'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_appointments_id_tenant_unique'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduling_appointments_creation_idempotency
  ON scheduling_appointments(tenant_id, creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduling_meeting_provisioning_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL,
  operation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_meeting_outbox_appointment_tenant_fkey
    FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_meeting_outbox_appointment_unique UNIQUE (tenant_id, appointment_id),
  CONSTRAINT scheduling_meeting_outbox_operation_unique UNIQUE (tenant_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_scheduling_meeting_outbox_due
  ON scheduling_meeting_provisioning_outbox(status, available_at, created_at, id)
  WHERE status IN ('pending', 'processing');

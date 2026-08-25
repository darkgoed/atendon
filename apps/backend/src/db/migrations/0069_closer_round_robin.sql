ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS assigned_member_id UUID,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

UPDATE scheduling_appointments
SET assigned_at=created_at
WHERE assigned_member_id IS NOT NULL
  AND assigned_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scheduling_appointments_assigned_member_tenant_fkey'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_assigned_member_tenant_fkey
      FOREIGN KEY (assigned_member_id,tenant_id)
      REFERENCES workspace_members(id,workspace_id)
      ON DELETE SET NULL (assigned_member_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_closer_active
  ON scheduling_appointments(tenant_id,assigned_member_id,start_at)
  WHERE assigned_member_id IS NOT NULL
    AND status IN ('confirmado','reagendado');

CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_closer_history
  ON scheduling_appointments(tenant_id,assigned_member_id,assigned_at DESC)
  WHERE assigned_member_id IS NOT NULL;

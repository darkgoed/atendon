ALTER TABLE scheduling_google_meet_closers
  ADD COLUMN IF NOT EXISTS availability_status TEXT NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS availability_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS availability_changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_google_meet_closers_availability_status_check'
  ) THEN
    ALTER TABLE scheduling_google_meet_closers
      ADD CONSTRAINT scheduling_google_meet_closers_availability_status_check
      CHECK (availability_status IN ('available','unavailable'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduling_attendants_availability
  ON scheduling_google_meet_closers(tenant_id,availability_status,member_id);

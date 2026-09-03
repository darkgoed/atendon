DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_meeting_confirmation_appointment_tenant_fkey'
      AND conrelid = 'scheduling_meeting_confirmation_outbox'::regclass
  ) THEN
    ALTER TABLE scheduling_meeting_confirmation_outbox
      DROP CONSTRAINT scheduling_meeting_confirmation_appointment_tenant_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_meeting_confirmation_appointment_tenant_fkey'
      AND conrelid = 'scheduling_meeting_confirmation_outbox'::regclass
  ) THEN
    ALTER TABLE scheduling_meeting_confirmation_outbox
      ADD CONSTRAINT scheduling_meeting_confirmation_appointment_tenant_fkey
      FOREIGN KEY (appointment_id, tenant_id)
      REFERENCES scheduling_appointments(id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END $$;

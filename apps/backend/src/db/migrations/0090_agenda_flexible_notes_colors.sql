ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS observation TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scheduling_appointments_observation_length_check'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_observation_length_check
      CHECK (observation IS NULL OR char_length(observation) <= 4000);
  END IF;
END $$;

ALTER TABLE scheduling_google_meet_closers
  ADD COLUMN IF NOT EXISTS calendar_color TEXT NOT NULL DEFAULT '#2563EB';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scheduling_google_meet_closers_calendar_color_check'
  ) THEN
    ALTER TABLE scheduling_google_meet_closers
      ADD CONSTRAINT scheduling_google_meet_closers_calendar_color_check
      CHECK (calendar_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

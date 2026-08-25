ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS meeting_provider TEXT,
  ADD COLUMN IF NOT EXISTS meeting_space_name TEXT,
  ADD COLUMN IF NOT EXISTS meeting_code TEXT,
  ADD COLUMN IF NOT EXISTS meeting_url TEXT,
  ADD COLUMN IF NOT EXISTS meeting_created_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_appointments_meeting_provider_check'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_meeting_provider_check
      CHECK (meeting_provider IS NULL OR meeting_provider = 'google_meet');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_appointments_meeting_fields_check'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_meeting_fields_check
      CHECK (
        (meeting_provider IS NULL AND meeting_space_name IS NULL AND meeting_code IS NULL AND meeting_url IS NULL AND meeting_created_at IS NULL)
        OR
        (meeting_provider = 'google_meet' AND meeting_space_name IS NOT NULL AND meeting_code IS NOT NULL AND meeting_url IS NOT NULL AND meeting_created_at IS NOT NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS scheduling_google_meet_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  organizer_email TEXT,
  creation_moment TEXT NOT NULL DEFAULT 'appointment_confirmed'
    CHECK (creation_moment = 'appointment_confirmed'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR organizer_email IS NOT NULL)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_id_workspace_unique'
  ) THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS scheduling_google_meet_closers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_id),
  CONSTRAINT scheduling_google_meet_closers_member_workspace_fkey
    FOREIGN KEY (member_id, tenant_id)
    REFERENCES workspace_members(id, workspace_id) ON DELETE CASCADE
);

ALTER TABLE system_alerts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'operational',
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_alerts_kind_check'
  ) THEN
    ALTER TABLE system_alerts
      ADD CONSTRAINT system_alerts_kind_check CHECK (kind IN ('operational', 'meeting'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_alerts_audience_check'
  ) THEN
    ALTER TABLE system_alerts
      ADD CONSTRAINT system_alerts_audience_check CHECK (audience IN ('workspace', 'selected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduling_google_meet_closers_tenant
  ON scheduling_google_meet_closers(tenant_id, member_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_meeting_url
  ON scheduling_appointments(tenant_id, meeting_url)
  WHERE meeting_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_alerts_targeted
  ON system_alerts(tenant_id, created_at DESC)
  WHERE audience = 'selected';

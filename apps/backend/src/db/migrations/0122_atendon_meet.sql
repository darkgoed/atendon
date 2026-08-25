ALTER TABLE scheduling_appointments
  DROP CONSTRAINT IF EXISTS scheduling_appointments_meeting_provider_check,
  DROP CONSTRAINT IF EXISTS scheduling_appointments_meeting_fields_check;

ALTER TABLE scheduling_appointments
  ADD CONSTRAINT scheduling_appointments_meeting_provider_check
    CHECK (meeting_provider IS NULL OR meeting_provider IN ('google_meet', 'atendon_meet')),
  ADD CONSTRAINT scheduling_appointments_meeting_fields_check
    CHECK (
      (meeting_provider IS NULL AND meeting_space_name IS NULL AND meeting_code IS NULL AND meeting_url IS NULL AND meeting_created_at IS NULL)
      OR
      (meeting_provider IN ('google_meet', 'atendon_meet')
        AND meeting_space_name IS NOT NULL
        AND meeting_code IS NOT NULL
        AND meeting_url IS NOT NULL
        AND meeting_created_at IS NOT NULL)
    );

CREATE TABLE scheduling_atendon_meet_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meet_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL UNIQUE,
  public_code TEXT NOT NULL UNIQUE,
  appointment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT meet_rooms_appointment_tenant_fkey
    FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id)
    ON DELETE SET NULL (appointment_id),
  CONSTRAINT meet_rooms_room_name_format_check
    CHECK (room_name ~ '^atendon-[a-z0-9]{32}$'),
  CONSTRAINT meet_rooms_public_code_format_check
    CHECK (public_code ~ '^[A-Za-z0-9_-]{32}$')
);

CREATE UNIQUE INDEX idx_meet_rooms_appointment
  ON meet_rooms(appointment_id)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX idx_meet_rooms_tenant_created
  ON meet_rooms(tenant_id, created_at DESC);
CREATE INDEX idx_meet_rooms_expiry
  ON meet_rooms(expires_at);

CREATE TABLE meet_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  appointment_id UUID,
  file_path TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'missing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meet_recordings_appointment_tenant_fkey
    FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id)
    ON DELETE SET NULL (appointment_id)
);

CREATE INDEX idx_meet_recordings_tenant_created
  ON meet_recordings(tenant_id, created_at DESC);
CREATE INDEX idx_meet_recordings_appointment
  ON meet_recordings(tenant_id, appointment_id, created_at DESC)
  WHERE appointment_id IS NOT NULL;

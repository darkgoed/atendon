CREATE TABLE scheduling_attendant_time_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_attendant_time_blocks_member_fkey
    FOREIGN KEY(member_id,tenant_id)
    REFERENCES workspace_members(id,workspace_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_attendant_time_blocks_interval_check CHECK (end_at>start_at),
  CONSTRAINT scheduling_attendant_time_blocks_reason_check CHECK (reason IS NULL OR length(reason)<=500)
);

CREATE INDEX idx_scheduling_attendant_time_blocks_interval
  ON scheduling_attendant_time_blocks(tenant_id,member_id,start_at,end_at);


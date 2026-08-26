CREATE TABLE scheduling_attendant_recurring_time_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  start_local_time time NOT NULL,
  end_local_time time NOT NULL,
  weekdays smallint[] NOT NULL,
  starts_on date NOT NULL,
  ends_on date NULL,
  timezone text NOT NULL,
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid NULL,
  CONSTRAINT recurring_blocks_member_fk FOREIGN KEY (tenant_id, member_id) REFERENCES workspace_members(workspace_id,id),
  CONSTRAINT recurring_blocks_interval_ck CHECK (end_local_time > start_local_time),
  CONSTRAINT recurring_blocks_weekdays_ck CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CONSTRAINT recurring_blocks_dates_ck CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT recurring_blocks_reason_ck CHECK (length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE INDEX scheduling_attendant_recurring_time_blocks_tenant_member_idx ON scheduling_attendant_recurring_time_blocks(tenant_id, member_id, starts_on, ends_on) WHERE active;

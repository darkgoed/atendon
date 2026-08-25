ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS ai_follow_up_delays_minutes INTEGER[]
  NOT NULL DEFAULT ARRAY[120,1440,4320]::integer[];

ALTER TABLE ai_follow_up_schedules
  ADD COLUMN IF NOT EXISTS sequence_started_at TIMESTAMPTZ;

UPDATE ai_follow_up_schedules
SET sequence_started_at=created_at
WHERE sequence_started_at IS NULL;

ALTER TABLE ai_follow_up_schedules
  ALTER COLUMN sequence_started_at SET DEFAULT now(),
  ALTER COLUMN sequence_started_at SET NOT NULL;

UPDATE tenant_ai_settings
SET ai_follow_up_delays_minutes = CASE
      WHEN ai_follow_up_interval_minutes = 1
        THEN ARRAY[120,1440,4320]::integer[]
      ELSE ARRAY(
        SELECT ai_follow_up_interval_minutes * attempt
        FROM generate_series(1,ai_follow_up_max_count) attempt
        WHERE ai_follow_up_interval_minutes * attempt <= 43200
      )
    END;

UPDATE tenant_ai_settings
SET ai_follow_up_max_count=cardinality(ai_follow_up_delays_minutes),
    ai_follow_up_interval_minutes=ai_follow_up_delays_minutes[1];

ALTER TABLE tenant_ai_settings
  DROP CONSTRAINT IF EXISTS tenant_ai_settings_follow_up_delays_check;

ALTER TABLE tenant_ai_settings
  ADD CONSTRAINT tenant_ai_settings_follow_up_delays_check
  CHECK (
    cardinality(ai_follow_up_delays_minutes) BETWEEN 1 AND 10
    AND ai_follow_up_delays_minutes[1] BETWEEN 1 AND 43200
    AND ai_follow_up_delays_minutes[cardinality(ai_follow_up_delays_minutes)] BETWEEN 1 AND 43200
  );

UPDATE ai_follow_up_schedules
SET status='cancelled',
    next_run_at=NULL,
    processing_started_at=NULL,
    cancellation_reason='cadence_migrated_overdue',
    sequence_version=sequence_version+1,
    updated_at=now()
WHERE status IN ('scheduled','processing')
  AND COALESCE(next_run_at,processing_started_at) <= now();

UPDATE ai_follow_up_schedules f
SET next_run_at=f.sequence_started_at
      + make_interval(mins => s.ai_follow_up_delays_minutes[f.follow_up_count+1]),
    processing_started_at=NULL,
    sequence_version=f.sequence_version+1,
    updated_at=now()
FROM tenant_ai_settings s
WHERE f.tenant_id=s.tenant_id
  AND f.status='scheduled'
  AND f.follow_up_count < cardinality(s.ai_follow_up_delays_minutes);

ALTER TABLE ai_evaluation_signals
  DROP CONSTRAINT IF EXISTS ai_evaluation_signals_kind_check;

ALTER TABLE ai_evaluation_signals
  ADD CONSTRAINT ai_evaluation_signals_kind_check
  CHECK (kind IN (
    'ai_error',
    'tool_limit',
    'repeated_offer',
    'unnecessary_reconfirmation',
    'open_scheduling_question',
    'incorrect_slot_rejection'
  ));

ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS event_occurred_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS event_occurred_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payments_provider_external_event_time
  ON payments(provider_id, external_id, event_occurred_at);

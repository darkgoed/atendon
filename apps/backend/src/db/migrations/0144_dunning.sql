CREATE TABLE IF NOT EXISTS billing_dunning_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','SUCCEEDED','FAILED')),
  error_code TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_dunning_due ON billing_dunning_attempts(next_attempt_at) WHERE status='FAILED';
CREATE INDEX IF NOT EXISTS idx_dunning_invoice ON billing_dunning_attempts(invoice_id, attempted_at DESC);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS dunning_next_attempt_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS dunning_exhausted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_dunning_due ON invoices(due_date, dunning_next_attempt_at) WHERE status IN ('open','pending');

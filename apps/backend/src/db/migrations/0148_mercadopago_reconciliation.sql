CREATE TABLE IF NOT EXISTS mercadopago_reconciliation_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL CHECK (finding_type IN ('STATUS_MISMATCH','AMOUNT_MISMATCH','CURRENCY_MISMATCH','REFERENCE_MISMATCH','GATEWAY_ERROR')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  local_snapshot JSONB NOT NULL,
  remote_snapshot JSONB NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(payment_id, finding_type)
);
CREATE INDEX IF NOT EXISTS idx_mp_reconciliation_findings_tenant ON mercadopago_reconciliation_findings(tenant_id, resolved_at, detected_at DESC);

-- Lease de reconciliação: o claim é um UPDATE atômico, portanto protege entre
-- processos/réplicas sem manter uma transação aberta durante a chamada HTTP.
-- Leases vencidas voltam a ser elegíveis se um worker morrer no meio.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS reconciliation_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payments_reconciliation_claim
  ON payments (reconciliation_claimed_at, created_at DESC)
  WHERE external_id IS NOT NULL;

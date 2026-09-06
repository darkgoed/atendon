ALTER TABLE usage_grants ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_grants_tenant_idempotency ON usage_grants(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS financial_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_before_cents BIGINT NOT NULL CHECK (balance_before_cents >= 0),
  balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  actor_type TEXT NOT NULL,
  actor_id UUID,
  reason TEXT NOT NULL,
  source_event_id TEXT,
  invoice_id UUID,
  payment_id TEXT,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_tenant_created ON financial_ledger(tenant_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_ledger_source_correlation ON financial_ledger(tenant_id, source_event_id, correlation_id) WHERE source_event_id IS NOT NULL AND correlation_id IS NOT NULL;

-- Imutabilidade de LINHA: nenhum UPDATE, e nenhum DELETE avulso — corrigir um
-- lançamento exige um lançamento de estorno, nunca reescrever o histórico.
--
-- O DELETE em cascata do tenant é a única exceção, e é deliberada: sem ela
-- `DELETE FROM tenants` passa a ser impossível, o que quebraria remoção de
-- cliente (inclusive pedido de exclusão de dados) e a limpeza das suítes.
-- Distinguimos os dois casos porque, no cascade, a linha de `tenants` já não
-- existe mais quando o trigger roda.
CREATE OR REPLACE FUNCTION prevent_financial_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'financial_ledger is append-only';
END;
$$;
DROP TRIGGER IF EXISTS financial_ledger_immutable ON financial_ledger;
CREATE TRIGGER financial_ledger_immutable BEFORE UPDATE OR DELETE ON financial_ledger FOR EACH ROW EXECUTE FUNCTION prevent_financial_ledger_mutation();

CREATE TABLE IF NOT EXISTS fraud_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('PAYMENT_VELOCITY','DISTINCT_PAYER','REPEATED_CHARGEBACK')),
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  score INT NOT NULL DEFAULT 0,
  observed_count INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL,
  source_key TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_tenant_created ON fraud_signals(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_tenant_type ON fraud_signals(tenant_id, signal_type, created_at DESC);

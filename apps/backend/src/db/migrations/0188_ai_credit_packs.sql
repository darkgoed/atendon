-- Purchasable AI credit packages: one server-fixed SKU of 50,000,000 normalized
-- credits for R$157.00 (see 0187 for the normalization anchor). A purchase row
-- is created synchronously by POST /billing/ai-credit-packs (invoice kind
-- 'credit_package'), but the usage_grants CREDIT_PACKAGE row is granted ONLY by
-- the authenticated/paid billing webhook (applyApproved), in the same
-- transaction that marks the payment paid. Reversals (refunded/charged_back)
-- revoke only the remaining balance; history is never deleted.
CREATE TABLE IF NOT EXISTS ai_credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  sku TEXT NOT NULL,
  credits BIGINT NOT NULL,
  price_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  grant_id UUID REFERENCES usage_grants(id),
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT', 'GRANTED', 'REVERSED')),
  granted_at TIMESTAMPTZ,
  revoked_credits BIGINT NOT NULL DEFAULT 0 CHECK (revoked_credits >= 0),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (invoice_id),
  -- Price/quantity are server constants; no caller (route, worker or ROOT) can
  -- insert a pack with different amount/price. New SKUs require a new migration.
  CHECK (credits = 50000000 AND price_cents = 15700 AND currency = 'BRL')
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_purchases_tenant ON ai_credit_purchases(tenant_id, created_at DESC);

-- The pack is an AI purchase: BASIC (whose plans.ai_enabled was opened by 0187)
-- gets the AI feature so the catalog matches consumption. AI_FOLLOWUP is only
-- enabled where the plan already carries it — no new features are opened.
INSERT INTO plan_features(plan_id, feature_key, enabled)
SELECT p.id, 'AI', true FROM plans p WHERE p.code = 'BASIC'
ON CONFLICT (plan_id, feature_key) DO UPDATE SET enabled = true;

UPDATE plan_features pf SET enabled = true
FROM plans p
WHERE p.id = pf.plan_id AND p.code = 'BASIC' AND pf.feature_key = 'AI_FOLLOWUP';

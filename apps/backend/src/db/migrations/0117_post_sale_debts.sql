CREATE TABLE post_sale_debts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store TEXT NOT NULL CHECK (char_length(btrim(store)) BETWEEN 1 AND 200),
  customer_name TEXT NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 200),
  phone_raw TEXT,
  phone_e164 TEXT CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[1-9][0-9]{7,14}$'),
  reference_date DATE,
  amount_open NUMERIC(12,2),
  amount_recovered NUMERIC(12,2),
  status TEXT,
  contact_method TEXT,
  payment_method TEXT,
  reason TEXT,
  promise_date DATE,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 5000),
  days_without_contact INT,
  alert TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT post_sale_debts_id_tenant_unique UNIQUE(id,tenant_id)
);

CREATE INDEX idx_post_sale_debts_tenant ON post_sale_debts(tenant_id,reference_date DESC,id DESC);
CREATE INDEX idx_post_sale_debts_phone ON post_sale_debts(tenant_id,phone_e164) WHERE phone_e164 IS NOT NULL;

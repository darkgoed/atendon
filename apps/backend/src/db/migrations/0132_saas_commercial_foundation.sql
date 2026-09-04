-- Commercial SaaS foundation: catalogs, plans, subscriptions, usage and billing.
CREATE TABLE feature_catalog (
  feature_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  is_future BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE limit_catalog (
  limit_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count',
  period TEXT NOT NULL CHECK (period IN ('lifetime','billing_period')),
  is_enforced BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  monthly_price_cents BIGINT NOT NULL DEFAULT 0 CHECK (monthly_price_cents >= 0),
  setup_price_cents BIGINT NOT NULL DEFAULT 0 CHECK (setup_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL', billing_period_months INTEGER NOT NULL DEFAULT 1 CHECK (billing_period_months > 0),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0), grace_period_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_period_days >= 0),
  is_internal BOOLEAN NOT NULL DEFAULT false, position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE plan_features (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE, feature_key TEXT NOT NULL REFERENCES feature_catalog(feature_key),
  enabled BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE plan_limits (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE, limit_key TEXT NOT NULL REFERENCES limit_catalog(limit_key),
  limit_value BIGINT CHECK (limit_value IS NULL OR limit_value >= 0), PRIMARY KEY (plan_id, limit_key)
);
CREATE TABLE billing_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')), credentials_encrypted TEXT, credentials_hint TEXT,
  webhook_secret_encrypted TEXT, accepted_methods TEXT[], last_event_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenant_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id), status TEXT NOT NULL CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','GRACE_PERIOD','SUSPENDED','CANCELED','EXPIRED')),
  current_period_start TIMESTAMPTZ NOT NULL, current_period_end TIMESTAMPTZ NOT NULL, trial_ends_at TIMESTAMPTZ, grace_period_ends_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ, suspended_at TIMESTAMPTZ, price_override_cents BIGINT, setup_price_override_cents BIGINT,
  discount_type TEXT, discount_value BIGINT, discount_expires_at TIMESTAMPTZ, billing_provider_id UUID REFERENCES billing_providers(id), external_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenant_entitlement_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('feature','limit')), entitlement_key TEXT NOT NULL, bool_value BOOLEAN, int_value BIGINT,
  reason TEXT, expires_at TIMESTAMPTZ, granted_by_user_id UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, entitlement_key)
);
CREATE TABLE subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, from_plan_id UUID REFERENCES plans(id), to_plan_id UUID REFERENCES plans(id), from_status TEXT, to_status TEXT, actor_user_id UUID REFERENCES users(id), metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE usage_counters (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL, metric_key TEXT NOT NULL, used BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, period_start, metric_key)
);
CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, metric_key TEXT NOT NULL, quantity BIGINT NOT NULL CHECK (quantity >= 0), idempotency_key TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB, UNIQUE (tenant_id, metric_key, idempotency_key)
);
CREATE TABLE billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE, provider_id UUID NOT NULL REFERENCES billing_providers(id), external_customer_id TEXT, document TEXT, email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, subscription_id UUID REFERENCES tenant_subscriptions(id), provider_id UUID REFERENCES billing_providers(id), external_id TEXT, kind TEXT NOT NULL, amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0), currency TEXT NOT NULL DEFAULT 'BRL', status TEXT NOT NULL, due_date TIMESTAMPTZ, period_start TIMESTAMPTZ, period_end TIMESTAMPTZ, paid_at TIMESTAMPTZ, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, invoice_id UUID NOT NULL REFERENCES invoices(id), provider_id UUID REFERENCES billing_providers(id), external_id TEXT, amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0), currency TEXT NOT NULL DEFAULT 'BRL', status TEXT NOT NULL, method TEXT, paid_at TIMESTAMPTZ, confirmed_by_user_id UUID REFERENCES users(id), metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider_id UUID NOT NULL REFERENCES billing_providers(id), external_event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL, signature_valid BOOLEAN NOT NULL DEFAULT false, tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL, processed_at TIMESTAMPTZ, processing_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (provider_id, external_event_id)
);
INSERT INTO feature_catalog(feature_key,label,category,is_future) VALUES
('CONVERSATIONS','Conversations','core',false),('LEADS','Leads','core',false),('PIPELINE','Pipeline','commercial',false),('CALENDAR','Calendar','commercial',false),('AI','AI','commercial',false),('AI_FOLLOWUP','AI Follow-up','commercial',false),('POST_SALES','Post-sales','commercial',false),('MEET','Meet','commercial',false),('AI_STICKERS','AI Stickers','commercial',false),('WEB_PUSH','Web Push','commercial',false),('BULK_OPERATIONS','Bulk operations','commercial',false),('ADVANCED_REPORTS','Advanced reports','commercial',false),('ROLES_PERMISSIONS','Roles and permissions','commercial',false),('DASHBOARD_WIDGETS','Dashboard widgets','commercial',false),('API_ACCESS','API access','commercial',true),('WEBHOOKS','Webhooks','commercial',true),('CUSTOM_FIELDS','Custom fields','commercial',true),('INTEGRATIONS','Integrations','commercial',true),('CONTACT_IMPORT','Contact import','commercial',true),('CONTACT_EXPORT','Contact export','commercial',true),('MULTIPLE_PIPELINES','Multiple pipelines','commercial',true),('LEAD_DISTRIBUTION','Lead distribution','commercial',true);
INSERT INTO limit_catalog(limit_key,label,unit,period,is_enforced) VALUES
('MAX_USERS','Maximum users','count','lifetime',true),('MAX_WHATSAPP_CONNECTIONS','Maximum WhatsApp connections','count','lifetime',true),('MAX_AI_INTERACTIONS','Maximum AI interactions','count','billing_period',true),('MAX_PIPELINES','Maximum pipelines','count','lifetime',false),('MAX_CONTACTS','Maximum contacts','count','lifetime',false),('MAX_STORAGE','Maximum storage','bytes','lifetime',false),('MAX_AUTOMATIONS','Maximum automations','count','lifetime',false),('MAX_CUSTOM_FIELDS','Maximum custom fields','count','lifetime',false);
CREATE INDEX idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id); CREATE INDEX idx_tenant_entitlement_overrides_tenant ON tenant_entitlement_overrides(tenant_id); CREATE INDEX idx_subscription_events_tenant ON subscription_events(tenant_id); CREATE INDEX idx_usage_counters_tenant ON usage_counters(tenant_id); CREATE INDEX idx_usage_events_tenant ON usage_events(tenant_id); CREATE INDEX idx_billing_accounts_tenant ON billing_accounts(tenant_id); CREATE INDEX idx_invoices_tenant ON invoices(tenant_id); CREATE INDEX idx_payments_tenant ON payments(tenant_id); CREATE INDEX idx_billing_events_tenant ON billing_events(tenant_id);

-- Mandato Pix Automato (Efí) para a assinatura mensal do pacote de créditos de
-- IA: 50.000.000 créditos por R$157,00 (SKU do 0188), debitados via mandato
-- recorrente (`rec`) da Efí. Nenhuma cobrança nasce aqui: as tabelas só
-- registram o mandato autorizado pelo usuário e as cobranças mensais dele
-- derivadas — o fluxo Efí (API + webhook) vem depois.
--
-- Duplicidade travada no schema, antes de qualquer chamada ao gateway:
-- - um único mandato em curso por tenant (índice parcial sobre
--   CREATING/PENDING/APPROVED; CANCELLED/REJECTED/EXPIRED liberam um novo);
-- - uma cobrança por (mandato, vencimento), txid global único na faixa
--   26-35 alfanuméricos do padrão Pix (UUID com hífen NÃO é txid válido) e
--   uma fatura por cobrança (invoice_id UNIQUE).
-- Dado do titular: CPF e nome NUNCA entram nestas tabelas — trafegam cifrados
-- para a Efí e do lado local vivem apenas em billing_accounts.
CREATE TABLE IF NOT EXISTS ai_credit_pix_mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES billing_providers(id),
  external_id_rec TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATING' CHECK (status IN ('CREATING', 'PENDING', 'APPROVED', 'CANCELLED', 'REJECTED', 'EXPIRED')),
  first_due_on DATE NOT NULL,
  location_id TEXT,
  consent_actor_user_id UUID NOT NULL REFERENCES users(id),
  consent_requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  -- Preço/quantidade são constantes do servidor (mesmo SKU do 0188); nenhum
  -- chamador insere mandato com valores diferentes. Novo SKU = nova migration.
  credits BIGINT NOT NULL CHECK (credits = 50000000),
  price_cents BIGINT NOT NULL CHECK (price_cents = 15700),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_pix_mandates_tenant
  ON ai_credit_pix_mandates(tenant_id, created_at DESC);

-- Um mandato em curso por tenant: a segunda criação/reativação colide aqui,
-- não na API da Efí.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_credit_pix_mandates_active_tenant
  ON ai_credit_pix_mandates(tenant_id)
  WHERE status IN ('CREATING', 'PENDING', 'APPROVED');

CREATE TABLE IF NOT EXISTS ai_credit_pix_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id UUID NOT NULL REFERENCES ai_credit_pix_mandates(id) ON DELETE CASCADE,
  due_on DATE NOT NULL,
  -- txid Pix: 26-35 alfanuméricos, sem hífen (UUID com hífen tem 36 caracteres
  -- e é rejeitado pela Efí/RSFN).
  txid TEXT NOT NULL UNIQUE CHECK (txid ~ '^[a-zA-Z0-9]{26,35}$'),
  invoice_id UUID UNIQUE REFERENCES invoices(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED', 'REJECTED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, due_on)
);

-- Provisiona a Efí (sandbox e production) SEM efeito financeiro: enabled=false,
-- status NOT_CONFIGURED. `pix_automatic` como único método aceito — a Efí não
-- emite PIX avulso. homologated=true libera a CONFIGURAÇÃO (credenciais,
-- webhook secret, ativação pelo ROOT em store.ts), mas a cobrança PIX avulsa
-- (charges.ts) continua isolada: o fallback filtra code='mercadopago' e
-- invoice.provider_id→efipay falha fechado.
INSERT INTO billing_providers (code, name, enabled, environment, status, accepted_methods, homologated)
VALUES
  ('efipay', 'Efí', false, 'sandbox',    'NOT_CONFIGURED', ARRAY['pix_automatic'], true),
  ('efipay', 'Efí', false, 'production', 'NOT_CONFIGURED', ARRAY['pix_automatic'], true)
ON CONFLICT (code, environment) DO NOTHING;

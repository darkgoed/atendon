-- Catálogo de motivos de desqualificação/perda por tenant + observação livre.
--
-- PEDIDO DE ORIGEM (sócio da Newave): marcar um lead como desqualificado
-- escolhendo o motivo em um select ("Não tem interesse", "Queria somente
-- empréstimo", "Não consegue investir") e registrar uma observação quando o
-- motivo for "Outro".
--
-- POR QUE UM CATÁLOGO E NÃO MAIS VALORES NO CHECK
-- Até aqui `loss_reason` era um CHECK global com 7 valores fixos
-- (migration 0112). Acrescentar vocabulário da Newave ali vazaria os motivos
-- dela para Meta Cell e Tripz, que compartilham as mesmas tabelas. Trocamos o
-- CHECK por uma FK para `lead_loss_reasons(tenant_id,key)`, de modo que cada
-- tenant tenha o seu próprio conjunto e o painel possa administrá-lo sem
-- migration nova a cada pedido comercial.
--
-- COMPATIBILIDADE
-- Os 7 motivos legados são semeados para TODOS os tenants (existentes e
-- futuros, via trigger), com os mesmos `key`s de antes. Nenhuma linha atual de
-- scheduling_leads/scheduling_appointments fica inválida e nenhum código que
-- envie 'preco' ou 'sem_interesse' quebra.
--
-- ESCOPO DA NEWAVE
-- Os três motivos novos são inseridos apenas para o tenant slug 'newave-ia'.
-- Em ambiente limpo/CI onde o tenant não existe, essa parte é no-op.
--
-- IDEMPOTÊNCIA: todas as inserções usam ON CONFLICT DO NOTHING e as alterações
-- de constraint são condicionais. Reexecutar não duplica nem falha.
--
-- ROLLBACK:
--   ALTER TABLE scheduling_leads DROP CONSTRAINT scheduling_leads_loss_reason_fkey;
--   ALTER TABLE scheduling_appointments DROP CONSTRAINT scheduling_appointments_loss_reason_fkey;
--   ALTER TABLE scheduling_leads DROP COLUMN loss_reason_note;
--   ALTER TABLE scheduling_appointments DROP COLUMN loss_reason_note;
--   DROP TABLE lead_loss_reasons;  -- e recriar os CHECKs de 0112

CREATE TABLE IF NOT EXISTS lead_loss_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 100,
  requires_note BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_loss_reasons_key_check CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  CONSTRAINT lead_loss_reasons_label_check CHECK (btrim(label) <> ''),
  CONSTRAINT lead_loss_reasons_tenant_key_unique UNIQUE(tenant_id,key)
);

CREATE INDEX IF NOT EXISTS idx_lead_loss_reasons_tenant_active
  ON lead_loss_reasons(tenant_id,archived_at,position);

-- Motivos legados da 0112, preservados para todo tenant já existente.
INSERT INTO lead_loss_reasons(tenant_id,key,label,position,requires_note,is_system)
SELECT tenant.id,catalog.key,catalog.label,catalog.position,catalog.requires_note,true
FROM tenants tenant
CROSS JOIN (VALUES
  ('preco','Preço',10,false),
  ('sem_interesse','Não tem interesse',20,false),
  ('sem_momento','Sem momento',30,false),
  ('nao_qualificado','Não qualificado',40,false),
  ('concorrente','Escolheu um concorrente',50,false),
  ('sem_retorno','Sem retorno',60,false),
  ('outro','Outro',900,true)
) AS catalog(key,label,position,requires_note)
ON CONFLICT (tenant_id,key) DO NOTHING;

-- Vocabulário comercial pedido pela Newave.
INSERT INTO lead_loss_reasons(tenant_id,key,label,position,requires_note,is_system)
SELECT tenant.id,catalog.key,catalog.label,catalog.position,false,false
FROM tenants tenant
CROSS JOIN (VALUES
  ('queria_emprestimo','Queria somente empréstimo',70),
  ('nao_consegue_investir','Não consegue investir',80)
) AS catalog(key,label,position)
WHERE tenant.slug='newave-ia'
ON CONFLICT (tenant_id,key) DO NOTHING;

-- Tenants novos nascem com o catálogo padrão.
CREATE OR REPLACE FUNCTION seed_default_lead_loss_reasons()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO lead_loss_reasons(tenant_id,key,label,position,requires_note,is_system)
  VALUES
    (NEW.id,'preco','Preço',10,false,true),
    (NEW.id,'sem_interesse','Não tem interesse',20,false,true),
    (NEW.id,'sem_momento','Sem momento',30,false,true),
    (NEW.id,'nao_qualificado','Não qualificado',40,false,true),
    (NEW.id,'concorrente','Escolheu um concorrente',50,false,true),
    (NEW.id,'sem_retorno','Sem retorno',60,false,true),
    (NEW.id,'outro','Outro',900,true,true)
  ON CONFLICT (tenant_id,key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_lead_loss_reasons ON tenants;
CREATE TRIGGER trg_seed_default_lead_loss_reasons
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_default_lead_loss_reasons();

-- Observação livre que acompanha o motivo.
ALTER TABLE scheduling_leads
  ADD COLUMN IF NOT EXISTS loss_reason_note TEXT;
ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS loss_reason_note TEXT;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_loss_reason_note_check,
  ADD CONSTRAINT scheduling_leads_loss_reason_note_check
    CHECK (loss_reason_note IS NULL OR (
      loss_reason IS NOT NULL
      AND btrim(loss_reason_note) <> ''
      AND length(loss_reason_note) <= 500
    ));

ALTER TABLE scheduling_appointments
  DROP CONSTRAINT IF EXISTS scheduling_appointments_loss_reason_note_check,
  ADD CONSTRAINT scheduling_appointments_loss_reason_note_check
    CHECK (loss_reason_note IS NULL OR (
      loss_reason IS NOT NULL
      AND btrim(loss_reason_note) <> ''
      AND length(loss_reason_note) <= 500
    ));

-- Troca o CHECK fixo pela FK no catálogo do tenant.
ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_loss_reason_check;
ALTER TABLE scheduling_appointments
  DROP CONSTRAINT IF EXISTS scheduling_appointments_loss_reason_check;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_loss_reason_fkey,
  ADD CONSTRAINT scheduling_leads_loss_reason_fkey
    FOREIGN KEY (tenant_id,loss_reason)
    REFERENCES lead_loss_reasons(tenant_id,key) ON UPDATE CASCADE;

ALTER TABLE scheduling_appointments
  DROP CONSTRAINT IF EXISTS scheduling_appointments_loss_reason_fkey,
  ADD CONSTRAINT scheduling_appointments_loss_reason_fkey
    FOREIGN KEY (tenant_id,loss_reason)
    REFERENCES lead_loss_reasons(tenant_id,key) ON UPDATE CASCADE;

INSERT INTO permissions(key,module,action,description)
VALUES ('loss_reasons.manage','organization','loss_reasons_manage','Administrar o catálogo de motivos de perda')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,'loss_reasons.manage'
FROM workspace_roles role
WHERE role.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;

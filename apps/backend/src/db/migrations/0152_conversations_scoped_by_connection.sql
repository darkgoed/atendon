-- A conversa passa a pertencer a uma conexão. Antes desta migration o par
-- (tenant, telefone) era único, então (tenant, sessão, telefone) já é único por
-- construção: a troca de índice não pode falhar por dados existentes.
-- Conversas órfãs (session_id NULL, possíveis em bases antigas) são adotadas
-- pela conexão primária do tenant.
UPDATE conversations conversation
SET session_id = primary_session.id
FROM whatsapp_sessions primary_session
WHERE conversation.session_id IS NULL
  AND primary_session.tenant_id = conversation.tenant_id
  AND primary_session.is_primary
  AND primary_session.archived_at IS NULL;

-- Tenants sem nenhuma conexão (base inconsistente): cria uma para não perder
-- histórico. Sem instance_name explícito, o DEFAULT de 0005 gera um único.
WITH orphan_tenants AS (
  SELECT DISTINCT tenant_id FROM conversations WHERE session_id IS NULL
), created AS (
  INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status)
  SELECT tenant_id,'Principal',true,'disconnected' FROM orphan_tenants
  RETURNING id, tenant_id
)
UPDATE conversations conversation
SET session_id = created.id
FROM created
WHERE conversation.session_id IS NULL
  AND created.tenant_id = conversation.tenant_id;

ALTER TABLE conversations ALTER COLUMN session_id SET NOT NULL;

-- Integridade cruzada: a conexão da conversa tem de ser do mesmo tenant.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_session_tenant_fk;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_session_tenant_fk
  FOREIGN KEY (session_id, tenant_id) REFERENCES whatsapp_sessions(id, tenant_id);

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_id_contact_phone_key;
DROP INDEX IF EXISTS uq_conversations_phone_e164;
CREATE UNIQUE INDEX uq_conversations_session_phone
  ON conversations(tenant_id, session_id, contact_phone);
-- Busca por telefone dentro do tenant continua barata (painel, agenda, leads).
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_phone
  ON conversations(tenant_id, contact_phone);

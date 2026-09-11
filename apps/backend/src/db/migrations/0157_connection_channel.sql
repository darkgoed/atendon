-- Modela o canal na conexão. Instagram fica schema-ready nesta fase,
-- mas sua integração/ingestão permanece deliberadamente indisponível.
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

-- Instalações que já possuam a coluna podem ter linhas antigas nulas antes
-- desta migration; o valor legado correto é WhatsApp.
UPDATE whatsapp_sessions
SET channel = 'whatsapp'
WHERE channel IS NULL;

ALTER TABLE whatsapp_sessions
  ALTER COLUMN channel SET DEFAULT 'whatsapp',
  ALTER COLUMN channel SET NOT NULL;

-- DROP + ADD torna a definição determinística também quando uma instalação
-- existente tiver uma constraint homônima com expressão antiga.
ALTER TABLE whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_channel_check;
ALTER TABLE whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_channel_check
  CHECK (channel IN ('whatsapp', 'instagram'));

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_tenant_channel_active
  ON whatsapp_sessions(tenant_id, channel)
  WHERE archived_at IS NULL;

-- Rollback manual (não executar automaticamente):
-- DROP INDEX IF EXISTS idx_whatsapp_sessions_tenant_channel_active;
-- ALTER TABLE whatsapp_sessions DROP CONSTRAINT IF EXISTS whatsapp_sessions_channel_check;
-- ALTER TABLE whatsapp_sessions DROP COLUMN IF EXISTS channel;

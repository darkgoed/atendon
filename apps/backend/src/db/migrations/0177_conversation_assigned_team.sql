-- B6 Times (specs/active/v7-port-crm-whatsapp.md, ONDA 2): conversa atribuída a
-- uma equipe (assigned_team_id). O responsável individual (assigned_user_id)
-- continua existindo — a equipe é a camada organizacional acima do operador.
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_assigned_team_tenant_fkey;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS assigned_team_id;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_team_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_assigned_team_tenant_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_assigned_team_tenant_fkey
      FOREIGN KEY (assigned_team_id, tenant_id)
      REFERENCES teams(id, tenant_id)
      -- Coluna-lista (PG 15+): só o vínculo da equipe é limpo; tenant_id da
      -- conversa fica intacto quando a equipe é excluída.
      ON DELETE SET NULL (assigned_team_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_team
  ON conversations(tenant_id, assigned_team_id);

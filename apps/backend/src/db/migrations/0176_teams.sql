-- B6 Times (specs/active/v7-port-crm-whatsapp.md, ONDA 2): estrutura mínima de
-- equipes por workspace e vínculo opcional do membro com a sua equipe.
-- Aditiva e idempotente. 0176 já estava ocupado por 0176_export_keyset_index.sql
-- (R15); o ledger do runner é por filename, então ambos coexistem em ordem
-- lexical ("e" < "t") sem conflito de checksum.
-- ROLLBACK (manual, não executar automaticamente):
-- ALTER TABLE workspace_members DROP COLUMN IF EXISTS team_id;
-- DROP TABLE IF EXISTS teams;

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teams_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_tenant_name
  ON teams(tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_teams_tenant
  ON teams(tenant_id, created_at, id);

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS team_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_members_team_tenant_fkey'
      AND conrelid = 'workspace_members'::regclass
  ) THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_team_tenant_fkey
      FOREIGN KEY (team_id, workspace_id)
      REFERENCES teams(id, tenant_id)
      ON DELETE SET NULL (team_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_members_team
  ON workspace_members(workspace_id, team_id);

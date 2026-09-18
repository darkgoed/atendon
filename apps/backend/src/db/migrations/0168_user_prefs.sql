-- Preferências individuais de som (R1/R16) e aparência por usuário (R16) —
-- specs/active/v6-evolucao-estrutural-atendon.md, Contratos de API (W1).
-- sound_key: nome do som selecionável no painel (string livre curta; NULL =
-- padrão do painel). volume: 0-100 (NULL = padrão do painel). user_appearance_prefs:
-- tema/accent/densidade por usuário; nunca altera config global.
-- Aditiva e idempotente.
-- ROLLBACK: DROP TABLE user_appearance_prefs;
--   ALTER TABLE panel_notification_preferences
--     DROP COLUMN volume, DROP COLUMN sound_key;

ALTER TABLE panel_notification_preferences
  ADD COLUMN IF NOT EXISTS sound_key TEXT,
  ADD COLUMN IF NOT EXISTS volume SMALLINT;

ALTER TABLE panel_notification_preferences
  DROP CONSTRAINT IF EXISTS panel_notification_preferences_volume_range;
ALTER TABLE panel_notification_preferences
  ADD CONSTRAINT panel_notification_preferences_volume_range
  CHECK (volume BETWEEN 0 AND 100);

COMMENT ON COLUMN panel_notification_preferences.sound_key IS
  'Nome do som de notificação escolhido pelo usuário; NULL = padrão do painel';
COMMENT ON COLUMN panel_notification_preferences.volume IS
  'Volume de reprodução (0-100); NULL = padrão do painel';

CREATE TABLE IF NOT EXISTS user_appearance_prefs (
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  theme TEXT CHECK (theme IN ('light','dark')),
  accent TEXT,
  density TEXT CHECK (density IN ('comfortable','compact')),
  extra JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id),
  CONSTRAINT user_appearance_prefs_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT user_appearance_prefs_user_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

COMMENT ON TABLE user_appearance_prefs IS
  'Preferências de aparência por usuário (tema, accent, densidade); extra guarda ajustes ad-hoc';
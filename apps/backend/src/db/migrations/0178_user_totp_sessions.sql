-- B2 Security (b) (specs/active/v7-port-crm-whatsapp.md, ONDA 2): 2FA TOTP por
-- usuário + sessões ativas revogáveis. O segredo TOTP é gravado cifrado
-- (secret-box v2, AES-256-GCM com DATA_ENCRYPTION_KEY); totp_enabled_at marca
-- a ativação real (setup sozinho NÃO ativa). workspace_sessions registra cada
-- sessão emitida (JTI do cookie JWT) para lista/revogação individual;
-- kind='totp_challenge' cobre o 2º passo do login. Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS workspace_sessions;
-- ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled_at;
-- ALTER TABLE users DROP COLUMN IF EXISTS totp_secret_encrypted;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workspace_sessions (
  -- id = JTI do JWT do cookie de sessão; a revogação é verificada em
  -- requireIdentity (auth/session.ts) para tokens que carregam sid.
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'totp_challenge')),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT workspace_sessions_expiry_check CHECK (expires_at > created_at - interval '1 second')
);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_user_active
  ON workspace_sessions(user_id, kind, created_at DESC)
  WHERE revoked_at IS NULL;

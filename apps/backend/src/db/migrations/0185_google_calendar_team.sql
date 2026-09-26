-- 0185: Google Calendar por atendente (specs/active/google-calendar-team-sync.md).
-- Conexões OAuth por membro, rotas pipeline→equipe/conexão, vínculos de eventos,
-- outbox de sincronização e nonce OAuth one-time. Aditiva e idempotente.
-- Não altera as credenciais nem o comportamento do Google Meet
-- (scheduling_google_meet_settings fica intocado).
-- ROLLBACK (manual; perde conexões/rotas/vínculos/outbox/nonces):
--   DROP TABLE IF EXISTS scheduling_calendar_sync_outbox,
--     scheduling_appointment_calendar_events, scheduling_pipeline_calendar_routes,
--     scheduling_calendar_oauth_states, scheduling_calendar_connections CASCADE;
--   ALTER TABLE scheduling_appointments DROP CONSTRAINT IF EXISTS scheduling_appointments_id_tenant_unique;
--   ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_id_workspace_unique;

-- FKs compostas abaixo exigem (id, tenant_id) únicos nessas tabelas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_appointments_id_tenant_unique'
      AND conrelid = 'scheduling_appointments'::regclass
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_members_id_workspace_unique'
      AND conrelid = 'workspace_members'::regclass
  ) THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
END $$;

-- Conexão OAuth de um atendente com a conta Google dele. Refresh token cifrado
-- (AES-GCM via DATA_ENCRYPTION_KEY, mesmo esquema do Meet) — nunca em JSON/log.
-- calendar_id NULL = conta conectada sem agenda selecionada (sem sincronização).
CREATE TABLE IF NOT EXISTS scheduling_calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  google_email TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  calendar_id TEXT,
  calendar_name TEXT,
  calendar_timezone TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_calendar_connections_tenant_member_unique UNIQUE (tenant_id, member_id),
  CONSTRAINT scheduling_calendar_connections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT scheduling_calendar_connections_member_fkey FOREIGN KEY (member_id, tenant_id)
    REFERENCES workspace_members(id, workspace_id) ON DELETE CASCADE
);

-- Sobrescrita de destino por pipeline: sem rota → assignee do AtendON (e conexão
-- dele, se houver); equipe → um dos seus membros; conexão fixa → dono da conexão.
-- Exatamente um destino não nulo.
CREATE TABLE IF NOT EXISTS scheduling_pipeline_calendar_routes (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id UUID NOT NULL,
  team_id UUID,
  connection_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pipeline_id),
  CONSTRAINT scheduling_pipeline_calendar_routes_pipeline_fkey FOREIGN KEY (pipeline_id, tenant_id)
    REFERENCES pipelines(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_pipeline_calendar_routes_team_fkey FOREIGN KEY (team_id, tenant_id)
    REFERENCES teams(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_pipeline_calendar_routes_connection_fkey FOREIGN KEY (connection_id, tenant_id)
    REFERENCES scheduling_calendar_connections(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_pipeline_calendar_routes_target_check CHECK (
    (team_id IS NULL)::int + (connection_id IS NULL)::int = 1
  )
);

-- Vínculo evento do Google ↔ agendamento. Guarda a associação sem assumir
-- ownership de evento externo arbitrário. Ao desconectar (ou remover conexão),
-- o vínculo vira órfão (connection_id NULL) e o agendamento é preservado.
CREATE TABLE IF NOT EXISTS scheduling_appointment_calendar_events (
  appointment_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  etag TEXT,
  last_synced_at TIMESTAMPTZ,
  sync_error TEXT,
  CONSTRAINT scheduling_appointment_calendar_events_appointment_fkey FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_appointment_calendar_events_connection_fkey FOREIGN KEY (connection_id, tenant_id)
    REFERENCES scheduling_calendar_connections(id, tenant_id) ON DELETE SET NULL (connection_id),
  CONSTRAINT scheduling_appointment_calendar_events_target_unique UNIQUE (connection_id, calendar_id, event_id)
);

-- Outbox para o worker drenar (upsert/delete remoto) com retry/backoff.
-- Escrito na MESMA transação do agendamento; cancelamento não apaga o vínculo
-- até a exclusão remota ser confirmada.
CREATE TABLE IF NOT EXISTS scheduling_calendar_sync_outbox (
  appointment_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  claimed_at TIMESTAMPTZ,
  PRIMARY KEY (appointment_id, tenant_id),
  CONSTRAINT scheduling_calendar_sync_outbox_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT scheduling_calendar_sync_outbox_appointment_fkey FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_outbox_pending
  ON scheduling_calendar_sync_outbox (available_at, appointment_id) WHERE claimed_at IS NULL;

-- Anti-CSRF OAuth: nonce one-time persistido; o callback consome atomicamente
-- (UPDATE ... WHERE used_at IS NULL AND expires_at > now()), mesmo após erro.
CREATE TABLE IF NOT EXISTS scheduling_calendar_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduling_calendar_oauth_states_nonce
  ON scheduling_calendar_oauth_states (nonce);
CREATE INDEX IF NOT EXISTS idx_scheduling_calendar_oauth_states_expiry
  ON scheduling_calendar_oauth_states (expires_at);

COMMENT ON TABLE scheduling_calendar_connections IS
  'Google Calendar OAuth por atendente (0185); refresh token cifrado. Distinto das credenciais legadas do Google Meet.';

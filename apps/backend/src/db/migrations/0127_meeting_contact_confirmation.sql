-- Estado durável da confirmação do contato, sem alterar dados existentes.
ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS contact_confirmation_state TEXT NOT NULL DEFAULT 'nao_solicitada',
  ADD COLUMN IF NOT EXISTS contact_confirmation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_confirmation_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_appointments_contact_confirmation_state_check'
  ) THEN
    ALTER TABLE scheduling_appointments
      ADD CONSTRAINT scheduling_appointments_contact_confirmation_state_check
      CHECK (contact_confirmation_state IN ('nao_solicitada','solicitada','confirmada','sem_resposta'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS scheduling_meeting_confirmation_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  appointment_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  session_id UUID NOT NULL,
  contact_phone TEXT NOT NULL CHECK (char_length(contact_phone) BETWEEN 8 AND 64),
  contact_jid TEXT,
  moment TEXT NOT NULL CHECK (moment IN ('pos_agendamento','duas_horas_antes','quinze_minutos_antes')),
  message_text TEXT NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','suppressed','failed','uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_meeting_confirmation_appointment_tenant_fkey
    FOREIGN KEY (appointment_id, tenant_id) REFERENCES scheduling_appointments(id, tenant_id),
  CONSTRAINT scheduling_meeting_confirmation_conversation_tenant_fkey
    FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  CONSTRAINT scheduling_meeting_confirmation_session_tenant_fkey
    FOREIGN KEY (session_id, tenant_id) REFERENCES whatsapp_sessions(id, tenant_id),
  CONSTRAINT scheduling_meeting_confirmation_unique UNIQUE (tenant_id, appointment_id, moment)
);

CREATE INDEX IF NOT EXISTS idx_scheduling_meeting_confirmation_due
  ON scheduling_meeting_confirmation_outbox(status, available_at, created_at, id)
  WHERE status IN ('pending','processing');

-- display_name é NOT NULL sem default nesta tabela; omiti-lo quebra o INSERT.
-- global_enabled fica NULL de propósito: essa é a convenção do repositório para
-- uma flag ainda NÃO lançada (o catálogo distingue "não lançada" = NULL de uma
-- decisão global explícita). Com default_enabled sempre false, NULL significa
-- DESLIGADA, que é o exigido aqui: nenhuma mensagem automática pode sair para
-- lead real antes de alguém ligar esta flag conscientemente.
INSERT INTO feature_flag_definitions(flag_key, display_name, description, global_enabled)
VALUES (
  'scheduling_meeting_confirmation_v1',
  'Confirmação de reunião pelo contato',
  'Confirmação automática de reuniões pelo contato para reduzir no-show',
  NULL
)
ON CONFLICT (flag_key) DO NOTHING;

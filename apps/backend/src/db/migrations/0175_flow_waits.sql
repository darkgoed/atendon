-- R22 (specs/active/v6-evolucao-estrutural-atendon.md): estado de espera dos fluxos
-- determinísticos (delay / wait_for_reply). A retomada é agendada no BullMQ e
-- revalidada ao acordar (lição do legado); wait_session_id guarda a sessão onde a
-- espera começou para a retomada proativa saber por onde enviar. Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- ALTER TABLE lead_qualifications DROP COLUMN IF EXISTS wait_session_id;
-- ALTER TABLE lead_qualifications DROP COLUMN IF EXISTS wait_until;
-- ALTER TABLE qualification_message_outbox DROP CONSTRAINT IF EXISTS qualification_message_outbox_message_kind_check;
-- ALTER TABLE qualification_message_outbox ADD CONSTRAINT qualification_message_outbox_message_kind_check CHECK (message_kind IN ('question','clarification','confirmation','final'));

ALTER TABLE lead_qualifications ADD COLUMN IF NOT EXISTS wait_until TIMESTAMPTZ;
ALTER TABLE lead_qualifications ADD COLUMN IF NOT EXISTS wait_session_id UUID;

-- Fila de retomada do reconciliador do worker (esperas vencidas).
CREATE INDEX IF NOT EXISTS idx_lead_qualifications_due_waits
  ON lead_qualifications(wait_until)
  WHERE status='em_andamento' AND wait_until IS NOT NULL;

-- Mensagens proativas de retomada (sem inbound) entram como kind 'message'.
ALTER TABLE qualification_message_outbox
  DROP CONSTRAINT IF EXISTS qualification_message_outbox_message_kind_check;
ALTER TABLE qualification_message_outbox
  ADD CONSTRAINT qualification_message_outbox_message_kind_check
  CHECK (message_kind IN ('question','clarification','confirmation','final','message'));

-- 0189: gatilho de enfileiramento do outbox do Google Calendar (0185).
-- Toda escrita em scheduling_appointments que afeta o evento remoto enfileira
-- na MESMA transação da mutação: INSERT/UPDATE OF start_at,end_at,status,
-- assigned_member_id,meeting_url,observation (a observação entra na descrição
-- do evento remoto — buildWork —, logo também precisa re-enfileirar).
-- Cancelamento vira kind='delete'; o vínculo
-- só é apagado depois da exclusão remota confirmada (decisão do worker, não daqui).
-- Aditiva e idempotente; não altera credenciais nem o comportamento do Google Meet.
-- ROLLBACK (manual):
--   DROP TRIGGER IF EXISTS scheduling_calendar_sync_enqueuer ON scheduling_appointments;
--   DROP FUNCTION IF EXISTS scheduling_calendar_sync_enqueue();

CREATE OR REPLACE FUNCTION scheduling_calendar_sync_enqueue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  -- Estados encerrados não têm mais evento ativo a sincronizar: o histórico
  -- permanece no Google como está. Reabrir (voltar a confirmado/reagendado)
  -- volta a enfileirar por estar no UPDATE OF status.
  IF NEW.status = 'concluido' OR NEW.status = 'no_show' THEN
    RETURN NEW;
  END IF;
  v_kind := CASE WHEN NEW.status = 'cancelado' THEN 'delete' ELSE 'upsert' END;
  INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind,available_at,attempts,last_error,claimed_at)
  VALUES (NEW.id,NEW.tenant_id,v_kind,now(),0,NULL,NULL)
  -- Uma mutação durante uma sincronização em voo NÃO limpa claimed_at: a
  -- tentativa atual termina e, ao concluir, compara o snapshot do
  -- agendamento; mudou → libera a linha para outra passada. Sem isso a
  -- mutação seria perdida quando a tentativa em voo apagasse a linha.
  ON CONFLICT (appointment_id,tenant_id) DO UPDATE
    SET kind=EXCLUDED.kind,
        available_at=now(),
        attempts=0,
        last_error=NULL;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS scheduling_calendar_sync_enqueuer ON scheduling_appointments;
CREATE TRIGGER scheduling_calendar_sync_enqueuer
AFTER INSERT OR UPDATE OF start_at,end_at,status,assigned_member_id,meeting_url,observation
ON scheduling_appointments
FOR EACH ROW EXECUTE FUNCTION scheduling_calendar_sync_enqueue();

COMMENT ON FUNCTION scheduling_calendar_sync_enqueue IS
  'Enfileira upsert/delete no scheduling_calendar_sync_outbox na mesma transação da mutação do agendamento (0189).';

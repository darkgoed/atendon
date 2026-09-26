-- 0186: reserva de agendamento com checagem de disponibilidade do Google Calendar
-- (specs/active/google-calendar-team-sync.md). 0185 já aplicado; coluna nova aqui.
-- buffer_minutes: folga ao redor do intervalo solicitado na consulta freeBusy
-- da agenda selecionada (0-240 minutos, 0 = desligado).
-- ROLLBACK (manual; perde buffers configurados):
--   ALTER TABLE scheduling_calendar_connections DROP COLUMN IF EXISTS buffer_minutes;

ALTER TABLE scheduling_calendar_connections
  ADD COLUMN IF NOT EXISTS buffer_minutes INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_calendar_connections_buffer_minutes_check'
      AND conrelid = 'scheduling_calendar_connections'::regclass
  ) THEN
    ALTER TABLE scheduling_calendar_connections
      ADD CONSTRAINT scheduling_calendar_connections_buffer_minutes_check
      CHECK (buffer_minutes BETWEEN 0 AND 240);
  END IF;
END $$;

COMMENT ON COLUMN scheduling_calendar_connections.buffer_minutes IS
  'Folga (minutos) aplicada ao redor do intervalo na checagem de disponibilidade do Google (0186).';

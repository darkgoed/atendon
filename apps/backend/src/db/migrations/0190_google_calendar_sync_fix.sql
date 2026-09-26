-- 0190: token de posse do claim no outbox do Calendar sync (0185/0189).
-- Sem posse, um worker com lease vencido concluía por cima do claim de outro
-- (lost update: vínculo regravado / linha drenada duas vezes). O token é
-- gerado no claim (gen_random_uuid) e conferido em complete/recordFailure;
-- NULL = linha não reclamada ou claim legado.
-- Aditivo e idempotente. ROLLBACK (manual):
--   ALTER TABLE scheduling_calendar_sync_outbox DROP COLUMN IF EXISTS claim_token;
ALTER TABLE scheduling_calendar_sync_outbox
  ADD COLUMN IF NOT EXISTS claim_token uuid;

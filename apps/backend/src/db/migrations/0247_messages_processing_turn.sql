-- Dono da lease de processamento de uma mensagem inbound (auditoria MSG C5).
-- O retry do MESMO turno (aiTurnId estável entre tentativas do job BullMQ)
-- retoma a lease recente depois de um crash do worker; outro turno continua
-- barrado até a lease de 10 minutos vencer. Coluna anulável, sem default:
-- ALTER apenas de catálogo. ROLLBACK (manual):
-- ALTER TABLE messages DROP COLUMN IF EXISTS processing_turn_id;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS processing_turn_id TEXT;

-- Última mudança de cada mensagem (auditoria MSG C10 / painel C3). O delta v2
-- do painel pagina por (created_at,id), então não via bolhas da IA gravadas
-- depois com created_at do envio, nem ticks, transcrições, reações e edições
-- de linhas já carregadas. updated_at alimenta o campo `changes` do delta.
-- DEFAULT now() é estável: ALTER só de catálogo, sem reescrever a tabela.
-- Sem índice novo: a consulta é por conversa (índice de conversation_id).
-- ROLLBACK (manual): DROP TRIGGER IF EXISTS messages_touch_updated_at ON messages;
-- DROP FUNCTION IF EXISTS messages_touch_updated_at();
-- ALTER TABLE messages DROP COLUMN IF EXISTS updated_at;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION messages_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_touch_updated_at ON messages;
CREATE TRIGGER messages_touch_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION messages_touch_updated_at();

-- F4-r1 (WP-B — specs/active/flow-integrity-20260921.md rev.3 + decisões B1/B5):
-- token de concorrência CAS para qualification_flows. `revision` nasce em 1
-- (DEFAULT) e o trigger BEFORE UPDATE incrementa em QUALQUER mudança de linha
-- (nome, ativo, definition, allowed_role_ids, touch) — SET manual é sobrescrito.
-- O CAS nunca deriva de snapshot; flow_versions preserva o histórico à parte.
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TRIGGER IF EXISTS trg_qualification_flows_revision ON qualification_flows;
-- DROP FUNCTION IF EXISTS qualification_flows_bump_revision();
-- ALTER TABLE qualification_flows DROP COLUMN IF EXISTS revision;

ALTER TABLE qualification_flows ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION qualification_flows_bump_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Sempre OLD+1: qualquer UPDATE incrementa, inclusive SET revision=<manual>
  -- (o valor atribuído a NEW.revision é sobrescrito aqui).
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_qualification_flows_revision ON qualification_flows;
CREATE TRIGGER trg_qualification_flows_revision
  BEFORE UPDATE ON qualification_flows
  FOR EACH ROW EXECUTE FUNCTION qualification_flows_bump_revision();

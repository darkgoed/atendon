-- Central de notificações internas por usuário (R2) e notas internas com
-- @menções (R3) — specs/active/v6-evolucao-estrutural-atendon.md, Contratos de
-- API (W1).
--
-- internal_notifications: eventos direcionados a UM usuário (menção, nota
-- direcionada, tarefa atribuída, transferência, mensagem interna, alteração
-- interna). Feed user-scoped SEM gate de gestão — complementa o system_alerts
-- existente (0015/0036), que é agregado por empresa e restrito a gestores;
-- esse sistema segue onde está e NÃO é substituído aqui.
--
-- Notas de lead: a tabela existente scheduling_lead_notes (0034) é saudável
-- (tenant-scoped, FK composta para o lead com CASCADE, índice de timeline) e
-- foi investigada antes de criar este arquivo: ela é EXTENDIDA com a coluna
-- mentions e a leitura fica unificada nela mesma — a rota nova de notas de
-- lead lê/escreve a MESMA tabela que a rota atual, sem tabela paralela órfã e
-- sem migrate destrutivo. Notas de conversa (novo contexto) usam
-- internal_notes com context_type='conversation'; a linha 'lead' do CHECK fica
-- reservada para uma futura consolidação (a timeline do lead continuará lendo
-- scheduling_lead_notes, que segue sendo a fonte de verdade para leads).
--
-- Aditiva e idempotente.
-- ROLLBACK: ALTER TABLE scheduling_lead_notes DROP COLUMN mentions;
--   DROP TABLE internal_notes;
--   DROP TABLE internal_notifications;

CREATE TABLE IF NOT EXISTS internal_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN
    ('mention','task_assigned','note_directed','transfer','internal_message','internal_change')),
  title TEXT NOT NULL,
  body TEXT,
  source_type TEXT,
  source_id UUID,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT internal_notifications_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Sino: contador de não lidas por usuário (parcial) + keyset do feed.
CREATE INDEX IF NOT EXISTS internal_notifications_unread_idx
  ON internal_notifications(tenant_id,user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS internal_notifications_feed_idx
  ON internal_notifications(tenant_id,user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  context_type TEXT NOT NULL CHECK (context_type IN ('lead','conversation')),
  context_id UUID NOT NULL,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 4000),
  mentions UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT internal_notes_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Mesmo índice pedido pela spec; created_at ASC (mais antiga primeiro) é a
-- ordem natural de leitura de thread de notas.
CREATE INDEX IF NOT EXISTS internal_notes_context_idx
  ON internal_notes(tenant_id,context_type,context_id,created_at);
CREATE INDEX IF NOT EXISTS internal_notes_mentions_gin
  ON internal_notes USING gin(mentions);

-- Notas de lead existentes permanecem em scheduling_lead_notes (0034); apenas
-- ganham a lista de usuários mencionados (validação pertence à aplicação, que
-- garante membros ativos do mesmo tenant antes de gravar).
ALTER TABLE scheduling_lead_notes
  ADD COLUMN IF NOT EXISTS mentions UUID[];

COMMENT ON COLUMN internal_notifications.type IS
  'Tipo do evento direcionado: mention, task_assigned, note_directed, transfer, internal_message ou internal_change';
COMMENT ON COLUMN internal_notes.context_type IS
  'Contexto da nota: conversation (escrito em v1) ou lead (reservado; notas de lead permanecem em scheduling_lead_notes)';
COMMENT ON COLUMN scheduling_lead_notes.mentions IS
  'Usuários mencionados com @ na nota (uuid[]); cada um gera internal_notifications tipo mention';
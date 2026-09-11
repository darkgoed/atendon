-- Atendimento por filas, aditivo e idempotente.
-- Rollback manual (não executar automaticamente):
-- ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_queue_tenant_fkey;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS queue_id;
-- DROP TRIGGER IF EXISTS tenants_seed_conversation_queues ON tenants;
-- DROP TRIGGER IF EXISTS conversations_sync_queue_status ON conversations;
-- DROP FUNCTION IF EXISTS seed_conversation_queues_for_tenant();
-- DROP FUNCTION IF EXISTS sync_conversation_queue_status();
-- DROP TABLE IF EXISTS conversation_queues;

CREATE TABLE IF NOT EXISTS conversation_queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  color TEXT NOT NULL DEFAULT '#64748B' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  position INTEGER NOT NULL CHECK (position >= 0),
  is_initial BOOLEAN NOT NULL DEFAULT false,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_queues_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT conversation_queues_role_exclusive CHECK (NOT (is_initial AND is_resolved))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_queues_active_name
  ON conversation_queues(tenant_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_queues_initial
  ON conversation_queues(tenant_id) WHERE is_initial AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_queues_resolved
  ON conversation_queues(tenant_id) WHERE is_resolved AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_queues_order
  ON conversation_queues(tenant_id, archived_at, position, id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS queue_id UUID;
-- Reconcile the constraint even when 0154 was already applied by an older
-- snapshot.  The column-list form is important: tenant_id must never be nulled.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_queue_tenant_fkey;
ALTER TABLE conversations ADD CONSTRAINT conversations_queue_tenant_fkey
  FOREIGN KEY (queue_id, tenant_id) REFERENCES conversation_queues(id, tenant_id)
  ON DELETE SET NULL (queue_id);
CREATE INDEX IF NOT EXISTS idx_conversations_queue
  ON conversations(tenant_id, queue_id, last_message_at DESC);

-- Seed is guarded by NOT EXISTS because the partial name index does not make
-- archived historical rows conflict with the canonical defaults.
INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
SELECT t.id,'Novo contato','#3B82F6',10,true,false FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM conversation_queues q WHERE q.tenant_id=t.id AND q.is_initial AND q.archived_at IS NULL);
INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
SELECT t.id,'Agendado','#8B5CF6',20,false,false FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM conversation_queues q WHERE q.tenant_id=t.id AND lower(q.name)=lower('Agendado') AND q.archived_at IS NULL);
INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
SELECT t.id,'Resolvido','#10B981',30,false,true FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM conversation_queues q WHERE q.tenant_id=t.id AND q.is_resolved AND q.archived_at IS NULL);
UPDATE conversations c SET queue_id=q.id
FROM conversation_queues q
WHERE q.tenant_id=c.tenant_id AND q.archived_at IS NULL AND c.queue_id IS NULL
  AND ((c.status='closed' AND q.is_resolved) OR (c.status<>'closed' AND q.is_initial));

CREATE OR REPLACE FUNCTION seed_conversation_queues_for_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
  SELECT NEW.id,'Novo contato','#3B82F6',10,true,false
  WHERE NOT EXISTS (SELECT 1 FROM conversation_queues WHERE tenant_id=NEW.id AND is_initial AND archived_at IS NULL);
  INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
  SELECT NEW.id,'Agendado','#8B5CF6',20,false,false
  WHERE NOT EXISTS (SELECT 1 FROM conversation_queues WHERE tenant_id=NEW.id AND lower(name)=lower('Agendado') AND archived_at IS NULL);
  INSERT INTO conversation_queues(tenant_id,name,color,position,is_initial,is_resolved)
  SELECT NEW.id,'Resolvido','#10B981',30,false,true
  WHERE NOT EXISTS (SELECT 1 FROM conversation_queues WHERE tenant_id=NEW.id AND is_resolved AND archived_at IS NULL);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS tenants_seed_conversation_queues ON tenants;
CREATE TRIGGER tenants_seed_conversation_queues AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION seed_conversation_queues_for_tenant();

-- Additive synchronization covers legacy resolve/reopen and sibling paths.
-- It only changes queue when status/queue actually expresses a transition;
-- reactivating an already-open conversation therefore preserves its queue.
CREATE OR REPLACE FUNCTION sync_conversation_queue_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.queue_id IS DISTINCT FROM OLD.queue_id THEN
    IF EXISTS (SELECT 1 FROM conversation_queues WHERE id=NEW.queue_id AND tenant_id=NEW.tenant_id AND is_resolved AND archived_at IS NULL) THEN
      NEW.status := 'closed'; NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    ELSE
      NEW.status := 'open'; NEW.resolved_at := NULL;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status='closed' THEN
      SELECT q.id INTO NEW.queue_id FROM conversation_queues q
       WHERE q.tenant_id=NEW.tenant_id AND q.is_resolved AND q.archived_at IS NULL LIMIT 1;
      NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    ELSE
      SELECT q.id INTO NEW.queue_id FROM conversation_queues q
       WHERE q.tenant_id=NEW.tenant_id AND q.is_initial AND q.archived_at IS NULL LIMIT 1;
      NEW.resolved_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS conversations_sync_queue_status ON conversations;
CREATE TRIGGER conversations_sync_queue_status BEFORE UPDATE OF status, queue_id ON conversations
FOR EACH ROW EXECUTE FUNCTION sync_conversation_queue_status();

INSERT INTO permissions(key,module,action,description) VALUES
 ('conversations.queues.manage','conversations','queues_manage','Criar, renomear, ordenar e arquivar filas de atendimento')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;
INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,'conversations.queues.manage' FROM workspace_roles r
WHERE r.name IN ('OWNER','ADMIN') ON CONFLICT DO NOTHING;

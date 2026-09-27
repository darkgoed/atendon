-- Remove integralmente o sistema de filas de atendimento introduzido em 0154.
-- Preserva o ciclo técnico open/closed (status, resolved_at), os endpoints
-- resolve/reopen e os filtros human/ai/mine/unassigned/scheduled/resolved.
-- Idempotente: toda operação usa IF EXISTS ou é declarativa (DELETE).

DROP TRIGGER IF EXISTS conversations_sync_queue_status ON conversations;
DROP TRIGGER IF EXISTS tenants_seed_conversation_queues ON tenants;
DROP FUNCTION IF EXISTS sync_conversation_queue_status();
DROP FUNCTION IF EXISTS seed_conversation_queues_for_tenant();

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_queue_tenant_fkey;
DROP INDEX IF EXISTS idx_conversations_queue;
ALTER TABLE conversations DROP COLUMN IF EXISTS queue_id;
DROP TABLE IF EXISTS conversation_queues;

DELETE FROM workspace_role_permissions WHERE permission_key='conversations.queues.manage';
DELETE FROM permissions WHERE key='conversations.queues.manage';

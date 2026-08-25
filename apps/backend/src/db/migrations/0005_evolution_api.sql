ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS instance_name TEXT;
ALTER TABLE whatsapp_sessions DROP COLUMN IF EXISTS auth_state;
UPDATE whatsapp_sessions SET instance_name = 'atendon_' || replace(id::text, '-', '') WHERE instance_name IS NULL;
ALTER TABLE whatsapp_sessions ALTER COLUMN instance_name SET NOT NULL;
ALTER TABLE whatsapp_sessions ALTER COLUMN instance_name SET DEFAULT ('atendon_' || replace(gen_random_uuid()::text, '-', ''));
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_sessions_instance_name ON whatsapp_sessions(instance_name);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_key TEXT;
UPDATE messages m SET provider_message_key = c.tenant_id::text || ':' || coalesce(c.session_id::text, 'legacy') || ':' || m.external_message_id
FROM conversations c WHERE c.id=m.conversation_id AND m.external_message_id IS NOT NULL AND m.provider_message_key IS NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_external_message_id_key;
DROP INDEX IF EXISTS idx_messages_provider_message_key;
CREATE UNIQUE INDEX idx_messages_provider_message_key ON messages(provider_message_key);

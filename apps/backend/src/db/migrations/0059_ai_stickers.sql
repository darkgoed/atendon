CREATE TABLE IF NOT EXISTS ai_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  mime_type TEXT NOT NULL DEFAULT 'image/webp',
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  content_hash TEXT NOT NULL,
  media_data BYTEA NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('panel_upload','whatsapp_sent')),
  source_session_id UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL,
  source_external_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_ai_stickers_tenant_enabled
  ON ai_stickers(tenant_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_sticker_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sticker_id UUID NOT NULL REFERENCES ai_stickers(id) ON DELETE CASCADE,
  external_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_sticker_sends_conversation
  ON ai_sticker_sends(conversation_id, created_at DESC);

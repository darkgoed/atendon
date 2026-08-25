ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS ai_follow_up_delivery JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS ai_follow_up_media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
  content_hash TEXT NOT NULL,
  media_data BYTEA NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_hash),
  UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_follow_up_media_assets_tenant
  ON ai_follow_up_media_assets(tenant_id, updated_at DESC);

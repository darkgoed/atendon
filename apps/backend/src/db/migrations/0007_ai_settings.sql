CREATE TABLE IF NOT EXISTS tenant_ai_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  openrouter_api_key_encrypted TEXT,
  media_fallback_audio TEXT NOT NULL,
  media_fallback_image TEXT NOT NULL,
  media_fallback_document TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

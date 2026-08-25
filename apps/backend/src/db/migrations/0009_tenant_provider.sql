ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS openrouter_provider TEXT;

ALTER TABLE tenant_ai_settings
  ADD COLUMN ai_proposals_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_publication_enabled BOOLEAN NOT NULL DEFAULT false;

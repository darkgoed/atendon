CREATE TABLE agent_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_config_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
  version_number INT NOT NULL CHECK (version_number > 0),
  source TEXT NOT NULL CHECK (source IN ('bootstrap','manual','proposal','rollback')),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','retired','rejected')),
  system_prompt TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  model_params JSONB NOT NULL,
  enabled_tools JSONB NOT NULL CHECK (jsonb_typeof(enabled_tools) = 'array'),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_proposal_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE (agent_config_id, version_number),
  UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX idx_agent_config_versions_one_active
  ON agent_config_versions(agent_config_id)
  WHERE status = 'active';

CREATE INDEX idx_agent_config_versions_tenant_created
  ON agent_config_versions(tenant_id, created_at DESC);

ALTER TABLE agent_configs
  ADD COLUMN active_version_id UUID;

INSERT INTO agent_config_versions(
  tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,
  model_params,enabled_tools,created_at,activated_at
)
SELECT
  tenant_id,id,1,'bootstrap','active',system_prompt,ai_model,model_params,
  enabled_tools,updated_at,updated_at
FROM agent_configs;

UPDATE agent_configs a
SET active_version_id = v.id
FROM agent_config_versions v
WHERE v.agent_config_id = a.id AND v.status = 'active';

ALTER TABLE agent_configs
  ADD CONSTRAINT agent_configs_id_tenant_unique UNIQUE (id, tenant_id),
  ADD CONSTRAINT agent_configs_active_version_fk
    FOREIGN KEY (active_version_id, tenant_id)
    REFERENCES agent_config_versions(id, tenant_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_config_versions
  ADD CONSTRAINT agent_config_versions_agent_tenant_fk
    FOREIGN KEY (agent_config_id, tenant_id)
    REFERENCES agent_configs(id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE messages
  ADD COLUMN agent_config_version_id UUID REFERENCES agent_config_versions(id) ON DELETE SET NULL;

CREATE INDEX idx_messages_agent_config_version
  ON messages(agent_config_version_id)
  WHERE agent_config_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bootstrap_agent_config_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_id UUID;
BEGIN
  IF NEW.active_version_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO agent_config_versions(
    tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,
    model_params,enabled_tools,created_at,activated_at
  ) VALUES (
    NEW.tenant_id,NEW.id,1,'bootstrap','active',NEW.system_prompt,NEW.ai_model,
    NEW.model_params,NEW.enabled_tools,NEW.updated_at,NEW.updated_at
  ) RETURNING id INTO version_id;

  UPDATE agent_configs SET active_version_id=version_id WHERE id=NEW.id;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_configs_bootstrap_version
AFTER INSERT ON agent_configs
FOR EACH ROW EXECUTE FUNCTION bootstrap_agent_config_version();

CREATE OR REPLACE FUNCTION enforce_agent_active_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_version_id IS NULL THEN
    RAISE EXCEPTION 'agent_configs.active_version_id is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_config_versions v
    WHERE v.id=NEW.active_version_id
      AND v.tenant_id=NEW.tenant_id
      AND v.agent_config_id=NEW.id
      AND v.status='active'
  ) THEN
    RAISE EXCEPTION 'agent_configs.active_version_id must reference its active version';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER agent_configs_active_version_required
AFTER INSERT OR UPDATE OF active_version_id,tenant_id ON agent_configs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_agent_active_version();

CREATE OR REPLACE FUNCTION protect_agent_version_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.agent_config_id IS DISTINCT FROM OLD.agent_config_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.ai_model IS DISTINCT FROM OLD.ai_model
     OR NEW.model_params IS DISTINCT FROM OLD.model_params
     OR NEW.enabled_tools IS DISTINCT FROM OLD.enabled_tools
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent config version snapshots are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_config_versions_immutable_snapshot
BEFORE UPDATE ON agent_config_versions
FOR EACH ROW EXECUTE FUNCTION protect_agent_version_snapshot();

CREATE OR REPLACE FUNCTION validate_message_agent_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender <> 'agent' AND NEW.agent_config_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'agent_config_version_id is only valid for agent messages';
  END IF;
  IF NEW.agent_config_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM conversations c
    JOIN agent_config_versions v ON v.tenant_id=c.tenant_id
    WHERE c.id=NEW.conversation_id AND v.id=NEW.agent_config_version_id
  ) THEN
    RAISE EXCEPTION 'message agent version belongs to another tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER messages_validate_agent_version
BEFORE INSERT OR UPDATE OF conversation_id,sender,agent_config_version_id ON messages
FOR EACH ROW EXECUTE FUNCTION validate_message_agent_version();

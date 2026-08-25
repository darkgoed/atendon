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
     OR NEW.source_proposal_id IS DISTINCT FROM OLD.source_proposal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent config version snapshots are immutable';
  END IF;
  RETURN NEW;
END $$;

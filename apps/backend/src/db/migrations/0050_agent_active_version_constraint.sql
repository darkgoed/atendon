CREATE OR REPLACE FUNCTION enforce_agent_active_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_configs a
    JOIN agent_config_versions v
      ON v.id=a.active_version_id
     AND v.tenant_id=a.tenant_id
     AND v.agent_config_id=a.id
     AND v.status='active'
    WHERE a.id=NEW.id
  ) THEN
    RAISE EXCEPTION 'agent_configs.active_version_id must reference its active version';
  END IF;
  RETURN NULL;
END $$;

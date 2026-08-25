INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
SELECT source.tenant_id,source.id,target.id
FROM pipeline_stages source
JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
WHERE source.technical_status='perdido'
  AND target.technical_status='fechado'
  AND source.archived_at IS NULL
  AND target.archived_at IS NULL
ON CONFLICT(tenant_id,from_stage_id,to_stage_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_lost_to_closed_pipeline_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
  SELECT source.tenant_id,source.id,target.id
  FROM pipeline_stages source
  JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
  WHERE source.tenant_id=NEW.tenant_id
    AND source.technical_status='perdido'
    AND target.technical_status='fechado'
    AND source.archived_at IS NULL
    AND target.archived_at IS NULL
  ON CONFLICT(tenant_id,from_stage_id,to_stage_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stages_ensure_lost_to_closed_transition
AFTER INSERT OR UPDATE OF technical_status,archived_at ON pipeline_stages
FOR EACH ROW EXECUTE FUNCTION ensure_lost_to_closed_pipeline_transition();

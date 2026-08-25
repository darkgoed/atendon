CREATE OR REPLACE FUNCTION prune_deleted_ai_evaluation_evidence()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_improvement_proposals
  SET evidence_evaluation_ids=evidence_evaluation_ids-OLD.id::text,
      updated_at=now()
  WHERE tenant_id=OLD.tenant_id
    AND evidence_evaluation_ids @> jsonb_build_array(OLD.id::text);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_evaluation_evidence_cleanup
AFTER DELETE ON ai_attendance_evaluations
FOR EACH ROW EXECUTE FUNCTION prune_deleted_ai_evaluation_evidence();

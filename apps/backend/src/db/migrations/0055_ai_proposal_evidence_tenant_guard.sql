CREATE OR REPLACE FUNCTION validate_ai_proposal_evidence_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.evidence_evaluation_ids) AS evidence(value)
    WHERE evidence.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR NOT EXISTS (
        SELECT 1 FROM ai_attendance_evaluations evaluation
        WHERE evaluation.id::text=evidence.value AND evaluation.tenant_id=NEW.tenant_id
      )
  ) THEN
    RAISE EXCEPTION 'proposal evidence belongs to another tenant or is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_proposal_evidence_tenant_guard
BEFORE INSERT OR UPDATE OF tenant_id,evidence_evaluation_ids ON ai_improvement_proposals
FOR EACH ROW EXECUTE FUNCTION validate_ai_proposal_evidence_tenant();

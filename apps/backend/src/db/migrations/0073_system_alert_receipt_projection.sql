CREATE OR REPLACE FUNCTION project_workspace_system_alert_receipts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.audience = 'workspace' THEN
    INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id,created_at)
    SELECT NEW.id,NEW.tenant_id,m.user_id,NEW.created_at
    FROM workspace_members m
    JOIN users u ON u.id=m.user_id AND u.status='active'
    WHERE m.workspace_id=NEW.tenant_id
      AND m.status='active'
    ON CONFLICT(alert_id,tenant_id,user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS system_alerts_project_workspace_receipts ON system_alerts;
CREATE TRIGGER system_alerts_project_workspace_receipts
AFTER INSERT ON system_alerts
FOR EACH ROW
EXECUTE FUNCTION project_workspace_system_alert_receipts();

INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id,created_at)
SELECT a.id,a.tenant_id,m.user_id,a.created_at
FROM system_alerts a
JOIN workspace_members m
  ON m.workspace_id=a.tenant_id
 AND m.status='active'
JOIN users u
  ON u.id=m.user_id
 AND u.status='active'
WHERE a.audience='workspace'
ON CONFLICT(alert_id,tenant_id,user_id) DO NOTHING;

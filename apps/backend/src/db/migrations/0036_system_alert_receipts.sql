DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_alerts_id_tenant_unique'
  ) THEN
    ALTER TABLE system_alerts
      ADD CONSTRAINT system_alerts_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS system_alert_receipts (
  alert_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notified_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, tenant_id, user_id),
  FOREIGN KEY (alert_id, tenant_id)
    REFERENCES system_alerts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_system_alert_receipts_user_unread
  ON system_alert_receipts (tenant_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

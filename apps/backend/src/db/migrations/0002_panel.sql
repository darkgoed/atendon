CREATE TABLE IF NOT EXISTS panel_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin')),
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS disconnected_reason TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS attendant_phone TEXT;
CREATE INDEX IF NOT EXISTS idx_panel_users_tenant ON panel_users(tenant_id);

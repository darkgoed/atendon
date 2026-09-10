-- Multi-número por empresa. Aditiva: instalações com 1 conexão não mudam de
-- comportamento porque a primária é backfillada como a MAIS NOVA por created_at,
-- que é exatamente o que todas as consultas legadas (ORDER BY created_at DESC
-- LIMIT 1) já escolhiam.
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_label_check;
ALTER TABLE whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_label_check
  CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 60);

-- Uma primária ativa por tenant. Conexões arquivadas nunca disputam.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_sessions_primary
  ON whatsapp_sessions(tenant_id)
  WHERE is_primary AND archived_at IS NULL;

-- Backfill determinístico: a mais nova vira primária; as demais ficam
-- secundárias e visíveis.
WITH ranked AS (
  SELECT id, tenant_id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY created_at DESC, id DESC) AS position
  FROM whatsapp_sessions
  WHERE archived_at IS NULL
)
UPDATE whatsapp_sessions session
SET is_primary = true,
    label = COALESCE(session.label, 'Principal')
FROM ranked
WHERE ranked.id = session.id
  AND ranked.position = 1
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_sessions other
    WHERE other.tenant_id = session.tenant_id AND other.is_primary AND other.archived_at IS NULL
  );

UPDATE whatsapp_sessions
SET label = 'Conexão ' || substr(replace(id::text,'-',''),1,6)
WHERE label IS NULL;

ALTER TABLE whatsapp_sessions ALTER COLUMN label SET NOT NULL;
ALTER TABLE whatsapp_sessions ALTER COLUMN label SET DEFAULT 'Principal';

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_tenant_active
  ON whatsapp_sessions(tenant_id, created_at)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS attendant_assignment_cursors (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_member_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendant_assignment_cursor_member_tenant_fkey
    FOREIGN KEY(last_member_id,tenant_id)
    REFERENCES workspace_members(id,workspace_id)
    ON DELETE SET NULL (last_member_id)
);

CREATE INDEX IF NOT EXISTS idx_attendant_pool_rotation_order
  ON scheduling_google_meet_closers(tenant_id,created_at,member_id);

INSERT INTO attendant_assignment_cursors(tenant_id)
SELECT id FROM tenants
ON CONFLICT(tenant_id) DO NOTHING;

-- Responsáveis fora do pool elegível não podem permanecer em casos ativos.
WITH eligible AS (
  SELECT pool.tenant_id,m.id member_id,m.user_id
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
)
UPDATE scheduling_leads lead
SET assigned_member_id=NULL,updated_at=now()
WHERE lead.assigned_member_id IS NOT NULL
  AND lead.status NOT IN ('recusado','cancelado')
  AND NOT EXISTS (
    SELECT 1 FROM eligible
    WHERE eligible.tenant_id=lead.tenant_id
      AND eligible.member_id=lead.assigned_member_id
  );

WITH eligible AS (
  SELECT pool.tenant_id,m.user_id
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
)
UPDATE conversations conversation
SET assigned_user_id=NULL,claimed_at=NULL
WHERE conversation.assigned_user_id IS NOT NULL
  AND conversation.status='open'
  AND NOT EXISTS (
    SELECT 1 FROM eligible
    WHERE eligible.tenant_id=conversation.tenant_id
      AND eligible.user_id=conversation.assigned_user_id
  );

-- Sincroniza primeiro pares em que somente um lado já possui responsável
-- elegível. A disponibilidade operacional é deliberadamente ignorada.
WITH eligible AS (
  SELECT pool.tenant_id,m.id member_id,m.user_id
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
), paired AS (
  SELECT lead.id lead_id,conversation.id conversation_id,conversation.assigned_user_id
  FROM scheduling_leads lead
  JOIN conversations conversation
    ON conversation.tenant_id=lead.tenant_id
   AND regexp_replace(conversation.contact_phone,'\D','','g')=regexp_replace(lead.phone,'\D','','g')
  WHERE lead.assigned_member_id IS NULL
    AND lead.status NOT IN ('recusado','cancelado')
    AND conversation.assigned_user_id IS NOT NULL
)
UPDATE scheduling_leads lead
SET assigned_member_id=eligible.member_id,updated_at=now()
FROM paired,eligible
WHERE lead.id=paired.lead_id
  AND eligible.tenant_id=lead.tenant_id
  AND eligible.user_id=paired.assigned_user_id;

WITH eligible AS (
  SELECT pool.tenant_id,m.id member_id,m.user_id
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
)
UPDATE conversations conversation
SET assigned_user_id=eligible.user_id,
    claimed_at=COALESCE(conversation.claimed_at,now())
FROM scheduling_leads lead
JOIN eligible ON eligible.tenant_id=lead.tenant_id
             AND eligible.member_id=lead.assigned_member_id
WHERE conversation.tenant_id=lead.tenant_id
  AND regexp_replace(conversation.contact_phone,'\D','','g')=regexp_replace(lead.phone,'\D','','g')
  AND conversation.status='open'
  AND conversation.assigned_user_id IS NULL;

-- Em um par ativo com dois responsáveis elegíveis divergentes, a conversa
-- aberta é a fonte do caso corrente e prevalece sobre o lead.
WITH eligible AS (
  SELECT pool.tenant_id,m.id member_id,m.user_id
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
)
UPDATE scheduling_leads lead
SET assigned_member_id=eligible.member_id,updated_at=now()
FROM conversations conversation,eligible
WHERE conversation.tenant_id=lead.tenant_id
  AND conversation.status='open'
  AND regexp_replace(conversation.contact_phone,'\D','','g')=regexp_replace(lead.phone,'\D','','g')
  AND eligible.tenant_id=conversation.tenant_id
  AND eligible.user_id=conversation.assigned_user_id
  AND lead.status NOT IN ('recusado','cancelado')
  AND lead.assigned_member_id IS DISTINCT FROM eligible.member_id;

-- Distribui deterministicamente somente casos ativos ainda sem responsável.
CREATE TEMP TABLE assignment_backfill_cases ON COMMIT DROP AS
WITH eligible AS (
  SELECT pool.tenant_id,m.id member_id,m.user_id,
         row_number() OVER (
           PARTITION BY pool.tenant_id ORDER BY pool.created_at,m.id
         ) pool_position,
         count(*) OVER (PARTITION BY pool.tenant_id) pool_size
  FROM scheduling_google_meet_closers pool
  JOIN workspace_members m
    ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE EXISTS (
    SELECT 1 FROM workspace_role_permissions permission
    WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
  )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
    )
    AND EXISTS (
      SELECT 1 FROM workspace_role_permissions permission
      WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
    )
), active_sources AS (
  SELECT lead.tenant_id,lead.phone
  FROM scheduling_leads lead
  WHERE lead.assigned_member_id IS NULL
    AND lead.status NOT IN ('recusado','cancelado')
  UNION
  SELECT conversation.tenant_id,conversation.contact_phone
  FROM conversations conversation
  WHERE conversation.assigned_user_id IS NULL
    AND conversation.status='open'
), cases AS (
  SELECT source.tenant_id,
         regexp_replace(source.phone,'\D','','g') phone_key,
         min(source.phone) phone,
         row_number() OVER (
           PARTITION BY source.tenant_id
           ORDER BY regexp_replace(source.phone,'\D','','g')
         ) case_position
  FROM active_sources source
  GROUP BY source.tenant_id,regexp_replace(source.phone,'\D','','g')
)
SELECT cases.tenant_id,cases.phone_key,cases.phone,cases.case_position,
       eligible.member_id,eligible.user_id
FROM cases
JOIN eligible
  ON eligible.tenant_id=cases.tenant_id
 AND eligible.pool_position=((cases.case_position-1)%eligible.pool_size)+1;

UPDATE scheduling_leads lead
SET assigned_member_id=backfill.member_id,updated_at=now()
FROM assignment_backfill_cases backfill
WHERE lead.tenant_id=backfill.tenant_id
  AND regexp_replace(lead.phone,'\D','','g')=backfill.phone_key
  AND lead.status NOT IN ('recusado','cancelado')
  AND lead.assigned_member_id IS NULL;

UPDATE conversations conversation
SET assigned_user_id=backfill.user_id,
    claimed_at=COALESCE(conversation.claimed_at,now())
FROM assignment_backfill_cases backfill
WHERE conversation.tenant_id=backfill.tenant_id
  AND regexp_replace(conversation.contact_phone,'\D','','g')=backfill.phone_key
  AND conversation.status='open'
  AND conversation.assigned_user_id IS NULL;

UPDATE scheduling_appointments appointment
SET assigned_member_id=lead.assigned_member_id,
    assigned_at=CASE WHEN lead.assigned_member_id IS NULL THEN NULL ELSE COALESCE(appointment.assigned_at,now()) END,
    updated_at=now()
FROM scheduling_leads lead
WHERE lead.id=appointment.lead_id
  AND lead.tenant_id=appointment.tenant_id
  AND appointment.status IN ('confirmado','reagendado')
  AND appointment.assigned_member_id IS DISTINCT FROM lead.assigned_member_id;

UPDATE attendant_assignment_cursors cursor
SET last_member_id=selected.member_id,updated_at=now()
FROM (
  SELECT DISTINCT ON (tenant_id) tenant_id,member_id
  FROM assignment_backfill_cases
  ORDER BY tenant_id,case_position DESC
) selected
WHERE cursor.tenant_id=selected.tenant_id;

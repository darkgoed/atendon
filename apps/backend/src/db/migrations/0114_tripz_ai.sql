-- Tripz IA is an isolated, tenant-owned bounded context. It deliberately does
-- not reference the regular conversations/messages/usage tables.

ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT IF EXISTS feature_flag_definitions_flag_key_check;
ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check CHECK (flag_key IN (
    'ai_turn_visibility_v1',
    'conversations_delta_v2',
    'alerts_delivery_v2',
    'evaluation_event_enqueue_v2',
    'scheduling_meet_outbox_v2',
    'ai_deterministic_confirmations_v2',
    'evaluator_payload_redaction_v2',
    'state_tool_gating_v2',
    'compact_prompt_v2',
    'case_organization_v1',
    'dashboard_widgets_v1',
    'web_push_v1',
    'tripz_ai_v1'
  ));

INSERT INTO feature_flag_definitions(
  flag_key,description,default_enabled,global_enabled,kill_switch_enabled
) VALUES (
  'tripz_ai_v1',
  'Copiloto isolado para propostas e roteiros Tripz',
  false,
  null,
  false
)
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO permissions(key,module,action,description) VALUES
  ('tripz_ai.use','tripz_ai','use','Criar e gerenciar as próprias propostas Tripz IA'),
  ('tripz_ai.manage','tripz_ai','manage','Visualizar e gerenciar todas as propostas Tripz IA do workspace')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.permission_key
FROM workspace_roles role
CROSS JOIN (VALUES ('tripz_ai.use'),('tripz_ai.manage')) permission(permission_key)
WHERE role.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,'tripz_ai.use'
FROM workspace_roles role
WHERE role.name IN ('SUPERVISOR','OPERADOR')
ON CONFLICT DO NOTHING;

CREATE TABLE tripz_ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT 'Nova proposta'
    CHECK (char_length(title) BETWEEN 1 AND 200),
  title_manually_set BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting','ready_for_review','ready_for_pdf','pdf_generated')),
  summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 5000),
  state_revision INT NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  processing_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (processing_status IN ('idle','queued','processing','failed')),
  processing_error_code TEXT
    CHECK (processing_error_code IS NULL OR processing_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_conversations_id_tenant_unique UNIQUE(id,tenant_id)
);

CREATE INDEX idx_tripz_ai_conversations_owner_updated
  ON tripz_ai_conversations(tenant_id,created_by_user_id,updated_at DESC,id DESC);
CREATE INDEX idx_tripz_ai_conversations_workspace_updated
  ON tripz_ai_conversations(tenant_id,updated_at DESC,id DESC);
CREATE INDEX idx_tripz_ai_conversations_processing
  ON tripz_ai_conversations(tenant_id,processing_status,updated_at,id)
  WHERE processing_status <> 'idle';

CREATE TABLE tripz_ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 20000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text) <= 65536),
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','queued','processing','completed','failed')),
  idempotency_key TEXT CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  payload_fingerprint CHAR(64)
    CHECK (payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$'),
  proposal_revision_before INT CHECK (proposal_revision_before IS NULL OR proposal_revision_before >= 0),
  proposal_revision_after INT CHECK (proposal_revision_after IS NULL OR proposal_revision_after >= 0),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_messages_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_messages_id_tenant_conversation_unique
    UNIQUE(id,tenant_id,conversation_id),
  CONSTRAINT tripz_ai_messages_idempotency_unique
    UNIQUE(tenant_id,conversation_id,idempotency_key),
  CHECK ((role='user' AND created_by_user_id IS NOT NULL AND idempotency_key IS NOT NULL AND payload_fingerprint IS NOT NULL)
      OR (role='assistant' AND idempotency_key IS NULL AND payload_fingerprint IS NULL))
);

CREATE INDEX idx_tripz_ai_messages_conversation_created
  ON tripz_ai_messages(tenant_id,conversation_id,created_at,id);
CREATE INDEX idx_tripz_ai_messages_claim
  ON tripz_ai_messages(available_at,created_at,id)
  WHERE processing_status IN ('queued','failed');
CREATE INDEX idx_tripz_ai_messages_processing_lease
  ON tripz_ai_messages(lease_expires_at,id)
  WHERE processing_status='processing';

CREATE TABLE tripz_ai_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID,
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  extension TEXT NOT NULL CHECK (extension IN ('jpg','png','webp','pdf')),
  size_bytes INT NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  file_data BYTEA NOT NULL CHECK (octet_length(file_data)=size_bytes),
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','processing','processed','failed','needs_review')),
  extracted_text TEXT CHECK (extracted_text IS NULL OR char_length(extracted_text) <= 200000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text) <= 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_attachments_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_attachments_message_fkey
    FOREIGN KEY(message_id,tenant_id,conversation_id)
    REFERENCES tripz_ai_messages(id,tenant_id,conversation_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_attachments_id_tenant_conversation_unique
    UNIQUE(id,tenant_id,conversation_id)
);

CREATE INDEX idx_tripz_ai_attachments_conversation_status
  ON tripz_ai_attachments(tenant_id,conversation_id,processing_status,created_at,id);
CREATE INDEX idx_tripz_ai_attachments_message
  ON tripz_ai_attachments(tenant_id,conversation_id,message_id)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tripz_ai_attachments_unlinked_content_unique
  ON tripz_ai_attachments(tenant_id,conversation_id,content_hash)
  WHERE message_id IS NULL;

CREATE TABLE tripz_ai_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  schema_version INT NOT NULL DEFAULT 1 CHECK (schema_version=1),
  revision INT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state JSONB NOT NULL DEFAULT '{"schemaVersion":1,"flights":[],"media":[],"includedItems":[],"itinerary":[],"notes":[],"generationRequirements":[],"issueAcknowledgements":[],"missingInformation":[],"inconsistencies":[],"status":"collecting"}'::jsonb
    CHECK (jsonb_typeof(state)='object' AND octet_length(state::text) <= 1048576),
  missing_information JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_information)='array'),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_proposals_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_proposals_conversation_unique UNIQUE(tenant_id,conversation_id),
  CONSTRAINT tripz_ai_proposals_id_tenant_conversation_unique
    UNIQUE(id,tenant_id,conversation_id)
);

CREATE TABLE tripz_ai_proposal_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  attachment_id UUID NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category ~ '^[a-z][a-z0-9_]{0,63}$'),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 300),
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  selected_for_pdf BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_proposal_media_proposal_fkey
    FOREIGN KEY(proposal_id,tenant_id,conversation_id)
    REFERENCES tripz_ai_proposals(id,tenant_id,conversation_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_proposal_media_attachment_fkey
    FOREIGN KEY(attachment_id,tenant_id,conversation_id)
    REFERENCES tripz_ai_attachments(id,tenant_id,conversation_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_proposal_media_attachment_unique
    UNIQUE(tenant_id,proposal_id,attachment_id)
);

CREATE INDEX idx_tripz_ai_proposal_media_order
  ON tripz_ai_proposal_media(tenant_id,proposal_id,selected_for_pdf,sort_order,id);
CREATE INDEX idx_tripz_ai_proposal_media_attachment
  ON tripz_ai_proposal_media(tenant_id,conversation_id,attachment_id);

CREATE TABLE tripz_ai_generated_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  proposal_revision INT NOT NULL CHECK (proposal_revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('preview','pdf')),
  renderer_version TEXT NOT NULL CHECK (char_length(renderer_version) BETWEEN 1 AND 100),
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('text/html; charset=utf-8','application/pdf')),
  size_bytes INT NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  html_data TEXT,
  pdf_data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_generated_documents_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_generated_documents_kind_content_check CHECK (
    (kind='preview' AND mime_type='text/html; charset=utf-8' AND html_data IS NOT NULL
      AND pdf_data IS NULL AND octet_length(html_data)=size_bytes)
    OR
    (kind='pdf' AND mime_type='application/pdf' AND pdf_data IS NOT NULL
      AND html_data IS NULL AND octet_length(pdf_data)=size_bytes)
  ),
  CONSTRAINT tripz_ai_generated_documents_revision_kind_unique
    UNIQUE(tenant_id,conversation_id,proposal_revision,kind)
);

CREATE INDEX idx_tripz_ai_generated_documents_current
  ON tripz_ai_generated_documents(tenant_id,conversation_id,proposal_revision,kind,created_at DESC,id DESC);

CREATE TABLE tripz_ai_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID,
  purpose TEXT NOT NULL CHECK (purpose IN ('conversation','attachment','proposal')),
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 300),
  provider TEXT CHECK (provider IS NULL OR char_length(provider) <= 200),
  input_tokens INT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  duration_ms INT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  request_index INT NOT NULL DEFAULT 1 CHECK (request_index BETWEEN 1 AND 100),
  finish_reason TEXT CHECK (finish_reason IS NULL OR char_length(finish_reason) <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_usage_logs_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_usage_logs_message_fkey
    FOREIGN KEY(message_id,tenant_id,conversation_id)
    REFERENCES tripz_ai_messages(id,tenant_id,conversation_id) ON DELETE CASCADE
);

CREATE INDEX idx_tripz_ai_usage_logs_workspace_created
  ON tripz_ai_usage_logs(tenant_id,created_at DESC,id DESC);
CREATE INDEX idx_tripz_ai_usage_logs_conversation
  ON tripz_ai_usage_logs(tenant_id,conversation_id,message_id,created_at DESC);

CREATE OR REPLACE FUNCTION tripz_ai_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tripz_ai_conversations_touch_updated_at
BEFORE UPDATE ON tripz_ai_conversations
FOR EACH ROW EXECUTE FUNCTION tripz_ai_touch_updated_at();
CREATE TRIGGER tripz_ai_messages_touch_updated_at
BEFORE UPDATE ON tripz_ai_messages
FOR EACH ROW EXECUTE FUNCTION tripz_ai_touch_updated_at();
CREATE TRIGGER tripz_ai_attachments_touch_updated_at
BEFORE UPDATE ON tripz_ai_attachments
FOR EACH ROW EXECUTE FUNCTION tripz_ai_touch_updated_at();
CREATE TRIGGER tripz_ai_proposals_touch_updated_at
BEFORE UPDATE ON tripz_ai_proposals
FOR EACH ROW EXECUTE FUNCTION tripz_ai_touch_updated_at();
CREATE TRIGGER tripz_ai_proposal_media_touch_updated_at
BEFORE UPDATE ON tripz_ai_proposal_media
FOR EACH ROW EXECUTE FUNCTION tripz_ai_touch_updated_at();

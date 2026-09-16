-- Instagram Messaging foundation. The connection remains the canonical channel
-- source: no second provider_channel discriminator is added to conversations/leads.

ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_username TEXT,
  ADD COLUMN IF NOT EXISTS credentials_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconnect_required BOOLEAN NOT NULL DEFAULT false;

-- Account ownership is global, including archived rows, so the same Meta account
-- can never be routed to another tenant. Reauthorization revives the original row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_provider_account_global
  ON whatsapp_sessions(provider_account_id)
  WHERE channel='instagram' AND provider_account_id IS NOT NULL;

-- Keep the WhatsApp conflict target introduced by 0152. NULL Instagram phones do
-- not participate in this index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_session_phone
  ON conversations(tenant_id,session_id,contact_phone);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS instagram_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS instagram_username TEXT,
  ADD COLUMN IF NOT EXISTS contact_thread_id TEXT,
  ADD COLUMN IF NOT EXISTS messaging_window_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_last_user_message_at TIMESTAMPTZ;
ALTER TABLE conversations ALTER COLUMN contact_phone DROP NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_phone_e164_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_phone_e164_check
  CHECK (contact_phone IS NULL OR contact_phone ~ '^[1-9][0-9]{7,14}$');

-- The application-level media type now includes Instagram video. Replace the
-- original 0001 constraint so both fresh installs and upgrades accept it.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_media_type_check
  CHECK (media_type IS NULL OR media_type IN ('audio','image','document','video'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_identity_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_identity_check CHECK (
  (instagram_contact_id IS NULL AND instagram_username IS NULL AND contact_phone IS NOT NULL)
  OR (instagram_contact_id IS NOT NULL AND contact_phone IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_conversation_identity
  ON conversations(tenant_id,session_id,instagram_contact_id)
  WHERE instagram_contact_id IS NOT NULL;
-- Supports tenant+connection scoped references from Instagram outbox/media. This
-- prevents a conversation from one Instagram account being attached to another
-- account in the same tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_id_tenant_session
  ON conversations(id,tenant_id,session_id);

ALTER TABLE scheduling_leads
  ADD COLUMN IF NOT EXISTS instagram_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS instagram_username TEXT,
  ADD COLUMN IF NOT EXISTS instagram_session_id UUID;
ALTER TABLE scheduling_leads ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_phone_e164_check;
ALTER TABLE scheduling_leads ADD CONSTRAINT scheduling_leads_phone_e164_check
  CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_channel_identity_check;
ALTER TABLE scheduling_leads ADD CONSTRAINT scheduling_leads_channel_identity_check CHECK (
  (instagram_contact_id IS NULL AND instagram_username IS NULL AND instagram_session_id IS NULL AND phone IS NOT NULL)
  OR (instagram_contact_id IS NOT NULL AND instagram_session_id IS NOT NULL AND phone IS NULL)
);
ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_instagram_session_tenant_fk;
ALTER TABLE scheduling_leads ADD CONSTRAINT scheduling_leads_instagram_session_tenant_fk
  FOREIGN KEY(instagram_session_id,tenant_id)
  REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_lead_identity
  ON scheduling_leads(tenant_id,instagram_session_id,instagram_contact_id)
  WHERE instagram_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduling_leads_instagram_session_tenant
  ON scheduling_leads(instagram_session_id,tenant_id)
  WHERE instagram_session_id IS NOT NULL;

-- Preserve the current 0098 WhatsApp lead-linking behavior verbatim and only add
-- the Instagram early return. The repository supplies the scoped Instagram lead.
CREATE OR REPLACE FUNCTION link_conversation_to_lead()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.instagram_contact_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.lead_id IS NULL OR TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.contact_phone IS DISTINCT FROM OLD.contact_phone
  ) THEN
    SELECT lead.id INTO NEW.lead_id
    FROM scheduling_leads lead
    WHERE lead.tenant_id=NEW.tenant_id AND lead.phone=NEW.contact_phone;

    IF NEW.lead_id IS NULL THEN
      INSERT INTO scheduling_leads(tenant_id,phone,name,source,facebook_attribution)
      VALUES(
        NEW.tenant_id,
        NEW.contact_phone,
        NEW.contact_name,
        CASE WHEN NEW.facebook_attribution <> '{}'::jsonb THEN 'facebook' ELSE 'whatsapp' END,
        NEW.facebook_attribution
      )
      ON CONFLICT(tenant_id,phone) DO UPDATE SET
        name=COALESCE(scheduling_leads.name,EXCLUDED.name),
        facebook_attribution=CASE
          WHEN EXCLUDED.facebook_attribution <> '{}'::jsonb THEN EXCLUDED.facebook_attribution
          ELSE scheduling_leads.facebook_attribution
        END,
        updated_at=now()
      RETURNING id INTO NEW.lead_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_link_lead ON conversations;
CREATE TRIGGER conversations_link_lead
BEFORE INSERT OR UPDATE OF tenant_id,contact_phone,lead_id,instagram_contact_id ON conversations
FOR EACH ROW EXECUTE FUNCTION link_conversation_to_lead();

-- Cross-table checks ensure nullable phone identities agree with the canonical
-- connection channel for both applications.
CREATE OR REPLACE FUNCTION validate_conversation_connection_channel()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE connection_channel text;
BEGIN
  SELECT channel INTO connection_channel
  FROM whatsapp_sessions
  WHERE id=NEW.session_id AND tenant_id=NEW.tenant_id;
  IF connection_channel IS NULL THEN
    RETURN NEW;
  END IF;
  IF connection_channel='instagram' AND NEW.instagram_contact_id IS NULL THEN
    RAISE EXCEPTION 'Instagram conversation requires Instagram identity';
  END IF;
  IF connection_channel='whatsapp' AND NEW.instagram_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'WhatsApp conversation cannot use Instagram identity';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_validate_connection_channel ON conversations;
CREATE CONSTRAINT TRIGGER conversations_validate_connection_channel
AFTER INSERT OR UPDATE OF tenant_id,session_id,instagram_contact_id ON conversations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION validate_conversation_connection_channel();

CREATE OR REPLACE FUNCTION validate_instagram_lead_connection_channel()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.instagram_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_sessions
    WHERE id=NEW.instagram_session_id AND tenant_id=NEW.tenant_id AND channel='instagram'
  ) THEN
    RAISE EXCEPTION 'Instagram lead requires an Instagram connection in the same tenant';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scheduling_leads_validate_instagram_channel ON scheduling_leads;
CREATE CONSTRAINT TRIGGER scheduling_leads_validate_instagram_channel
AFTER INSERT OR UPDATE OF tenant_id,instagram_session_id ON scheduling_leads
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION validate_instagram_lead_connection_channel();

CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state TEXT PRIMARY KEY CHECK(char_length(state) BETWEEN 32 AND 256),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version INT NOT NULL CHECK(session_version>=1),
  browser_nonce_hash TEXT NOT NULL CHECK(browser_nonce_hash ~ '^[a-f0-9]{64}$'),
  redirect_uri TEXT NOT NULL,
  label TEXT NOT NULL CHECK(char_length(btrim(label)) BETWEEN 1 AND 60),
  connection_id UUID,
  force_reauth BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,tenant_id) REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS instagram_oauth_states_expiry
  ON instagram_oauth_states(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS instagram_oauth_states_connection
  ON instagram_oauth_states(connection_id) WHERE connection_id IS NOT NULL AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS instagram_webhook_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  provider_event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  raw_body BYTEA NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error TEXT,
  UNIQUE(tenant_id,session_id,provider_event_id),
  FOREIGN KEY(session_id,tenant_id) REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS instagram_inbox_claim
  ON instagram_webhook_inbox(tenant_id,processed_at,claimed_at,received_at);

CREATE TABLE IF NOT EXISTS instagram_webhook_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  conversation_id UUID,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','rejected','ambiguous')),
  failure_code TEXT,
  invalidated_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(session_id,tenant_id) REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id,tenant_id) REFERENCES conversations(id,tenant_id) ON DELETE CASCADE
);
ALTER TABLE instagram_webhook_outbox
  DROP CONSTRAINT IF EXISTS instagram_webhook_outbox_conversation_session_fk;
ALTER TABLE instagram_webhook_outbox
  ADD CONSTRAINT instagram_webhook_outbox_conversation_session_fk
  FOREIGN KEY(conversation_id,tenant_id,session_id)
  REFERENCES conversations(id,tenant_id,session_id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS instagram_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  conversation_id UUID,
  external_url TEXT,
  storage_key TEXT,
  media_data BYTEA NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type ~ '^(image|audio|video)/|^application/pdf$'),
  size_bytes BIGINT NOT NULL CHECK(size_bytes>=0 AND size_bytes=octet_length(media_data)),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(session_id,tenant_id) REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id,tenant_id) REFERENCES conversations(id,tenant_id) ON DELETE CASCADE
);
ALTER TABLE instagram_media
  DROP CONSTRAINT IF EXISTS instagram_media_conversation_session_fk;
ALTER TABLE instagram_media
  ADD CONSTRAINT instagram_media_conversation_session_fk
  FOREIGN KEY(conversation_id,tenant_id,session_id)
  REFERENCES conversations(id,tenant_id,session_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS instagram_media_tenant
  ON instagram_media(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS instagram_media_expiry ON instagram_media(expires_at);

-- The public HTTP media route has no tenant session by design; authorization is
-- the short-lived HMAC token verified before this narrowly scoped lookup. A
-- SECURITY DEFINER function allows that lookup without weakening table RLS.
CREATE OR REPLACE FUNCTION get_signed_instagram_public_media(media_id UUID)
RETURNS TABLE(
  id UUID,
  media_data BYTEA,
  content_type TEXT,
  size_bytes BIGINT,
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT media.id,media.media_data,media.content_type,media.size_bytes,media.expires_at
  FROM public.instagram_media media
  WHERE media.id=media_id AND media.expires_at>now()
$$;
REVOKE ALL ON FUNCTION get_signed_instagram_public_media(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_signed_instagram_public_media(UUID) TO CURRENT_USER;

ALTER TABLE instagram_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_media ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'instagram_oauth_states','instagram_webhook_inbox','instagram_webhook_outbox','instagram_media'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I',table_name,table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',
      table_name,table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION prevent_instagram_primary()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel='instagram' AND NEW.is_primary THEN
    RAISE EXCEPTION 'Instagram cannot be primary';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS whatsapp_sessions_no_instagram_primary ON whatsapp_sessions;
CREATE TRIGGER whatsapp_sessions_no_instagram_primary
BEFORE INSERT OR UPDATE OF channel,is_primary ON whatsapp_sessions
FOR EACH ROW EXECUTE FUNCTION prevent_instagram_primary();

ALTER TABLE whatsapp_sessions DROP CONSTRAINT IF EXISTS whatsapp_sessions_instagram_credentials_check;
ALTER TABLE whatsapp_sessions ADD CONSTRAINT whatsapp_sessions_instagram_credentials_check CHECK (
  channel <> 'instagram'
  OR (
    phone_number IS NULL
    AND NOT is_primary
    AND (
      -- Preserve schema-ready rows created under 0157. They carry no provider
      -- identity or secret and are deliberately ignored by the repository.
      (provider_account_id IS NULL AND provider_username IS NULL
       AND credentials_encrypted IS NULL AND token_expires_at IS NULL
       AND NOT reconnect_required)
      OR
      (provider_account_id IS NOT NULL
       AND credentials_encrypted ~ '^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
       AND status='connected' AND token_expires_at IS NOT NULL AND NOT reconnect_required)
      OR
      (provider_account_id IS NOT NULL AND status='disconnected'
       AND credentials_encrypted IS NULL AND reconnect_required)
    )
  )
);

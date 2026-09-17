-- Release pipeline: persisted version/build history, technical + AI-generated
-- public changelog, and the ROOT-configured OpenRouter settings used only for
-- changelog generation. Replaces changelog.json as the source of truth; the
-- file is migrated in 0160 and kept only as a compatibility mirror.

CREATE SEQUENCE IF NOT EXISTS releases_build_number_seq;

CREATE TABLE IF NOT EXISTS releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_number BIGINT NOT NULL DEFAULT nextval('releases_build_number_seq'),
  version TEXT NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  -- PATCH = fix/no perceptible impact, DROP = incremental feature drop (minor),
  -- RELEASE = major/structural impact. Never derived from raw diff byte size.
  classification TEXT NOT NULL CHECK (classification IN ('PATCH','DROP','RELEASE')),
  classification_reason TEXT NOT NULL DEFAULT '',
  bump_source TEXT NOT NULL DEFAULT 'auto' CHECK (bump_source IN ('auto','manual_override','legacy_import')),
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{7,40}$|^unknown$'),
  branch TEXT NOT NULL DEFAULT 'main',
  additions INT NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions INT NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  files_changed JSONB NOT NULL DEFAULT '[]'::jsonb,
  modules_affected TEXT[] NOT NULL DEFAULT '{}',
  -- GLOBAL/TENANT is derived from public_changes (each item carries its own
  -- tenant_slugs, same contract as the legacy changelog.json), so it is only
  -- meaningful once ai_status='generated' or a manual override sets it.
  scope TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope IN ('GLOBAL','TENANT')),
  -- Slugs the diff actually touched, comprovado against the tenants table —
  -- never inferred from free text. Drives the ROOT tenant filter and bounds
  -- which tenant_slugs the AI step is allowed to attach to a change.
  tenant_slugs_detected TEXT[] NOT NULL DEFAULT '{}',
  commit_messages TEXT[] NOT NULL DEFAULT '{}',
  diff_excerpt TEXT NOT NULL DEFAULT '',
  technical_changelog TEXT NOT NULL DEFAULT '',
  public_title TEXT,
  public_summary TEXT,
  public_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_status TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending','generating','generated','failed')),
  ai_error TEXT,
  ai_model_used TEXT,
  ai_attempt_count INT NOT NULL DEFAULT 0 CHECK (ai_attempt_count >= 0),
  ai_last_attempt_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  manual_override BOOLEAN NOT NULL DEFAULT false,
  overridden_by_user_id UUID REFERENCES users(id),
  overridden_at TIMESTAMPTZ,
  is_legacy_import BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL DEFAULT 'deploy-pipeline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT releases_build_number_unique UNIQUE (build_number),
  CONSTRAINT releases_published_requires_public_content CHECK (
    NOT published OR (public_title IS NOT NULL AND public_summary IS NOT NULL)
  ),
  CONSTRAINT releases_override_actor_pairing CHECK (
    (overridden_by_user_id IS NULL) = (overridden_at IS NULL)
  )
);
ALTER SEQUENCE releases_build_number_seq OWNED BY releases.build_number;

CREATE INDEX IF NOT EXISTS idx_releases_published_scope ON releases(published, scope);
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);
CREATE INDEX IF NOT EXISTS idx_releases_tenant_slugs_detected ON releases USING GIN(tenant_slugs_detected);
CREATE INDEX IF NOT EXISTS idx_releases_ai_pending ON releases(ai_status, ai_last_attempt_at)
  WHERE ai_status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_releases_build_number_desc ON releases(build_number DESC);

CREATE OR REPLACE FUNCTION releases_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS releases_touch_updated_at ON releases;
CREATE TRIGGER releases_touch_updated_at
BEFORE UPDATE ON releases
FOR EACH ROW EXECUTE FUNCTION releases_touch_updated_at();

-- Singleton ROOT configuration for the OpenRouter account used exclusively by
-- the changelog AI step. Mirrors the billing_settings singleton pattern. The
-- API key ciphertext is produced with the same AES-256-GCM envelope as
-- billing/Instagram/Google Meet secrets (modules/ai-router/secret-box.ts) and
-- is never selected by any route that serves the panel/browser.
CREATE TABLE IF NOT EXISTS changelog_ai_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  api_key_encrypted TEXT,
  api_key_hint TEXT,
  primary_model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b',
  fallback_model TEXT,
  auto_generate_enabled BOOLEAN NOT NULL DEFAULT true,
  auto_publish_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO changelog_ai_settings DEFAULT VALUES ON CONFLICT DO NOTHING;

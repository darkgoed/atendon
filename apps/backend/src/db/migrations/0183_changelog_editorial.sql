-- 0183: Changelog editorial 100% GLOBAL (SPEC specs/active/changelog-product-20260921.md v3; decisões A1–A14).
-- Nenhuma coluna/filtro de tenant no modelo novo: uma única timeline global do produto.
-- Zero sync runtime release→post: release_id é proveniência opcional de import curado (nunca escrito pelo runtime).

CREATE TABLE changelog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id UUID NULL REFERENCES releases(id) ON DELETE SET NULL,
  version_label TEXT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NULL,
  category TEXT NOT NULL DEFAULT 'outro' CHECK (category IN ('novo','melhoria','correcao','seguranca','integracao','performance','outro')),
  author TEXT NULL,
  content_text TEXT NULL,
  modules_affected TEXT[] NOT NULL DEFAULT '{}',
  affected_plans TEXT[] NOT NULL DEFAULT '{}',
  related_links JSONB NOT NULL DEFAULT '[]',
  publish_at TIMESTAMPTZ NULL,
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ NULL,
  created_by_user_id UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT changelog_posts_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT changelog_posts_published_summary CHECK (NOT published OR summary IS NOT NULL),
  CONSTRAINT changelog_posts_published_no_schedule CHECK (NOT published OR publish_at IS NULL)
);

CREATE UNIQUE INDEX changelog_posts_slug_key ON changelog_posts (slug);
-- 1:1 opcional com releases (proveniência de import curado apenas).
CREATE UNIQUE INDEX changelog_posts_release_id_key ON changelog_posts (release_id) WHERE release_id IS NOT NULL;
-- Predicado único de elegibilidade pública: published AND publish_at IS NULL.
CREATE INDEX changelog_posts_public_feed_idx
  ON changelog_posts (published_at DESC, id DESC)
  WHERE published = true AND publish_at IS NULL;
CREATE INDEX changelog_posts_admin_list_idx ON changelog_posts (published, publish_at);

CREATE TABLE changelog_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  data BYTEA NOT NULL,
  alt TEXT NULL,
  created_by_user_id UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE changelog_post_media (
  post_id UUID NOT NULL REFERENCES changelog_posts(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES changelog_media(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, media_id)
);

-- Índice em media_id: protege DELETE/revogação de mídia (checagem de referência).
CREATE INDEX changelog_post_media_media_id_idx ON changelog_post_media (media_id);

-- Read-state POR USUÁRIO × PUBLICAÇÃO (global; sem dimensão tenant).
CREATE TABLE changelog_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES changelog_posts(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- Touch de updated_at (padrão do repositório para timestamps de edição).
CREATE OR REPLACE FUNCTION changelog_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER changelog_posts_touch
  BEFORE UPDATE ON changelog_posts
  FOR EACH ROW EXECUTE FUNCTION changelog_touch_updated_at();

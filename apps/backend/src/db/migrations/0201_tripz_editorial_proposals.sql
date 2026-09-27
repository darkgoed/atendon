-- 0196: propostas editoriais Tripz — brand por tenant + versionamento de propostas.
-- Mantém o contexto tripz_ai isolado por tenant (mesma régua da 0114/0115).

-- O estado editorial v2 convive com o v1 (estados antigos são normalizados na leitura).
ALTER TABLE tripz_ai_proposals
  DROP CONSTRAINT tripz_ai_proposals_schema_version_check;
ALTER TABLE tripz_ai_proposals
  ALTER COLUMN schema_version SET DEFAULT 2;
ALTER TABLE tripz_ai_proposals
  ADD CONSTRAINT tripz_ai_proposals_schema_version_check
  CHECK (schema_version IN (1, 2));

CREATE TABLE tripz_ai_brand_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  config JSONB NOT NULL
    CHECK (jsonb_typeof(config)='object' AND octet_length(config::text) <= 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tripz_ai_proposal_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  version_number INT NOT NULL CHECK (version_number BETWEEN 1 AND 10000),
  label TEXT CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 200),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 2000),
  state JSONB NOT NULL
    CHECK (jsonb_typeof(state)='object' AND octet_length(state::text) <= 1048576),
  document_revision INT NOT NULL CHECK (document_revision >= 0),
  approved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tripz_ai_proposal_versions_proposal_fkey
    FOREIGN KEY(proposal_id,tenant_id,conversation_id)
    REFERENCES tripz_ai_proposals(id,tenant_id,conversation_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_proposal_versions_conversation_fkey
    FOREIGN KEY(conversation_id,tenant_id)
    REFERENCES tripz_ai_conversations(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT tripz_ai_proposal_versions_version_unique
    UNIQUE(tenant_id,conversation_id,version_number)
);

CREATE INDEX idx_tripz_ai_proposal_versions_list
  ON tripz_ai_proposal_versions(tenant_id,conversation_id,version_number DESC);

-- Seed de Proposal Brand APENAS para tenants Tripz (identidade aprovada nas
-- referências Manus). Outros tenants permanecem no default neutro.
INSERT INTO tripz_ai_brand_settings(tenant_id, config)
SELECT t.id,
  jsonb_build_object(
    'activeTemplate', 'editorial-v1',
    'tokens', jsonb_build_object(
      'background', '#F7F3EB',
      'primary', '#123047',
      'secondary', '#315C73',
      'accent', '#B8654A',
      'sand', '#D8C5A2',
      'ink', '#25333D',
      'muted', '#6E7B84',
      'info', '#E7EEF0'
    ),
    'fonts', jsonb_build_object('serif', 'Noto Serif Display', 'sans', 'Noto Sans'),
    'footer', jsonb_build_object('company', 'Tripz Turismo'),
    'styleNotes', 'Voz Tripz: premium, elegante, humana e descritiva. Narrativa em pt-BR, \
segunda pessoa do plural ("vocês") quando falar com os viajantes. Headlines editoriais com \
progressão emocional e geográfica; eyebrows em caixa alta com tracking; nada de clichês de \
marketing ("experiência inesquecível", "jornada dos sonhos") salvo uso proposital; preferir \
frases curtas e concretas; comercial sempre em caráter informativo, com diferenciais de \
atendimento (check-in personalizado, emergencial bilíngue, acompanhamento de voo e assistência).',
    'commercial', jsonb_build_object('defaultCurrency', 'BRL',
      'defaultDifferentials', jsonb_build_array(
        'Check-in personalizado na chegada',
        'Atendimento emergencial em português, inglês ou espanhol',
        'Acompanhamento do voo',
        'Assessoria completa durante toda a viagem',
        'Assistência jurídica gratuita, se necessário'),
      'defaultPriceNotes', jsonb_build_array(
        'Os valores cotados podem sofrer alterações tarifárias e/ou cambiais no momento da reserva.'),
      'commercialWarnings', jsonb_build_array())
  )
FROM tenants t
WHERE t.name ILIKE '%tripz%'
  AND NOT EXISTS (SELECT 1 FROM tripz_ai_brand_settings b WHERE b.tenant_id = t.id);

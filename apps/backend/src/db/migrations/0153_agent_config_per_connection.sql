-- Prompt de IA escolhível por conexão de WhatsApp.
--
-- Aditiva e retrocompatível: `session_id` NULL é a configuração COMPARTILHADA do
-- tenant (o comportamento que existe hoje e continua sendo o padrão), e uma
-- linha com `session_id` preenchido é o OVERRIDE daquele número. A resolução em
-- runtime prefere o override e cai no compartilhado, então quem nunca criar um
-- override não muda de comportamento.
--
-- O versionamento de agent_config_versions fica inalterado: cada agent_configs
-- (compartilhado ou override) tem a própria cadeia de versões, porque o índice
-- de versão ativa já é por agent_config_id (0049), não por tenant.
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS session_id UUID;

-- O override pertence à mesma empresa da conexão; sem esta FK um tenant poderia
-- apontar para a conexão de outro. (0061 já garante UNIQUE(id,tenant_id) em
-- whatsapp_sessions.) Remover a conexão remove o override junto.
ALTER TABLE agent_configs DROP CONSTRAINT IF EXISTS agent_configs_session_tenant_fk;
ALTER TABLE agent_configs
  ADD CONSTRAINT agent_configs_session_tenant_fk
  FOREIGN KEY (session_id, tenant_id) REFERENCES whatsapp_sessions(id, tenant_id)
  ON DELETE CASCADE;

-- No máximo um override por conexão.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configs_session
  ON agent_configs(tenant_id, session_id) WHERE session_id IS NOT NULL;

-- Deliberadamente NÃO criamos índice único para as linhas compartilhadas
-- (session_id IS NULL). Configurações duplicadas por tenant são um estado
-- legado legal neste schema (agent_configs nunca teve UNIQUE(tenant_id)) e há
-- fluxo de provisionamento que depende de detectar essa ambiguidade em vez de
-- ser impedido de criá-la — ver
-- tests/newave-sales-script-prompt.integration.test.ts, que insere duas linhas
-- compartilhadas de propósito para provar que a migration do Newave recusa um
-- alvo ambíguo. Um índice único aqui trocaria esse erro claro por uma violação
-- de chave no INSERT.
--
-- A resolução em runtime não depende de unicidade: ela ordena por
-- `(session_id IS NOT NULL) DESC, updated_at DESC` e pega a primeira linha, de
-- modo que o override sempre vence e, entre compartilhadas, a mais recente é a
-- escolhida — exatamente o que o código já fazia antes desta migration.

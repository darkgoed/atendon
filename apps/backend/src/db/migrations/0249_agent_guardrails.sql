-- Guardrails operacionais do agente como configuração do tenant, versionada
-- junto com o prompt (agent_config_versions). O produto fornece o MOTOR
-- (encaminhamento por nome do responsável, convite a grupo de ofertas,
-- desqualificação por sinal de pagamento); os VALORES pertencem ao tenant.
-- Nenhum dado operacional de cliente permanece codificado no runtime.
-- Idempotente: ADD COLUMN IF NOT EXISTS e backfill por expressão regular.

ALTER TABLE agent_config_versions
  ADD COLUMN IF NOT EXISTS guardrails JSONB NOT NULL DEFAULT '{}';

-- Compatibilidade dos tenants atuais: versões cujo prompt declara a persona
-- Zulu/Tripz recebem os valores operacionais que antes estavam no código
-- (nome do responsável, texto de retorno, link e rótulo do grupo de ofertas).
-- A partir daqui, alterar esses valores é configuração do tenant, não release.
UPDATE agent_config_versions
SET guardrails = jsonb_build_object(
  'enabled', true,
  'owner_name', 'Lucas',
  'owner_referral_reply', 'Olá, tudo bem? No momento o Lucas está em atendimento, vou transferir o chamado e em breve ele irá te responder.',
  'offers_group_link', 'https://chat.whatsapp.com/F2XZvKQaToNFf6cDFYKPDL',
  'offers_group_label', 'da Tripz'
)
WHERE guardrails = '{}'::jsonb
  AND system_prompt ~* '\mzulu\M'
  AND system_prompt ~* '\mtripz(\s+turismo)?\M';

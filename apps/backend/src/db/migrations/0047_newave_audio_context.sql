-- Existing Newave workspaces keep their prompt/tool configuration in the
-- database. Apply the audio vocabulary and contextual lookup without touching
-- other tenants or duplicating either setting on repeated migration runs.
UPDATE agent_configs a
SET system_prompt = '<VOCABULARIO_TRANSCRICAO>
Newave; MetaCell; Meta Cell; Plano Mútuo MEDC
</VOCABULARIO_TRANSCRICAO>

' || a.system_prompt,
    updated_at = now()
FROM tenants t
WHERE t.id = a.tenant_id
  AND t.slug = 'newave-ia'
  AND a.system_prompt NOT LIKE '%<VOCABULARIO_TRANSCRICAO>%';

UPDATE agent_configs a
SET enabled_tools = a.enabled_tools || '["pesquisar_contexto"]'::jsonb,
    updated_at = now()
FROM tenants t
WHERE t.id = a.tenant_id
  AND t.slug = 'newave-ia'
  AND NOT a.enabled_tools @> '["pesquisar_contexto"]'::jsonb;

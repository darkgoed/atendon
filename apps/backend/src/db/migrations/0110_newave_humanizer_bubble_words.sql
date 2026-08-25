-- Newave-only: raise messageSplit.maxWordsPerBubble from the shared default
-- (30) to 48. Portuguese commercial explanations in this tenant's prompt
-- routinely run 30-45 words in a single sentence; the shared default forces a
-- mid-sentence split that fragments replies the prompt already asks to keep
-- to 1-2 bubbles. Only the Newave IA tenant is touched (matched by slug, not
-- by id, so this is safe to run against any environment); every other
-- tenant's humanizer_config is left untouched. jsonb_set only replaces the
-- one key, so any other manual customization on this tenant survives.
--
-- Idempotent: re-running is a no-op once maxWordsPerBubble is already 48.
-- Rollback: restore the shared default of 30 on this tenant only —
--   UPDATE tenant_ai_settings SET humanizer_config = jsonb_set(humanizer_config, '{messageSplit,maxWordsPerBubble}', '30', true), updated_at = now()
--   WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'newave-ia');

DO $$
DECLARE
  v_tenant_id uuid;
  v_old_value int;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'newave-ia';
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'newave-ia tenant not found; nothing to migrate';
    RETURN;
  END IF;

  SELECT (humanizer_config #>> '{messageSplit,maxWordsPerBubble}')::int
  INTO v_old_value
  FROM tenant_ai_settings
  WHERE tenant_id = v_tenant_id;

  UPDATE tenant_ai_settings
  SET humanizer_config = jsonb_set(humanizer_config, '{messageSplit,maxWordsPerBubble}', '48', true),
      updated_at = now()
  WHERE tenant_id = v_tenant_id
    AND (humanizer_config #>> '{messageSplit,maxWordsPerBubble}')::int IS DISTINCT FROM 48;

  RAISE NOTICE 'Newave humanizer_config.messageSplit.maxWordsPerBubble: % -> 48 (tenant %)', v_old_value, v_tenant_id;
END $$;

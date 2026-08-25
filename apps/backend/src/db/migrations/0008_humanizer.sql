ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS humanizer_config JSONB NOT NULL DEFAULT '{
  "readDelay":{"min":2500,"max":5000},
  "readingPause":{"min":500,"max":1800},
  "composing":{"wpm":145,"jitterMs":350,"minMs":700,"maxMs":9000,"resendIntervalMs":8000},
  "presence":{"onlineSessionMin":{"min":20,"max":50},"offlineGapMin":{"min":2,"max":8},"inactivityBeforeUnavailableMin":5,"activeHours":{"start":8,"end":22}},
  "debounce":{"silenceWindowMs":{"min":12000,"max":15000}},
  "messageSplit":{"maxWordsPerBubble":55,"pauseBetweenBubblesMs":{"min":450,"max":1400}},
  "timeOfDayMultiplier":{"outsideActiveHours":1.8},
  "reaction":{"probability":0.08,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":8}
}'::jsonb;

INSERT INTO tenant_ai_settings(tenant_id,openrouter_api_key_encrypted,media_fallback_audio,media_fallback_image,media_fallback_document)
SELECT id,NULL,
  'Recebi seu áudio, mas ainda não consigo ouvi-lo. Pode escrever em texto?',
  'Recebi sua imagem, mas ainda não consigo analisá-la. Pode descrever em texto?',
  'Recebi seu documento, mas ainda não consigo analisá-lo. Pode descrever o que precisa?'
FROM tenants ON CONFLICT(tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_tenant_ai_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_ai_settings(tenant_id,openrouter_api_key_encrypted,media_fallback_audio,media_fallback_image,media_fallback_document)
  VALUES(NEW.id,NULL,
    'Recebi seu áudio, mas ainda não consigo ouvi-lo. Pode escrever em texto?',
    'Recebi sua imagem, mas ainda não consigo analisá-la. Pode descrever em texto?',
    'Recebi seu documento, mas ainda não consigo analisá-lo. Pode descrever o que precisa?')
  ON CONFLICT(tenant_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenants_create_ai_settings ON tenants;
CREATE TRIGGER tenants_create_ai_settings AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION create_tenant_ai_settings();

ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
  "readDelay":{"min":2500,"max":5000},
  "readingPause":{"min":500,"max":1800},
  "composing":{"wpm":145,"jitterMs":350,"minMs":700,"maxMs":9000,"resendIntervalMs":8000},
  "presence":{"onlineSessionMin":{"min":20,"max":50},"offlineGapMin":{"min":2,"max":8},"inactivityBeforeUnavailableMin":5,"activeHours":{"start":8,"end":22}},
  "debounce":{"initialWindowMs":{"min":3000,"max":5000},"extensionMs":{"min":8000,"max":12000},"maxWindowMs":50000},
  "messageSplit":{"maxWordsPerBubble":55,"pauseBetweenBubblesMs":{"min":450,"max":1400}},
  "timeOfDayMultiplier":{"outsideActiveHours":1.8},
  "reaction":{"probability":0.08,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":8}
}'::jsonb;

-- Migrate existing rows from silenceWindowMs to the new dynamic debounce format
UPDATE tenant_ai_settings
SET humanizer_config = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        humanizer_config #- '{debounce,silenceWindowMs}',
        '{debounce,initialWindowMs}',
        jsonb_build_object(
          'min', GREATEST(1, ((humanizer_config #>> '{debounce,silenceWindowMs,min}')::int / 3)),
          'max', GREATEST(1, ((humanizer_config #>> '{debounce,silenceWindowMs,max}')::int / 3))
        ),
        true
      ),
      '{debounce,extensionMs}',
      jsonb_build_object(
        'min', (humanizer_config #>> '{debounce,silenceWindowMs,min}')::int,
        'max', (humanizer_config #>> '{debounce,silenceWindowMs,max}')::int
      ),
      true
    ),
    '{debounce,maxWindowMs}',
    to_jsonb((humanizer_config #>> '{debounce,silenceWindowMs,max}')::int * 3),
    true
  ),
  '{debounce}',
  humanizer_config -> 'debounce',
  true
), updated_at = now()
WHERE humanizer_config ? 'debounce'
  AND humanizer_config #>> '{debounce,silenceWindowMs,min}' IS NOT NULL;

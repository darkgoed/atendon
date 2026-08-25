ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
  "readDelay":{"min":800,"max":2500},
  "readingPause":{"min":1000,"max":2500},
  "composing":{"wpm":55,"jitterMs":600,"minMs":1200,"maxMs":6000,"resendIntervalMs":4000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":5000,"max":7000},"silenceWindowMs":{"min":8000,"max":12000},"extensionMs":{"min":45000,"max":60000}},
  "messageSplit":{"maxWordsPerBubble":1000,"pauseBetweenBubblesMs":{"min":0,"max":0}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

UPDATE tenant_ai_settings
SET humanizer_config = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          humanizer_config,
          '{debounce,initialWindowMs}',
          '{"min":5000,"max":7000}'::jsonb,
          true
        ),
        '{debounce,silenceWindowMs}',
        '{"min":8000,"max":12000}'::jsonb,
        true
      ),
      '{debounce,extensionMs}',
      '{"min":45000,"max":60000}'::jsonb,
      true
    ),
    '{messageSplit,maxWordsPerBubble}',
    '1000'::jsonb,
    true
  ),
  '{messageSplit,pauseBetweenBubblesMs}',
  '{"min":0,"max":0}'::jsonb,
  true
),
updated_at = now();

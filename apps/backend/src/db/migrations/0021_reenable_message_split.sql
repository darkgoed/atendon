ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
  "readDelay":{"min":800,"max":2500},
  "readingPause":{"min":1000,"max":2500},
  "composing":{"wpm":55,"jitterMs":600,"minMs":1200,"maxMs":6000,"resendIntervalMs":4000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":5000,"max":7000},"silenceWindowMs":{"min":8000,"max":12000},"extensionMs":{"min":45000,"max":60000}},
  "messageSplit":{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":600,"max":1800}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

-- 0020 neutralized the split (1000 words / no pause) on every tenant while the
-- single-reply window shipped. Restore active bubbles only where that disabled
-- sentinel is still in place, preserving tenants who customized their split.
UPDATE tenant_ai_settings
SET humanizer_config = jsonb_set(
  humanizer_config,
  '{messageSplit}',
  '{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":600,"max":1800}}'::jsonb,
  true
),
updated_at = now()
WHERE humanizer_config->'messageSplit' IS NULL
   OR coalesce((humanizer_config->'messageSplit'->>'maxWordsPerBubble')::int, 1000) >= 1000;

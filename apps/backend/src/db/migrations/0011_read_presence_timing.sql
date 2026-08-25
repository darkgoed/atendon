ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
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

UPDATE tenant_ai_settings
SET humanizer_config = jsonb_set(
  humanizer_config,
  '{readDelay}',
  '{"min":2500,"max":5000}'::jsonb,
  true
), updated_at = now()
WHERE COALESCE((humanizer_config #>> '{readDelay,max}')::int, 0) < 2500;

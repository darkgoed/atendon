ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
  "readDelay":{"min":350,"max":900},
  "readingPause":{"min":300,"max":850},
  "composing":{"wpm":165,"jitterMs":350,"minMs":700,"maxMs":4000,"resendIntervalMs":5000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":900,"max":1600},"silenceWindowMs":{"min":1600,"max":2800},"extensionMs":{"min":8000,"max":16000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

-- Replace the slower 0025 profile for tenants that still carry it untouched.
-- Tenants edited manually in the panel are not overwritten.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":350,"max":900},
  "readingPause":{"min":300,"max":850},
  "composing":{"wpm":165,"jitterMs":350,"minMs":700,"maxMs":4000,"resendIntervalMs":5000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":900,"max":1600},"silenceWindowMs":{"min":1600,"max":2800},"extensionMs":{"min":8000,"max":16000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now()
WHERE humanizer_config = '{
  "readDelay":{"min":800,"max":1800},
  "readingPause":{"min":700,"max":1600},
  "composing":{"wpm":115,"jitterMs":650,"minMs":1200,"maxMs":8000,"resendIntervalMs":8000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1800,"max":3200},"silenceWindowMs":{"min":3500,"max":6500},"extensionMs":{"min":18000,"max":35000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

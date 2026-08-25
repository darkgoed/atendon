ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
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

-- Replace the ultra-fast 0024 profile for tenants that still carry it
-- untouched. Customized tenants keep their explicit humanization settings.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":800,"max":1800},
  "readingPause":{"min":700,"max":1600},
  "composing":{"wpm":115,"jitterMs":650,"minMs":1200,"maxMs":8000,"resendIntervalMs":8000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1800,"max":3200},"silenceWindowMs":{"min":3500,"max":6500},"extensionMs":{"min":18000,"max":35000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now()
WHERE humanizer_config = '{
  "readDelay":{"min":0,"max":80},
  "readingPause":{"min":0,"max":120},
  "composing":{"wpm":320,"jitterMs":80,"minMs":0,"maxMs":450,"resendIntervalMs":1000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":200,"max":450},"silenceWindowMs":{"min":350,"max":800},"extensionMs":{"min":1500,"max":3000}},
  "messageSplit":{"maxWordsPerBubble":1000,"pauseBetweenBubblesMs":{"min":0,"max":0}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

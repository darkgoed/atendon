ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
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

-- Apply the faster profile only to tenants still on the previous untouched
-- default (0023). Customized tenants keep their own settings.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":0,"max":80},
  "readingPause":{"min":0,"max":120},
  "composing":{"wpm":320,"jitterMs":80,"minMs":0,"maxMs":450,"resendIntervalMs":1000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":200,"max":450},"silenceWindowMs":{"min":350,"max":800},"extensionMs":{"min":1500,"max":3000}},
  "messageSplit":{"maxWordsPerBubble":1000,"pauseBetweenBubblesMs":{"min":0,"max":0}},
  "timeOfDayMultiplier":{"outsideActiveHours":1},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now()
WHERE humanizer_config = '{
  "readDelay":{"min":200,"max":600},
  "readingPause":{"min":250,"max":700},
  "composing":{"wpm":130,"jitterMs":300,"minMs":400,"maxMs":2200,"resendIntervalMs":3000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1200,"max":2200},"silenceWindowMs":{"min":1800,"max":3200},"extensionMs":{"min":8000,"max":14000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
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

-- Apply the faster typing profile only to tenants still on the previous
-- untouched default (0022). Customized tenants keep their own humanization.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":200,"max":600},
  "readingPause":{"min":250,"max":700},
  "composing":{"wpm":130,"jitterMs":300,"minMs":400,"maxMs":2200,"resendIntervalMs":3000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1200,"max":2200},"silenceWindowMs":{"min":1800,"max":3200},"extensionMs":{"min":8000,"max":14000}},
  "messageSplit":{"maxWordsPerBubble":30,"pauseBetweenBubblesMs":{"min":150,"max":500}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now()
WHERE humanizer_config = '{
  "readDelay":{"min":250,"max":900},
  "readingPause":{"min":350,"max":1100},
  "composing":{"wpm":95,"jitterMs":450,"minMs":700,"maxMs":3500,"resendIntervalMs":3000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1200,"max":2200},"silenceWindowMs":{"min":1800,"max":3200},"extensionMs":{"min":8000,"max":14000}},
  "messageSplit":{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":250,"max":900}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

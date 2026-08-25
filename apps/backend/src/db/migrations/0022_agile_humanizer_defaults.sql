ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
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

-- Apply the new agile profile only to tenants that are still on the untouched
-- default timing profile. Customized tenants keep their own humanization.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":250,"max":900},
  "readingPause":{"min":350,"max":1100},
  "composing":{"wpm":95,"jitterMs":450,"minMs":700,"maxMs":3500,"resendIntervalMs":3000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1200,"max":2200},"silenceWindowMs":{"min":1800,"max":3200},"extensionMs":{"min":8000,"max":14000}},
  "messageSplit":{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":250,"max":900}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now()
WHERE humanizer_config = '{
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

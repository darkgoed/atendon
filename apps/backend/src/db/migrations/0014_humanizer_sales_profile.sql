ALTER TABLE tenant_ai_settings ALTER COLUMN humanizer_config SET DEFAULT '{
  "readDelay":{"min":800,"max":2500},
  "readingPause":{"min":1000,"max":2500},
  "composing":{"wpm":55,"jitterMs":600,"minMs":1200,"maxMs":6000,"resendIntervalMs":4000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1500,"max":3000},"silenceWindowMs":{"min":1200,"max":2200},"extensionMs":{"min":2000,"max":6000}},
  "messageSplit":{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":600,"max":1800}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb;

-- Apply the requested profile to existing tenants as well as new ones.
UPDATE tenant_ai_settings
SET humanizer_config = '{
  "readDelay":{"min":800,"max":2500},
  "readingPause":{"min":1000,"max":2500},
  "composing":{"wpm":55,"jitterMs":600,"minMs":1200,"maxMs":6000,"resendIntervalMs":4000},
  "presence":{"onlineSessionMin":{"min":12,"max":40},"offlineGapMin":{"min":4,"max":15},"inactivityBeforeUnavailableMin":4,"activeHours":{"start":9,"end":19}},
  "debounce":{"initialWindowMs":{"min":1500,"max":3000},"silenceWindowMs":{"min":1200,"max":2200},"extensionMs":{"min":2000,"max":6000}},
  "messageSplit":{"maxWordsPerBubble":18,"pauseBetweenBubblesMs":{"min":600,"max":1800}},
  "timeOfDayMultiplier":{"outsideActiveHours":2.2},
  "reaction":{"probability":0.12,"emojis":["👍","❤️","😊"]},
  "rateLimit":{"maxMessagesPerContactPerMinute":20}
}'::jsonb,
updated_at = now();

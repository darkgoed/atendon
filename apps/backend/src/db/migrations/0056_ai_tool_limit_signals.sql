ALTER TABLE ai_evaluation_signals
  DROP CONSTRAINT ai_evaluation_signals_kind_check;

ALTER TABLE ai_evaluation_signals
  ADD CONSTRAINT ai_evaluation_signals_kind_check
  CHECK (kind IN ('ai_error','tool_limit'));

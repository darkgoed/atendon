-- 0195: Google Agenda — PKCE no OAuth e credencial revogada observável.
--   * code_verifier (PKCE S256) guardado junto ao nonce one-time; NULL para
--     states criados antes desta migração (callback segue sem PKCE nesse caso).
--   * auth_error: o Google recusou a renovação (invalid_grant — acesso
--     revogado, senha trocada, token expirado). Enquanto preenchido, o worker
--     de sync e a reconciliação não chamam o Google com essa conexão (falha
--     observável, sem retry eterno), a checagem de disponibilidade falha
--     fechada (502) e o painel pede reconexão; a reconexão limpa o campo.
ALTER TABLE scheduling_calendar_oauth_states
  ADD COLUMN IF NOT EXISTS code_verifier TEXT;

ALTER TABLE scheduling_calendar_connections
  ADD COLUMN IF NOT EXISTS auth_error TEXT,
  ADD COLUMN IF NOT EXISTS auth_error_at TIMESTAMPTZ;

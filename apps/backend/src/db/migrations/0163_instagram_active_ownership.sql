-- Ownership of an Instagram account is enforced globally while the connection
-- is active: exactly one active row may hold a given provider_account_id, so a
-- second tenant can never claim a live webhook stream. Archived rows hold no
-- credentials and are never routed (resolveAccount requires active rows), so
-- keeping them inside the unique index only locked a disconnected account to
-- its former tenant forever — an owner/admin who disconnected the account could
-- never connect it anywhere else, including the same tenant after the row was
-- pruned. Ownership now applies to active rows only; an archived row in the
-- same tenant is still revived first so reconnection preserves history.

DROP INDEX IF EXISTS uq_instagram_provider_account_global;

CREATE UNIQUE INDEX uq_instagram_provider_account_global
  ON whatsapp_sessions(provider_account_id)
  WHERE channel='instagram' AND provider_account_id IS NOT NULL AND archived_at IS NULL;

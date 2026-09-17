-- Indexes for the paginated list surfaces (/leads, /pipeline, /conversations).
-- All four were verified against EXPLAIN ANALYZE on the production-shaped
-- queries before/after (see perf audit 2026-09):
--
-- 1) The /scheduling/leads payload laterals match conversations by
--    regexp_replace(contact_phone,'\D','','g') = regexp_replace(l.phone,...).
--    Without an index on the conversation side each lateral seq-scanned the
--    whole tenant's conversations once per lead row (~2.6k scans per request).
--    The leads side already has uq_scheduling_leads_tenant_normalized_phone.
-- 2) latest_appointment lateral orders by start_at DESC over ALL statuses
--    (the existing indexes are partial on active statuses only), so it
--    seq-scanned scheduling_appointments once per lead row.
-- 3) /conversations orders by (last_message_at, id) with a status equality
--    filter on every request; keyset pagination needs this exact order.
-- 4) /scheduling/leads orders by (updated_at, id) for keyset pagination.
-- 5) unread-count lateral probes messages per conversation filtered to
--    sender='contact'; the partial index makes those probes index-only.

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_norm_phone
  ON conversations (tenant_id, regexp_replace(contact_phone, '\D', '', 'g'))
  WHERE regexp_replace(contact_phone, '\D', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_lead_latest
  ON scheduling_appointments (tenant_id, lead_id, start_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status_last_message
  ON conversations (tenant_id, status, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_keyset
  ON scheduling_leads (tenant_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_contact_unread
  ON messages (conversation_id, created_at DESC, id DESC)
  WHERE sender = 'contact';

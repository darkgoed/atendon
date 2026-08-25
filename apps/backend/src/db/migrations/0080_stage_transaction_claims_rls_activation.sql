-- Keep the policy installed, but stage enforcement as an explicit deploy step.
-- This preserves compatibility during the short migration -> process restart
-- window: the previous artifact does not set app.tenant_id yet.
--
-- After every API/worker instance runs the tenant transaction helper, enable
-- the pilot with the migration role as documented in
-- docs/runbooks/transaction-claims-rls-pilot.md.
ALTER TABLE agent_message_transaction_claims DISABLE ROW LEVEL SECURITY;

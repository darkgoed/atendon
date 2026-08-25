ALTER TABLE agent_message_transaction_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_message_transaction_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_message_transaction_claims_tenant_isolation
  ON agent_message_transaction_claims;

CREATE POLICY agent_message_transaction_claims_tenant_isolation
ON agent_message_transaction_claims
USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

ALTER TABLE billing_dunning_attempts DROP CONSTRAINT IF EXISTS billing_dunning_attempts_status_check;
ALTER TABLE billing_dunning_attempts ADD CONSTRAINT billing_dunning_attempts_status_check CHECK (status IN ('CLAIMED','PENDING','SUCCEEDED','FAILED'));

-- Reject ambiguous webhook identities before enforcing the database invariant.
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  SELECT count(*)::integer INTO duplicate_count
  FROM (
    SELECT provider_id, external_id
    FROM payments
    WHERE external_id IS NOT NULL
      AND provider_id IS NOT NULL
    GROUP BY provider_id, external_id
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'payment identity constraint blocked: % duplicate key group(s)', duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX uq_payments_provider_external_id
  ON payments (provider_id, external_id)
  WHERE external_id IS NOT NULL AND provider_id IS NOT NULL;

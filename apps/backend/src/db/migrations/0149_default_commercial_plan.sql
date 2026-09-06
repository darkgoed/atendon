-- Plano comercial padrão é dado, não literal no runtime.
--
-- Migration aditiva e compatível: nenhum tenant/subscription existente muda.
-- Em instalações existentes, escolhe deterministicamente o plano público ativo
-- de menor posição/preço; o seed atual resulta em BASIC, mas o código da
-- aplicação não conhece esse nome. Operadores podem trocar o padrão por dados.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

WITH chosen AS (
  SELECT id
  FROM plans
  WHERE status = 'active'
    AND is_internal = false
    AND monthly_price_cents > 0
  ORDER BY position ASC, monthly_price_cents ASC, id ASC
  LIMIT 1
)
UPDATE plans p
SET is_default = true,
    updated_at = now()
FROM chosen c
WHERE p.id = c.id
  AND NOT EXISTS (SELECT 1 FROM plans WHERE is_default = true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_single_default
  ON plans ((is_default))
  WHERE is_default = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plans_default_must_be_public_active'
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_default_must_be_public_active
      CHECK (NOT is_default OR (status = 'active' AND is_internal = false AND monthly_price_cents > 0));
  END IF;
END $$;

-- O layout persiste todas as chaves, inclusive as ocultas. A biblioteca ampliada
-- precisa de até 60 itens sem relaxar a exigência de um array JSONB.
-- ROLLBACK: remover dashboard_layouts_items_length_check e restaurar o CHECK <= 20.
ALTER TABLE dashboard_layouts
  DROP CONSTRAINT IF EXISTS dashboard_layouts_items_check1;

-- Remove qualquer CHECK de comprimento legado pela definição, sem depender do
-- nome que o PostgreSQL gerou na instalação original. O CHECK de tipo é mantido.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'dashboard_layouts'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%jsonb_array_length%'
  LOOP
    EXECUTE format('ALTER TABLE dashboard_layouts DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE dashboard_layouts
  ADD CONSTRAINT dashboard_layouts_items_length_check
  CHECK (
    CASE
      WHEN jsonb_typeof(items) = 'array' THEN jsonb_array_length(items) <= 60
      ELSE false
    END
  );

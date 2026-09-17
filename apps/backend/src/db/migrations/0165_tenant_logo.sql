-- Logo da empresa (tenant) exibida no seletor do sidebar
-- (specs/active/logo-tenant-sidebar.md, R1). Armazena a imagem como data URL
-- base64 (image/png|jpeg|webp) na própria tabela tenants — padrão do codebase
-- para mídia pequena, sem rota/CDN de arquivos. NULL significa sem logo, e o
-- painel usa a inicial do workspace como fallback. Aditiva e idempotente.
-- ROLLBACK: ALTER TABLE tenants DROP COLUMN logo_data;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_data TEXT;

COMMENT ON COLUMN tenants.logo_data IS
  'Logo da empresa como data URL base64 (image/png, image/jpeg ou image/webp); NULL = sem logo';

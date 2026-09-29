-- Requisitos de encerramento por empresa (FASE "CRM não obrigatoriamente
-- comercial"): quais dados são obrigatórios para fechar um lead. Por padrão
-- TODOS os campos continuam obrigatórios (compatibilidade total com o
-- comportamento atual); a empresa não-comercial (suporte/atendimento) pode
-- desligar campos de venda e fechar o ciclo sem valor/produto.
CREATE TABLE IF NOT EXISTS tenant_closing_requirements (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  require_sale_value BOOLEAN NOT NULL DEFAULT true,
  require_sale_product BOOLEAN NOT NULL DEFAULT true,
  require_sale_channel BOOLEAN NOT NULL DEFAULT true,
  require_sale_source BOOLEAN NOT NULL DEFAULT true,
  require_responsavel BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

import type { PoolClient } from "pg";

/**
 * Requisitos de encerramento por empresa (CRM não obrigatoriamente comercial).
 * Define quais dados são exigidos para fechar um lead. O padrão do produto é
 * tudo obrigatório (compatibilidade com o comportamento histórico e com
 * pipelines comerciais); uma empresa de suporte/atendimento pode desligar
 * `require_sale_value` etc. e concluir o ciclo sem dados de venda.
 */
export interface ClosingRequirements {
  requireSaleValue: boolean;
  requireSaleProduct: boolean;
  requireSaleChannel: boolean;
  requireSaleSource: boolean;
  requireResponsavel: boolean;
}

export const DEFAULT_CLOSING_REQUIREMENTS: ClosingRequirements = {
  requireSaleValue: true,
  requireSaleProduct: true,
  requireSaleChannel: true,
  requireSaleSource: true,
  requireResponsavel: true
};

export async function getClosingRequirements(client: PoolClient, tenantId: string): Promise<ClosingRequirements> {
  const result = await client.query<ClosingRequirements>(
    `SELECT require_sale_value "requireSaleValue",
            require_sale_product "requireSaleProduct",
            require_sale_channel "requireSaleChannel",
            require_sale_source "requireSaleSource",
            require_responsavel "requireResponsavel"
     FROM tenant_closing_requirements WHERE tenant_id=$1`,
    [tenantId]
  );
  return result.rows[0] ?? DEFAULT_CLOSING_REQUIREMENTS;
}

import useSWR from "swr";
import { api } from "./api";

/**
 * Requisitos de encerramento por empresa (GET /workspaces/current/closing-
 * requirements). Padrão do produto = tudo obrigatório (compatibilidade com
 * pipelines comerciais); uma empresa de suporte/atendimento desliga campos
 * de venda e fecha o ciclo sem eles. Enquanto carrega, valem os defaults
 * conservadores do produto.
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

export function useClosingRequirements(): ClosingRequirements {
  const { data } = useSWR(
    "/workspaces/current/closing-requirements",
    (url: string) => api<{ closingRequirements: ClosingRequirements }>(url),
    { revalidateOnFocus: false, dedupingInterval: 30_000 }
  );
  return data?.closingRequirements ?? DEFAULT_CLOSING_REQUIREMENTS;
}

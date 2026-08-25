export type LeadFilters = {
  status: string; unidade_id: string; categoria_id: string; parceiro_id: string; busca: string;
  estrelas: string; fila_humana: string;
  faturamento?: string; resultado?: string; investimento?: string; formulario?: string;
};

export function buildLeadFilterQuery(filters: LeadFilters): string {
  const entries = Object.entries(filters)
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
  return new URLSearchParams(entries).toString();
}

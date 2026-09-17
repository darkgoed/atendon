const populated = (heading, marker, entitySelector) => ({ expectedPath: null, heading, marker, entitySelector, state: "populated" });

// Root/workspace contracts use semantic headings and seeded table/card selectors;
// never accept body text or generic content containers as proof of rendering.
export const ROOT_ROUTE_CONTRACTS = {
  "/root/audit": populated("Auditoria ROOT", "workspace.viewed|AtendON QA", "table tbody tr"),
  "/root/workspaces": populated("Workspaces", "AtendON QA Workspace|atendon-qa", "table tbody tr"),
  "/root/saas/billing": populated("Operações de billing", "FAILED|qa-dunning-0001", "table tbody tr"),
  "/root/billing/dunning": populated("Operações de billing", "FAILED|qa-dunning-0001", "table tbody tr"),
  "/root/billing/metrics": populated("Métricas SaaS", "Receita|Empresas", "dl.kpi-grid .kpi-card"),
  "/root/saas/metricas": populated("Métricas SaaS", "Receita|Empresas", "dl.kpi-grid .kpi-card"),
  "/root/saas/gateways": populated("Gateways", "Mercado Pago|Sandbox", "article.card"),
  "/root/saas/planos": populated("Planos e cobrança", "Profissional|STARTER", "table tbody tr"),
  "/workspace/members": populated("Membros", "Ana QA|Bruno QA", "table tbody tr"),
  "/workspace/roles": populated("Funções e permissões", "Administrador|Operador", ".admin-list-item"),
  "/workspace/audit": populated("Auditoria do workspace", "workspace.viewed|AtendON QA", "table tbody tr"),
  "/uso": populated("Uso", "Total usado|Histórico mensal", "section.card")
};
export function rootContractFor(route) { return ROOT_ROUTE_CONTRACTS[route]; }

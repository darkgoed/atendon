"use client";

/**
 * Upsell do §7: recurso bloqueado aparece explicando o plano necessário, em vez
 * de sumir da interface.
 *
 * Não há CTA para checkout: a venda self-service está fora do escopo desta etapa
 * (§43). O ROOT administra planos em /root/saas/planos, rota que um usuário comum
 * não acessa — por isso não linkamos para lá.
 */
export function FeatureLocked({ featureName, requiredPlans }: { featureName: string; requiredPlans: readonly string[] }) {
  const plans = requiredPlans.length ? requiredPlans.join(", ") : "um plano superior";
  return <section className="panel" aria-label={`${featureName} indisponível`}>
    <h2 className="cardtitle"><span>{featureName}</span></h2>
    <p className="sub">Disponível a partir do plano {plans}.</p>
    <p className="sub">Fale com o responsável pela sua conta para liberar este recurso.</p>
  </section>;
}

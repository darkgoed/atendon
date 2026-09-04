export function featureNotAvailableError(featureKey: string, requiredPlans: string[]): Error {
  return Object.assign(new Error("Este recurso não está disponível no seu plano atual. Faça upgrade para continuar."), {
    statusCode: 403, code: "FEATURE_NOT_AVAILABLE", feature: featureKey, details: { requiredPlans }
  });
}

export function planLimitReachedError(limitKey: string, current: number, max: number, planName: string): Error {
  const labels: Record<string, string> = { MAX_USERS: "usuários", MAX_WHATSAPP_CONNECTIONS: "conexões do WhatsApp", MAX_AI_INTERACTIONS: "interações de IA" };
  const label = labels[limitKey] ?? limitKey.toLowerCase().replaceAll("_", " ");
  return Object.assign(new Error(`Você atingiu o limite de ${max} ${label} do seu plano.`), {
    statusCode: 409, code: "PLAN_LIMIT_REACHED", details: { limit: limitKey, current, max, planName }
  });
}

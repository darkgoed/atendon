const LIMIT_LABELS: Record<string, string> = {
  MAX_USERS: "usuários",
  MAX_WHATSAPP_CONNECTIONS: "conexões do WhatsApp",
  MAX_AI_INTERACTIONS: "interações de IA"
};

type BusinessError = { code?: string; details?: Record<string, unknown> };

export function translatePlanError(input: BusinessError | string | unknown): string {
  const value = typeof input === "object" && input !== null ? input as BusinessError : {};
  const details = value.details ?? {};
  if (value.code === "PLAN_LIMIT_REACHED") {
    const limit = String(details.limit ?? "recurso");
    const current = details.current ?? details.max ?? "0";
    const max = details.max ?? current;
    const label = LIMIT_LABELS[limit] ?? limit.toLowerCase().replaceAll("_", " ");
    return `Você atingiu o limite de ${max} ${label} do seu plano.\nPlano atual: ${String(details.planName ?? "atual")}\nUso: ${current}/${max}\nPara adicionar novos ${label}, aumente seu limite ou faça upgrade.`;
  }
  if (value.code === "FEATURE_NOT_AVAILABLE") {
    const plans = Array.isArray(details.requiredPlans) ? details.requiredPlans.map(String).join(", ") : "um plano superior";
    return `Esta funcionalidade está disponível a partir do plano ${plans}. Faça upgrade para continuar.`;
  }
  return "Não foi possível concluir esta operação. Tente novamente.";
}

export const friendlyPlanError = translatePlanError;

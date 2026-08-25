export function parseNewaveKeywords(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function validateNewaveActivation(input: {
  active: boolean;
  ctwa: boolean;
  sessionIds: string[];
  keywords: string[];
}): string | null {
  if (!input.active) return null;
  if (!input.ctwa && !input.sessionIds.length && !input.keywords.length) return "Configure ao menos um gatilho antes de ativar.";
  return null;
}

export function buildNewaveFlowPayload(input:{
  active:boolean;ctwa:boolean;sessionIds:string[];keywords:string[];
}) {
  return {
    nome:"Fluxo Newave",ativo:input.active,
    ctwa:input.ctwa,sessoes:input.sessionIds,palavras_chave:input.keywords
  };
}

// Route contracts for settings surfaces; selectors target rendered entities, not guessed text.
const populated = (heading, marker, entitySelector) => ({ state: "populated", heading, marker, entitySelector });

export const SETTINGS_OPTIONAL_CONTRACTS = {
  // /configuracoes (raiz) renderiza o painel Geral do workspace (fuso + horário de
  // atendimento), NÃO a aba Categorias (essa é /configuracoes/[resource]). Marker =
  // valores semeados em /workspaces/current/timezone (inputs value; estados iniciais vazios).
  "/configuracoes": populated("Configurações", "Fuso horário|America/Sao_Paulo", "section[aria-labelledby='settings-workspace'], form"),
  "/conexao": populated("Conexão", "Operação comercial São Paulo|connected", ".connection-card, article"),
  "/agente": populated("Agente principal", "Atenda com clareza|openai/gpt-4o-mini", "textarea#agent-system-prompt, select"),
  // Sufixo "(?: ?\?)?" = HelpHint ("?") renderizado DENTRO do h1 (textContent
  // inclui " ?"); identidade do título preservada — nada além do sufixo é aceito.
  "/follow-ups": populated("Follow-ups(?: ?\\?)?", "Atraso|mídias|120", ".channels-ai-page, input"),
  "/humanizacao": populated("Humanização", "900|2600", "form .line-section, form"),
  "/alertas": populated("Alertas operacionais(?: ?\\?)?", "Conexão verificada", "section[aria-label='Histórico de alertas']"),
  "/perfil": populated("Perfil", "qa@example.test|QA Operador", "input[type=email], form"),
  "/pos-venda": populated("Carteira de pós-venda", "Marina QA · Cliente de implantação empresarial|Confirmar treinamento de implantação", ".post-sales-client-row"),
  "/pos-venda/configurar": populated("Configurar checklist", "Confirmar cadastro e dados da empresa|Agendar treinamento de implantação para a equipe", ".post-sales-template-section, .post-sales-template-main"),
  "/pos-venda/cobranca": populated("Cobranças de crediário", "Cliente QA|199", "table tbody tr, article"),
  "/uso": populated("Uso", "Total usado|42|Histórico mensal", "[role=tab], table tbody tr, .card")
};

export function optionalSettingsContractFor(route) {
  return SETTINGS_OPTIONAL_CONTRACTS[route];
}

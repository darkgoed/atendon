const entitySelectors = {
  "/": "main > section",
  "/agenda": "main [aria-label*='agenda' i], main [data-testid*='agenda' i]",
  "/conversas": "main [aria-label='Lista de conversas'], main [aria-label^='Histórico da conversa com']",
  "/contatos": "main .leads-table tbody tr",
  "/contatos/[id]": "main [aria-labelledby='internal-notes-title'], main [aria-labelledby='qualification-title']",
  "/pipeline": "main [aria-label='Quadro de pipeline']",
  "/configuracoes": "main [aria-label*='configuração' i], main [aria-label*='configuração' i]",
  "/agenda": "main [aria-label*='agenda' i], main [data-testid*='agenda' i]"
};
const populated = (heading, marker, route) => ({ expectedPath: null, heading, marker, headingRole: "heading", entitySelector: entitySelectors[route] ?? "main > section", state: "populated" });
// Rotas aninhadas do hub /configuracoes (layout com SettingsSidebar +
// SettingsDestinationAccess). São aliases das páginas originais — MESMOS
// componentes de conteúdo — então os valores espelham os contratos EFETIVOS
// das rotas de origem (contracts-root/optionalcontracts-settings sobrescrevem
// a base nelas; estas chaves novas só existem aqui). Seletores profundos
// permanecem válidos dentro do wrapper section.settings-main; markers intactos.
const nested = (heading, marker, entitySelector) => ({ expectedPath: null, heading, marker, headingRole: "heading", entitySelector, state: "populated" });
export const ROUTE_CONTRACTS = {
  "/": populated("Visão geral|Minha operação", "Dashboard de reuniões|Mariana Oliveira", "/"),
  "/agenda": populated("Agenda", "Reunião Cliente QA|qa-appt|Cliente QA", "/agenda"),
  "/agente": populated("Agente principal", "Agente QA|active", "/agente"),
  "/alertas": populated("Alertas operacionais", "Conexão verificada|qa-alert", "/alertas"),
  "/conexao": populated("Conexão", "qa-connection|connected|WhatsApp", "/conexao"),
  "/configuracoes": populated("Configurações", "AtendON QA|qa-cat|whatsapp", "/configuracoes"),
  // [resource] dinâmico: routeReplacements → /configuracoes/categorias; contrato
  // equivalente ao EFETIVO de /configuracoes (o deep-link renderiza a aba Categorias).
  // Sufixos nos headings: HelpHint renderizado DENTRO do h1 — textContent inclui
  // " ?" e o nome acessível inclui o aria-label do botão ("Ajuda: <título>").
  // O sufixo permitido é sempre o do próprio h1 — nada genérico.
  "/configuracoes/[resource]": nested("Configurações", "qa-category-0001|Consultoria empresarial premium", "section[aria-label='Categorias'] tbody tr"),
  "/configuracoes/agente": nested("Agente principal", "Atenda com clareza|openai/gpt-4o-mini", "textarea#agent-system-prompt, select"),
  "/configuracoes/alertas": nested("Alertas operacionais(?: ?\\?)?(?:\\s*Ajuda: Alertas operacionais)?", "Conexão verificada", "section[aria-label='Histórico de alertas']"),
  "/configuracoes/auditoria": nested("Auditoria do workspace(?: ?\\?)?(?:\\s*Ajuda: Auditoria do workspace)?", "workspace.viewed|AtendON QA", "table tbody tr"),
  "/configuracoes/conexao": nested("Conexão", "Operação comercial São Paulo|connected", ".connection-card, article"),
  "/configuracoes/follow-ups": nested("Follow-ups(?: ?\\?)?(?:\\s*Ajuda: Follow-ups)?", "Atraso|mídias|120", ".channels-ai-page, input"),
  "/configuracoes/funcoes": nested("Funções e permissões", "Administrador|Operador", ".admin-list-item"),
  "/configuracoes/humanizacao": nested("Humanização", "900|2600", "form .line-section, form"),
  "/configuracoes/membros": nested("Membros", "Ana QA|Bruno QA", "table tbody tr"),
  "/configuracoes/uso": nested("Uso", "Total usado|Histórico mensal", "section.card"),
  "/conversas": populated("Conversas|Minhas conversas", "Marina QA|Preciso confirmar|qa-conversation", "/conversas"),
  "/follow-ups": populated("Follow-ups", "Retornar contato|qa-followup", "/follow-ups"),
  "/humanizacao": populated("Humanização", "professional|Timing", "/humanizacao"),
  "/contatos": populated("Contatos", "Cliente QA com nome comercial deliberadamente longo", "/contatos"),
  "/contatos/[id]": { expectedPath: null, heading: "Cliente QA com nome comercial deliberadamente longo", headingRole: "heading", marker: "Notas internas", entitySelector: "[aria-labelledby='lead-notes-title']", state: "populated" },
  "/pipeline": populated("Pipeline", "Cliente QA com nome comercial deliberadamente longo", "/pipeline"),
  "/pos-venda": populated("Carteira de pós-venda", "Marina QA · Cliente de implantação empresarial|Confirmar treinamento de implantação", "/pos-venda"),
  "/pos-venda/cobranca": populated("Cobranças de crediário", "Cliente QA|qa-debt", "/pos-venda/cobranca"),
  "/pos-venda/configurar": populated("Configurar checklist", "Confirmar cadastro|Agendar treinamento", "/pos-venda/configurar"),
  "/tripz-ai": { expectedPath: null, heading: "Roteiro QA", headingRole: "heading", marker: "Roteiro QA|Roteiro QA pronto para revisão", entitySelector: "section[aria-label^='Conversa ']", state: "populated" },
  "/uso": populated("Uso", "Conversas|42|Profissional", "/uso"),
  "/workspace/audit": populated("Auditoria do workspace", "workspace.viewed|qa-log", "/workspace/audit"),
  "/workspace/members": populated("Membros", "Ana QA|ana@example.test", "/workspace/members"),
  "/workspace/roles": { expectedPath: null, heading: "Funções e permissões", headingRole: "heading", marker: "Administrador|Operador", entitySelector: ".admin-list-item", state: "populated" },
  "/root/audit": populated("Auditoria ROOT", "workspace.viewed|qa-log", "/root/audit"),
  "/root/saas/billing": populated("Operações de billing", "qa-invoice|Tenant ID", "/root/saas/billing"),
  "/root/saas/gateways": populated("Gateways", "Stripe Test|sandbox", "/root/saas/gateways"),
  "/root/saas/metricas": populated("Métricas SaaS", "Receita|Transações|Tenant ID", "/root/saas/metricas"),
  "/root/versions": { expectedPath: null, heading: "Versões e changelogs", headingRole: "heading", marker: "v2\\.1\\.0|qa-release|Release \\(major\\)", entitySelector: "table tbody tr", state: "populated" },
  // F6a: /changelog virou "Novidades" (feed editorial global + read-state por
  // usuário). Marker = título do post semeado no fixture /panel/changelog/feed.
  "/changelog": { expectedPath: "/changelog", heading: "Novidades", headingRole: "heading", marker: "Novidades de setembro no AtendON", entitySelector: "main .card", state: "populated" },
  "/privacidade": { expectedPath: "/privacidade", heading: "Política de privacidade", headingRole: "heading", marker: "privacidade|dados", entitySelector: "main", state: "public" },
  "/termos": { expectedPath: "/termos", heading: "Termos de uso", headingRole: "heading", marker: "termos|usuário", entitySelector: "main", state: "public" },
  "/root/saas/planos": populated("Planos e cobrança", "Profissional|qa-plan", "/root/saas/planos"),
  "/root/workspaces": populated("Workspaces", "AtendON QA Workspace|qa-workspace-0001", "/root/workspaces"),
  "/perfil": populated("Perfil", "qa@example.test|QA Operador", "/perfil"),
  "/alterar-senha": { expectedPath: "/alterar-senha", heading: "Crie uma nova senha", headingRole: "heading", marker: "nova senha", entitySelector: "main > section", state: "public" },
  "/403": { expectedPath: "/403", heading: "Você não tem permissão para abrir esta área\\.", headingRole: "heading", marker: "permissão para abrir esta área", entitySelector: ".denied-card", state: "error" },
  "/offline": { expectedPath: "/offline", heading: "Sem conexão no momento", headingRole: "heading", marker: "conexão", entitySelector: "main > section", state: "error" },
  // D1-r2 (drift-check): "main > section" pegava a seção hero (marketing) — o
  // formulário de login (E-mail/Senha) vive em <form> dentro de main. O runner
  // não pegava isso porque estado "public" não valida entity no measure().
  "/login": { expectedPath: "/login", heading: "Boas-vindas", headingRole: "heading", marker: "senha|e-mail|email", entitySelector: "main form", state: "public" },
  "/convite": { expectedPath: "/convite", heading: "Aceitar convite", headingRole: "heading", marker: "AtendON QA Workspace|guest@example.test", entitySelector: ".invitation-summary", state: "public" },
  "/invitations/[token]": { expectedPath: "/invitations/qa-token", heading: "Aceitar convite", headingRole: "heading", marker: "AtendON QA Workspace|guest@example.test|Operador", entitySelector: ".invitation-summary", state: "public" },
  // R5 (Astra): estado expected-error — o 503 do provedor é o comportamento
  // CORRETO em QA. O registro nunca recebe status "passed" (o runner marca
  // "expected-error"); a variante "#sucesso" (mock do provedor no harness) é
  // quem audita o estado funcional e pode receber "passed".
  "/meet/[roomId]": { expectedPath: "/meet/qa-room", heading: "Não foi possível entrar na sala", headingRole: "heading", marker: "Não foi possível entrar na sala|Falha na conexão", entitySelector: "main [role=alert]", state: "expected-error" },
  "/reuniao/[code]": { expectedPath: "/reuniao/qa-code", heading: "Não foi possível entrar na sala", headingRole: "heading", marker: "Não foi possível entrar na sala|Falha na conexão", entitySelector: "main [role=alert]", state: "expected-error" },
  // Variantes de SUCESSO (mock do provedor: token 200 + stub de window.JitsiMeetExternalAPI
  // servido como /external_api.js). A página entra em phase "ready" e o stub renderiza
  // texto exclusivo dentro de .meet-room__frame. headingOptional: o MeetRoom em ready
  // não renderiza h1/h2 próprios (achado R2 — repasse ao D2 em design-spec-review).
  "/meet/[roomId]#sucesso": { expectedPath: "/meet/qa-room", heading: null, headingOptional: true, marker: "Sala QA pronta", entitySelector: "main .meet-room__frame", state: "populated" },
  "/reuniao/[code]#sucesso": { expectedPath: "/reuniao/qa-code", heading: null, headingOptional: true, marker: "Sala QA pronta", entitySelector: "main .meet-room__frame", state: "populated" },
  "/agente/figurinhas": { expectedPath: "/follow-ups", heading: "Follow-ups", headingRole: "heading", marker: "Atraso|mídias|120", entitySelector: ".channels-ai-page, form, input", state: "populated" },
  // R5 (Astra): marker exclusivo da task Semeada (fixture panels-v6.mjs: task.title
  // = "Tarefa QA", renderizado como h3 dentro de article[data-task-id]). O marker
  // antigo ("Prioridade") aparece em qualquer card e não prova seeding.
  "/tarefas": { expectedPath: null, heading: "Tarefas", headingRole: "heading", marker: "Tarefa QA", entitySelector: "main article[data-task-id]", state: "populated" },
  "/contatos/campos": { expectedPath: null, heading: "Campos personalizados", headingRole: "heading", marker: "chave:", entitySelector: "main article[data-field-id]", state: "populated" },
  "/contatos/lixeira": { expectedPath: null, heading: "Lixeira", headingRole: "heading", marker: "Excluído em", entitySelector: "main article[data-trash-id]", state: "populated" },
  "/contatos/importar": { expectedPath: null, heading: "Importar contatos", headingRole: "heading", marker: "Histórico de importações", entitySelector: "main [aria-labelledby='import-history-title']", state: "populated" },
  "/fluxos": { expectedPath: null, heading: "Fluxos", headingRole: "heading", marker: "Fluxo QA de qualificação", entitySelector: "main .card ul li", state: "populated" },
  "/fluxos/[id]": { expectedPath: "/fluxos/qa-flow-0001", heading: "Fluxo QA de qualificação", headingRole: "heading", marker: "Olá QA", entitySelector: "main .react-flow__node", state: "populated" },
  // R1(a): estado de rota not-found.tsx audita como ENTRADA PRÓPRIA — o runner
  // navega para uma URL inexistente; Next responde HTTP 404 e renderiza este UI.
  "/__not-found": { expectedPath: "/__rota-audit-inexistente", heading: "Não encontramos esta página\\.", headingRole: "heading", marker: "Erro 404|Não encontramos", entitySelector: "main .denied-card", state: "not-found" }
};
export function contractFor(route) { return ROUTE_CONTRACTS[route]; }

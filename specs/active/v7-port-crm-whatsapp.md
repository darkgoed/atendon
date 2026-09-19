# SPEC: v7-port-crm-whatsapp — Port seletivo do CRM legado (fidelidade visual + features aprovadas)

## Objective
Transplantar para o AtendON o que o crm-whatsapp (donor) faz e o AtendON ainda não tem, com fidelidade visual quase 1:1 NOS ITENS PORTADOS, sem transformar o AtendON em clone estrutural do donor e sem reestilizar telas existentes fora do escopo. AtendON é fonte da verdade de produto, rotas, permissões e regras.

## Source
Sessão grilling 2026-09-18 (Q1–Q24 fechados pelo usuário). Inventários e matriz: /tmp/migracao-crm-visual/{inventory-crm.md, inventory-atendon.md, features-crm.md, matriz.md, decisoes.md}. Donor: /var/www/apps/crm-whatsapp/frontend (Next.js 16/Tailwind4/shadcn/lucide; live crm.alpdash.com.br). SPEC precedente: specs/active/v6-evolucao-estrutural-atendon.md (port B2B já executado; migrations 0167–0175 aplicadas).

## Premissas fechadas (não reabrir)
1. Donor é referência VISUAL e funcional apenas; AtendON vence em qualquer conflito (funcionalidades, regras, dados, permissões).
2. Escopo seletivo: SÓ os itens aprovados na matriz (abaixo). Nenhuma tela AtendON é reestilizada "para ficar parecida" — features são adicionadas; visual 1:1 só no que for portado, no desktop ≥1280px (breakpoint do donor).
3. Cores/adaptação sempre via tokens AtendON; proibido copiar Tailwind/CSS do donor cegamente; token global compartilhado que cause regressão fora do port ⇒ criar domain CSS novo (ex.: styles/domains/…), nunca mexer em tokens.css global para "consertar" o port.
4. NavRail+ContextPanel é port visual GLOBAL da navegação (exceção aprovada): manifest (hrefs/labels/match/gating) INTACTO como fonte de dados; 24 itens adaptados à linguagem do rail; a mudança de shell NÃO refatora conteúdo interno de rotas.
5. DARK segue default; light/dark + animação de onda preservados; preferências por usuário (tema/densidade/accent) continuam aplicando.
6. Ícones: lucide-react (dep nova permitida no panel) onde o donor define o visual; labels/semântica AtendON.
7. Tipografia: Schibsted Grotesk NÃO é troca automática. Onda 1 abre com MEDIÇÃO de impacto (screenshots Geist vs Schibsted nas rotas auditadas); se o impacto global for grande ⇒ introduzir a fonte apenas no domain do novo shell (font-family no .nav-rail/.context-panel/etc.); troca global de --font-sans só como PR separado intencional. JetBrains Mono segue o mesmo critério.
8. Escala/densidade: valores COMPUTADOS do donor mapeados nos tokens existentes (sem root 14px, sem reescala global).
9. Login/públicas: fora.
10. Verificação: screenshots lado a lado + measure-elements ±2px SOMENTE nas telas/componentes portados; pixel-diff é triagem, não gate; suítes sempre verdes.
11. Execução por ondas: 1 shell → 2 features ausentes → 3 parciais/fidelidade → 4 reconciliação/QA. Workers com posse exclusiva de arquivos; app.ts é do orquestrador.

## REGRA ARQUITETURAL WhatsApp (steer fechado)
- Automação/Robô e qualquer feature nova NUNCA conhecem provider (Evolution/Cloud) diretamente: consomem `MessageGateway` (apps/backend/src/modules/messages/types.ts:77) — reutilizar; capability opcional nova = método opcional `?` no gateway + flag de capability; degradar com segurança quando o provider não suportar; ZERO condicionais de provider na UI/domínio.
- FORA DE ESCOPO: refatorar motor WhatsApp; substituir Evolution por Cloud API; copiar implementação de provider do donor; reescrever envio/recebimento/sessões/conexão/QR/webhooks/filas/infra. Arquivos de integração (modules/whatsapp/*) só mudam se estritamente necessário e sem solução mais localizada — justificar na PR.
- Templates HSM / verificação Meta / qualquer fluxo Cloud-API-only: NÃO PORTAR (send_template rejeitado explicitamente em Q24).

## Matriz executável (APROVADOS)
### ONDA 1 — Shell/navegação compartilhada (painel apenas)
- NavRail 64px (ícones, tooltips à direita, ativo bg-primary/10→tokens, logo, tema, sair) + ContextPanel ~300px no /conversas (lista existente re-vestida, NÃO reescrita) + nav interna de settings no idioma do rail. Fonte de dados: lib/panel-manifest.ts INTACTO. Agrupamento: primários no rail (Visão geral, Conversas, Contatos, Pipeline, Tarefas, Fluxos, Agenda) + trigger "mais" com popover agrupando (Pós-venda, Copiloto, Administração, ROOT) — nenhum item novo, nenhuma capability nova (capabilities.test.ts intocado). Mobile <1280px: UX atual do AtendON com vocabulário visual do donor (sem replicar o drawer do donor).
- Sino de notificações internas: visual do donor (flutuante + badge + painel), DADOS continuam /me/internal-notifications (modules/internal). Sem port funcional novo.
- Impacto tipográfico medido (premissa 7) antes de qualquer --font-sans.
- Posse: apps/panel/{components/shell.tsx, components/nav-rail.tsx*, components/context-panel.tsx*, styles/domains/shell-rail.css*, styles/tokens.css(NÃO), lib/panel-manifest.ts(NÃO)}. (*=novos)
- Verificação: vitest (shell-related + novos), tsc, npm run build, design-audit local (contratos existentes não podem regredir).

### ONDA 2 — Features ausentes (backend + frontend)
Migration numbering PRÉ-ATRIBUÍDO (orchestrador): 0176 teams + workspace_members.team_id (backfill nulo); 0177 conversations.assigned_team_id; 0178 users.totp_secret/totp_enabled_at + índice p/ refresh tokens (se não existir tabela, criar workspace_sessions); 0179 flow kinds branch/finalize + flow_versions + flow_templates + flows.allowed_role_ids; 0180 organization storage retention config (settings existentes) ; 0181 lead merge (coluna leads.merged_into_id NULL) + índice; 0182 messaging capability flags (se persistido; senão derivado em runtime sem migration).

- B1 REPORTS — destino /relatorios (manifest item NOVO com requiredPermissions ["dashboard.read"], group "Administração", menu:true, SEM capability key nova):
  - GET /reports/conversation-volume?from&to → {points:[{date,total,open,closed,pending}]}
  - GET /reports/agent-productivity?from&to → {items:[{user_id,name,answered,closed,messages_sent}]}
  - GET /reports/status-flow?from&to → {items:[{status,total,avg_close_minutes}]}
  - GET /reports/quality?from&to → {idle_agents:[...], queue:{count,avg_wait_seconds,items[]}, avg_first_response:[{user_id,name,seconds}], bottlenecks:[{pipeline_id,stage_id,stage_name,contacts,avg_minutes}]}
  - Auditoria = reutilizar endpoint existente de /workspace/audit (não duplicar).
  - GET /reports/export/csv?type=volume|agents|status|quality&from&to → CSV streaming (padrão /usage/export app.ts:1164; perm dashboard.read).
  - PDF client-side jsPDF+jspdf-autotable (deps novas justificadas). Visual 1:1 do donor (5 abas + filtros de data + tabelas), charts em tokens AtendON (ui/chart.tsx), MESMA densidade.
  - Permissões: requirePermission("dashboard.read") em TODAS; tenancy em toda query.
- B2 SECURITY PACK — (b) 2FA TOTP + sessões ativas; API keys/webhook de saída FORA desta onda (roadmap futuro; deixar seção "extensões futuras" documentada no spec, NADA codado):
  - POST /me/totp/setup → {secret, otpauth_url} (não ativa); POST /me/totp/activate {code}; POST /me/totp/deactivate {current_password}; login: se totp_enabled, 2º passo {totp_code} na sessão de challenge existente (auth/session decide mecanismo; nunca quebrar login atual sem 2FA).
  - GET /me/sessions → {items:[{id,created_at,expires_at,current}]}; DELETE /me/sessions/:id (revoga refresh token); POST /me/sessions/revoke-others.
  - UI: /perfil (ou subrota de /configuracoes) com QR gerado no cliente (dep qrcode permitida), lista de sessões com revogação. Auditoria: audit() nos eventos.
- B5 MERGE DE CONTATOS — completa R11:
  - POST /organization/leads/merge/preflight {source_id,target_id} → {same_normalized_phone, conflicts:{conversations,tasks,tags,pipeline_positions,notes,custom_fields,appointments}} (contagens).
  - POST /organization/leads/merge {source_id,target_id,confirmations:{different_phone?:true}} — REGRA: mesmo telefone normalizado = fluxo normal; telefone DIFERENTE só com confirmação explícita no payload; JAMAIS merge por nome (nome irrelevante para a decisão).
  - Semântica: transação única move FKs (conversations, tasks, notes, tag assignments, pipeline positions, custom values, appointments, flow states) para o target, audita (ator, ambos os ids), marca source soft-deleted com leads.merged_into_id=target. Preserva UNIQUE(tenant_id,phone) — se conflitar, resolver via merged_into e leituras filtrando merged/deleted. Nunca perder mensagens/histórico.
  - UI: dialog 1:1 do donor (busca + seleção do principal + revisão dos conflitos + confirmar) em /contatos; usa bulk-lead-actions como ponto de entrada secundário.
- B6 TEAMS — estrutura mínima (SEM reformulação de RBAC):
  - Migration 0176/0177; CRUD GET/POST /organization/teams, PATCH/DELETE /organization/teams/:id (nome; DELETE só se sem membros ou com desassociação explícita).
  - Atribuição: conversations.assigned_team_id + atribuição por equipe nos fluxos existentes de transferência; distribuição/carga: round-robin existente ganha filtro de equipe (nunca sistema paralelo de disponibilidade); filtros: GET /conversations?team_id=, GET /scheduling/leads?team_id= (via owner→team).
  - Fluxos: action assign_to ganha team_id (opção; vazio = round-robin atual).
  - Dashboard: widget team_load EXISTENTE ganha agrupamento por equipe (extensão do dado; sem widget novo).
  - Permissão: REUSAR a key de gestão de membros do rbac.ts (executor grepa PERMISSIONS); só criar key nova se nenhuma servir — e aí, backfill 0162-pattern.
- B7 THREAD EXTRAS — features na tela existente (exceção explícita: adicionam componente, não reestilizam):
  - Presença/colisão: publicação/assinatura via lib/realtime existente (publishWorkspaceContextChange como padrão); badge de operadores ativos na conversa + aviso de colisão quando outro operador a abriu sem atribuição. Sem backend novo além do canal realtime.
  - SLA: GET /conversations/:id/sla → {first_response_seconds, waiting_since_seconds, avg_contact_response_seconds} (predicados existentes de awaiting-reply/mensagens).
  - Histórico unificado: reutilizar endpoint de conversas por contato; blocos com divisor "conversa encerrada em dd-mm-aaaa hh:mm" (visual donor).
  - Reações + encaminhar: capability-gated. Gateway: enviar reação via sendReaction?/sendReactionStrict? JÁ EXISTENTES; se o provider da sessão não implementa → flag false e UI esconde (nada de try/catch espalhado). Encaminhar: POST /conversations/:id/messages/:message_id/forward {target_conversation_id} → sendText/sendMedia(downloadMedia?) — mesma regra de flag. Mensagens reativas/encaminhadas entram no histórico como hoje (sem nova tabela; metadata mínima).
  - Atalhos de teclado: hook client-only com shouldSubmitOnEnter/compat (Safari/IME).
  - Consent center/LGPD: FORA (feature futura própria).
- B8 NOVA CONVERSA (outbound adaptado) — dialog 1:1 do donor SEM HSM:
  - POST /conversations/initiate {lead_id, session_id, text} → cria conversa + envia primeira mensagem via MessageGateway.sendText (falha do provider vira erro de UI claro; sem janela 24h/portal de template). ESQUEMA VERIFICADO (worker 2-C, migration 0152): a unique é `uq_conversations_session_phone (tenant_id, session_id, contact_phone)` — create-or-reuse com `ON CONFLICT (tenant_id,session_id,contact_phone)`; NÃO existe unique por (tenant,phone).
  - GET usa existentes: busca de leads + sessões WhatsApp ativas do tenant.
  - Entrada: botão no ContextPanel do /conversas (posição do donor).
- B9 DASHBOARD KPIs (widgets NOVOS, visual donor, sistema existente):
  - queue_waiting (fila + tempo médio — reuse contact-ops awaiting-reply), pipeline_bottlenecks (etapa c/ maior tempo médio), first_response_avg (por período/operador).
  - bot_vs_humano: SÓ SE existir fonte inequívoca (robô outcome vs turno IA nos dados atuais); sem heurística artificial — se não existir, documentar skip.
  - Widgets atuais INTACTOS; novos entram na biblioteca "Personalizar" + keys novos no modules/dashboard.
- B10 STORAGE UI — fachada da infra existente (sem regra nova):
  - GET /organization/storage/media?type&from&to&cursor → itens das 5 fontes BYTEA (keyset, dedupe por content_hash visível), DELETE /organization/storage/media (lote) reutilizando o ponto único de exclusão do worker; GET/PATCH /organization/storage/settings ganha {retention:{enabled,months}} lido pelo job diário existente (nenhum job novo).
  - UI: galeria em /configuracoes (storage) com filtros, seleção, exclusão em lote, uso/cota já exibidos.

### ONDA 3 — Parciais (completude + fidelidade)
- C1 FLUXOS (deltas APROVADOS em Q24): (a) nós branch/condition (variável + operador eq/neq/contains/not_contains/starts_with/is_empty/is_not_empty; saídas yes/no; valor oculto p/ is_*) e finalize (end_reason); executor avalia no mesmo mecanismo atual (cap 50, ciclo BFS, match exato — INTACTOS). (b) flow_versions: snapshot por ativação/salvamento, diff (nós adicionados/removidos/modificados + conexões) e restore (perm do fluxo). (c) allowed_role_ids por fluxo + menu UI + gating na execução. (d) GET /flows/:id/analytics {executions,completed,errors} do flow_execution_log (auto-refresh 30s no painel). (e) JSON dialog (client; PUT validado pelo flowDefinitionSchema; permissão específica). (f) flow_templates salvar/carregar (snapshot nomeado por tenant). (g) test run visual = camada de UX sobre o simulate existente (destaca caminho/órfãos/dead-ends no canvas; NÃO é segundo executor). (h) send_interactive capability-gated: nó interactive (buttons até 3 / list seções+linhas máx 10 / cta_url) só aparece se GET /me/messaging-capabilities reports interactive=true para a sessão; gateway ganha método OPCIONAL sendInteractive? implementado pelo Evolution client quando suportado; degradação segura (nó oculto + log executor). (i) send_template NUNCA.
- C2 TAREFAS: tipos de tarefa (enum mínimo FOLLOW_UP + genérica), audit dialog por tarefa (reutilizar audit_logs), destaque "Atrasado", edição inline — completar deltas no UI/contrato existente.
- C3 QUICK REPLIES: dicionário de placeholders clicável no CRUD (insere no cursor); verificar placeholder set (contact_name/agent_name/data) contra os resolvers existentes.
- Fidelidade visual dos componentes compartilhados que caíram em telas do port (ex.: cards de lista de conversas no ContextPanel, badges, filtros) — ±2px vs donor.

### ONDA 4 — Reconciliação/QA
- design-audit: contratos + fixtures para /relatorios e para TODA API nova chamada por rotas auditadas (Shell hidrata /me/appearance-preferences e /me/internal-notifications em todas); knownBackgrounds intocados (nenhuma mudança de token de tema global).
- vitest full + tsc + npm run build (eslint --max-warnings=0) no panel; backend tsc + fresh-migrations + testes por nome de arquivo vs baseline (.hermes/state/comments-spec-loop/).
- Reconciliador único resolve colisões de source-string tests entre módulos.

## Invariants
- Tenancy: tenant_id da sessão em toda query nova; teste de isolamento por feature com dados sensíveis (reports, sessions/totp, merge, teams, storage media).
- Autorização no backend (requirePermission); frontend só esconde.
- MessageGateway como única fronteira de provider; capabilities opcionais com flags; zero if-provider no domínio.
- Compat Safari 12–15 (lib/compat.ts; dvh → legacy-compat.css; IME-safe no composer/dialogs).
- Keyset pagination com µs-safe cursor (to_char 'US') em toda lista nova; contadores server-side; zero N+1.
- Testes que assrtam strings de source: grepar tests/ antes de editar; manter contratos de aria/roles (capabilities.test.ts NÃO ganha key nova — itens novos do menu reusam keys existentes).
- Cascade: domain CSS novo (não-layered) para o shell; sem mexer em tokens.css global além do aditivo estritamente necessário (preferir domain).
- Migrations 0176+ sequenciais, idempotentes, com -- ROLLBACK documentado; backfill de permission nova via padrão 0162 (se aplicável).
- Nada commitado/deployado sem pedido do usuário (AGENTS.md; Coolify governa deploy).

## Non-goals
- Accounts (empresa cliente) — documento como possibilidade futura (Q16). Deals/forecast — evoluir pipeline/widgets existentes se um dia fizer sentido (Q17). Consent/LGPD center. API keys + webhook de saída (roadmap futuro; só documentado). Templates HSM/send_template. Cloud API/provider do donor. Reestilização global de qualquer tela existente fora do port. Troca global de fonte sem medição (Q12). Root console/kanban/inbox do donor (AtendON superior). Second executor de fluxos. Segunda busca global. Reformulação de RBAC (Q19).

## Required Tests
- Backend (tsx scripts/run-tests.ts, focado por arquivo): reports (agregações + tenancy + export CSV), totp/sessions (ativação, login challenge, revogação), merge (preflight, conflitos, same/different phone, preservação de histórico), teams (CRUD + atribuição + filtro + assign_to de fluxo), flows (branch/finalize executor + versions diff/restore + roles + analytics + templates + capability-gate do interactive), storage media (delete lote + retenção config), initiate (gateway), dashboard (novos keys).
- Panel (vitest): nav-rail (itens/manifest/gating — capabilities.test.ts deve continuar passando SEM mudança), context-panel, reports UI (tabs + empty states), merge dialog, nova-conversa dialog, thread extras (presença badge, SLA, forward/reactions capability-gated), storage gallery, widgets novos, fluxos (branch/finalize/versions/roles/analytics/templates/test-run/source-assert greps antes).
- Isolamento tenancy: 1 teste por feature sensível.

## Definition of Done
- [ ] Ondas 1–4 entregues; matriz executável 100% coberta (nada silenciosamente cortado — skips documentados: bot_vs_humano condicional, extensões futuras)
- [ ] Donor intocado (git status de /var/www limpo para apps/crm-whatsapp)
- [ ] Fidelidade dos portados provada: screenshots lado a lado + medição ±2px arquivada em evidence/
- [ ] Gates verdes: panel (vitest/tsc/build+lint/design-audit sem regressão), backend (tsc/fresh-migrations/testes vs baseline)
- [ ] Decisões registradas (este arquivo + comments.md não tocado)

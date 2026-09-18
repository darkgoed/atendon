# SPEC: evolucao-estrutural-atendon-v6

## Objective
Evoluir o AtendON para um B2B operacional minimalista (shell referência: design_handoff_b2b), implementar 27 requisitos priorizados, pattern visual "fluxo conectado" reutilizável e portar o saudável do CRM-WhatsApp legado — preservando tenancy, permissões, dados e compatibilidade.

## Source
Goal do usuário (sessão 2026-09-18). comments.md VAZIO (não tocar). Intent completa: .hermes/state/comments-spec-loop/findings.md

## Current State (auditoria consolidada — 3 workers, evidência path:line)
- Stack backend: Fastify 5 + TS ESM + pg/BullMQ/Redis/Zod; rotas em app.ts:2800-2848; migrations 0001-0166 (próxima 0167). Stack legado CRM: NestJS+Prisma (só referência).
- VIS (shell B2B): EXISTS — sidebar 232px/56px colapsada, topbar 48px, controles 32px, manifest único (lib/panel-manifest.ts); tokens.css 3 camadas; DESIGN.md "AtendON Operate". Manter; novas telas seguem o padrão.
- PA (fluxo conectado): MISSING — nenhum conector SVG no painel; criar componente no design system.
- "Pay Oficial" = tenant de produção do legado (Nexo CRM), NÃO módulo de pagamento (zero ocorrências no código). Port = estrutura do produto (módulos que faltam), não billing — billing AtendON (0147 planos, 0133 limits) permanece.
- Legado disponível p/ port: React Flow v12 + dagre (canvas 1307l, painel de propriedades 637l, validação, test run, dry-run, versões com diff, raw JSON, templates, analytics), 11 tipos de nó, paleta/grupos, executor 899l (6 gatilhos, cap 50 passos, wait_for_reply BullMQ + processors de delay/timeout, {{var}}, resiliência a replies inesperados). MODELO DE DADOS PORTÁVEL: Flow + FlowNode (type+config Json+position) + FlowEdge (label yes/no/timeout/reply:N) + ContactFlowState (ponteiro+variables) + FlowExecutionLog (append-only) + FlowVersion (snapshot JSON). Editor = mini design system --nt-* (design_handoff_cobalto_redesign). Shell legado: NavRail 64px + ContextSidebar 300px inbox-only, main full-bleed sem topbar persistente. Lições/rot: save=delete-all+recreate quebra IDs/histórico (usar upsert-diff c/ nodeId estável), N+1 por nó (snapshot em memória), corrida resume→trigger (serializar/lock), cap 50 passos silencioso, keyword trigger substring (usar match exato), nextId/edges===0 legacy, Sidebar.tsx/flow-editor-dialog.tsx mortos, sem undo. Deps novas justificadas p/ Wave 3: @xyflow/react + @dagrejs/dagre.

## Classificação (EXISTS/PARTIAL/MISSING/REFACTOR)
- R1 notif. por usuário: PARTIAL — backend 0096 panel_notification_preferences (enabled/sound_enabled/visual_enabled por tenant,user + mutes; GET/PATCH /me/notification-preferences app.ts:661-689; push flags por evento em web-push); frontend PanelNotificationSettingsPanel (configuracoes/page.tsx:629-717). FALTA: seleção de som, volume (hardcoded 0.5 em message-notifications.tsx:29), testar som, granularidade de eventos exposta.
- R2 sino central: PARTIAL — components/notification-center.tsx (147l) no shell + lib/alerts badge; FATO: /alerts (system_alerts 0015 + receipts 0036 + projeção 0073) é RESTRITO A GESTORES (app.ts:813-816) e kinds só operational|meeting; shell DESLIGA o centro em /conversas (shell.tsx:462); sem menções/tarefas no sino. W1 cria internal_notifications user-scoped independente (não duplicar system_alerts).
- R3 comunicação interna: PARTIAL — notas em lead (0034; scheduling/routes.ts:590) e obs. de agendamento restritas a gestores (app.ts:813-816); SEM @menções, SEM notas em conversa.
- R4 armazenamento: MISSING — limites só MAX_USERS/WHATSAPP/PIPELINES/AI (billing/limits.ts:8-24; 0133:14-15); mídia sem quota (app.ts:1892/2129).
- R5 respostas rápidas "/": MISSING (sem tabela/rota; composer sem autocomplete).
- R6 tarefas: MISSING (assignments = round-robin de atendentes, não tarefas).
- R7 campos personalizados: MISSING (colunas fixas em contatos/leads).
- R8 tags+filtro: PARTIAL — lead_tags/lead_tag_assignments (0098:43-72), CRUD /organization/tags (organization/routes.ts:126-155), filtro por tag JÁ EXISTE em /scheduling/leads (scheduling/routes.ts:403-404/512-513) + saved_views; FALTA filtro por tag no inbox GET /conversations (app.ts:1533-1563). /leads do goal = app/contatos no painel.
- R9 timeline lead: PARTIAL (fontes: audit_logs 0017:73, ai_evaluation_events 0081, realtime 0077/0081, flow events; falta endpoint unificado + UI paginada).
- R10 atividades compactas: MISSING (nova visão da mesma fonte de R9).
- R11 duplicidade: PARTIAL (E.164 phone.ts:3-24 + 0097 + scripts; upsert conversa por (tenant,session,phone) messages/repository.ts:691; lead só se phone normalizado não existe; falta consolidação segura + sinalização ambígua + merge).
- R12 perfil lateral: EXISTS (app/contatos/[id] + PATCH /conversations/:id/contact) — não recriar.
- R13 busca global: MISSING (backend e painel). DECISÃO: criar UMA busca global minimalista (não há segunda; legado tinha módulo search). V1: endpoint unificado + campo no shell.
- R14 importação: MISSING. R15 exportação leads: MISSING (padrões in-house: /usage/export CSV server-side app.ts:1164-1184; exportDashboard client-side).
- R16 preferências individuais: PARTIAL (tema já persiste localmente via ThemeToggle; backend só notificações+perfil; faltam densidade/accent/som/volume persistidos por usuário; app/perfil/page.tsx:87-96).
- R17 aguardando resposta: PARTIAL — status canônico 'aguardando_resposta' (0112:31-45) + flag computada awaiting_reply (scheduling/routes.ts); falta fila no Inbox, remoção transacional ao responder e empty state.
- R18 drafts: MISSING (draft só em memória composer.tsx:88; zero localStorage/IndexedDB) — client-only, sem backend.
- R19 lixeira: MISSING (sem soft delete/restore).
- R20 onboarding: PARTIAL — lib/onboarding.ts EXISTE mas é CÓDIGO MORTO (zero usos em app/; deriva contagens de conexões/agente/catálogo, não persiste). W2: reviver estendendo com backend (GET /organization/onboarding-status derivado) e usar na Home/Dashboard; ignorar/registrar decisão sobre o código morto.
- R21 Pay/CRM port: decidido acima — portar módulos ausentes usando estrutura legado como referência.
- R22 fluxos de robô: PARTIAL/REFATOR — qualification/flow.ts:4-72 já executa fluxos determinísticos (condições/ações/upsert); SEM waits/esperas, SEM editor visual, SEM duplicar, histórico incompleto. Estender com port do legado (React Flow v12+dagre, tokens --nt-*, executor wait_for_reply BullMQ, lições 1-5). ROBÔ ≠ IA: módulo separado de ai-router/qualification-IA.
- R23 empty states/feedback: PARTIAL (Empty/LoadingCards page-state.tsx, ChartEmptyState; falta ação contextual + feedback uniforme Salvando/Salvo/Falha).
- R24 status/disponibilidade: EXISTS (0071 attendant_availability; PATCH /scheduling/attendants/me/availability routes.ts:1056-1064/:1102; consulta na alocação routes.ts:329/:352; round-robin cursors assignments/service.ts:211-278/300-328; time blocks 0119/0125). Nada a criar.
- R25 duplicar: PARTIAL — planos: POST /root/saas/plans/:id/duplicate (saas/routes.ts:24); fluxos de qualificação e pipelines: SEM endpoint. Adicionar duplicate de fluxos; não espalhar.
- R26 presets de empresa: PARTIAL — criação de empresa já copia capabilities de tenant-modelo; faltam pipeline/tags/campos/fluxos selecionados na cópia segura (whitelist).
- R27 permissões: EXISTS (capabilities backend; roles UI agrupada por módulo app/workspace/roles/page.tsx:19-41). Novas features só consomem.

## Affected Areas
- Backend: apps/backend/src/app.ts (registro 2800-2848), modules/scheduling, modules/organization, modules/messages, modules/web-push, db/migrations/0167+, capabilities/.
- Panel: components/shell.tsx, notification-center.tsx, conversation-composer.tsx, app/configuracoes/page.tsx, app/perfil/page.tsx, app/conversas/page.tsx, app/contatos/**, lib/panel-manifest.ts, styles (tokens.css, components.css — cascade unlayered).
- Legado (leitura): /var/www/apps/crm-whatsapp (automation, flow-canvas, executor, design_handoff_cobalto_redesign).

## Wave plan (ordem segura; workers com posse exclusiva de arquivos)
- WAVE 1 (fundação, paralela): W1A FlowConnect+doc+teste; W1B backend notas/menções/notificações internas/prefs som+volume/aparência (migrations 0167,0168); W1C backend tarefas/campos personalizados/lixeira soft-delete/quick replies (0169-0172); W1D frontend sino v2 + prefs UI (som/volume/eventos) + preferências UI (densidade/accent) contra contratos abaixo.
- WAVE 2: tarefas UI+manifest, campos UI+render, "/" composer, notas com menção no contato/conversa, storage quota backend(0173)+UI+enforcement, import(0174 xlsx)/export CSV server-side, lixeira UI, timeline+atividades (R9/R10), onboarding (R20), drafts hook+strip (R18), fila aguardando resposta (R17), duplicidade UI (R11), empty states (R23).
- WAVE 3: fluxos de robô (R22) — editor React Flow port + waits + histórico + duplicate (0175).
- WAVE 4: presets whitelist (R26), busca global v1 (R13), duplicate fluxos/pipelines complementos (R25), auditoria final tenancy/perm/visual, revisão independente (F8).

## Contratos de API (W1; fontes de verdade para FE/BE)
- Notificações internas: GET /me/internal-notifications?limit=30&cursor&unread → {items:[{id,type,title,body,source_type,source_id,actor_id,actor_name,read_at,created_at}], total_unread, page:{has_more,next_cursor}}; POST /me/internal-notifications/:id/read; POST /me/internal-notifications/read-all. Tipos: mention|task_assigned|note_directed|transfer|internal_message|internal_change.
- Notas internas: GET /:context(lead|conversation)/:id/notes → {items:[{id,body,author_id,author_name,mentions:[{id,name}],created_at}]}; POST idem {body, mentions:[uuid]}. Notas são append-only (sem edit/delete em v1). Reusar/absorver notas de lead existentes conforme investigação do worker (preservar dados; nunca tabela paralela órfã).
- Prefs notificação: PATCH /me/notification-preferences aceita + sound_key (string|null), volume (0-100|int|null). GET devolve.
- Aparência: GET/PATCH /me/appearance-preferences → {theme:'light'|'dark'|null, accent:string|null, density:'comfortable'|'compact'|null}.
- Tarefas: GET /tasks?scope=mine|team&status&priority&cursor; POST /tasks {title,description?,assignee_id?,due_at?,priority?,lead_id?}; PATCH /tasks/:id (status qualquer responsável; reassign/prazo/prioridade com perm tasks.assign); DELETE /tasks/:id (autor ou tasks.assign). Atribuição cria internal_notification task_assigned.
- Campos personalizados: GET/POST/PATCH/DELETE /organization/custom-fields; PUT /organization/leads/:leadId/custom-values {field_id:value}.
- Quick replies: GET /quick-replies; POST/PATCH/DELETE (criar/editar: perm de gestão a definir pela convenção existente; usar: qualquer agente lê, gestão escreve).
- Lixeira: DELETE de contato = soft (deleted_at, deleted_by); GET /trash; POST /trash/leads/:id/restore; DELETE /trash/leads/:id (permanente, gestão).
- Permissões novas seguem convenção src/capabilities (nomenclatura do arquivo); mapear para roles existentes (owner/admin sempre; manager conforme analogia de módulo).

## Desired Behavior
Ver seções R1-R27 + PA (pattern) + VIS (visual).

## Requisitos

### PA — Pattern visual "fluxo conectado" (design system)
Componente reutilizável `FlowConnect` (nome a confirmar pelo audit do panel): cards conectados por setas discretas SVG/CSS; horizontal e vertical; setas curvas em wrap; sem numeração; não wizard; usado só quando existe relação lógica.
Acceptance Criteria:
- Componente em apps/panel/components/ (ou ui/), sem dependência nova, tokens do design system.
- Renderiza A→B→C horizontal; quebra de linha com seta curva; vertical em mobile.
- Documentado na pattern library do projeto (docs/ ou design_handoff).
- Teste de render + responsividade básica.
Verification:
- npx vitest run no teste novo; visual check 360/1280px.

### R1 — Notificações por usuário (config)
Aceite: prefs por user_id (não global), on/off notif, on/off som, som selecionável, testar som, volume, por evento (nova mensagem, atribuição, transferência, tarefa, menção, agendamento, internas), persistido no backend.
Verification: PATCH persiste; outro dispositivo mantém prefs; som toca localmente (Web Audio).

### R2 — Central de notificações internas
Aceite: sino no shell, painel leve (não navega), menções/tarefas/notas direcionadas/transferências/mensagens internas/alterações, contador não lidas, marcar lida.
Verification: evento de tarefa atribuída aparece no sino; contador decresce ao ler; realtime se existir infra barata, senão poll curto.

### R3 — Comunicação interna contextual
Aceite: notas/comentários em contato, conversa e tarefa; @menção gera notificação (R2); sem chat genérico.
Verification: nota em contato com @usuario → notificação no sino do mencionado; permissão respeitada.

### R4 — Armazenamento da empresa
Aceite: aba Armazenamento em Configurações; quota por empresa (por plano se billing já modela), usado/limite exibidos; bloqueio de upload ao atingir limite (backend enforce); associação a contato/conversa; permissões; política de retenção configurável; limpeza segura (deleta bytes + referências).
Verification: upload bloqueia com erro claro ao estourar quota; usado soma anexos existentes.

### R5 — Respostas rápidas "/"
Aceite: "/" abre autocomplete no composer; filtra ao digitar; ↑↓/Tab navega; Enter seleciona e INSERE sem enviar; editável antes de enviar; variáveis {{nome}} {{atendente}} {{data}} resolvidas na inserção.
Verification: teste do composer; não envia; variáveis substituídas (nome do contato, atendente logado, data local tenant).

### R6 — Tarefas
Aceite: item "Tarefas" no menu (manifest), CRUD próprio/atribuída, contato relacionado, título/descrição/responsável/prazo/prioridade (baixa/média/alta)/status (aberta/em andamento/concluída); gerente/supervisor atribuem; atribuição gera notificação R2.
Verification: criar tarefa atribuída → aparece para o responsável; permissões aplicadas no backend.

### R7 — Campos personalizados
Aceite: CRUD de campos por empresa (texto/número/moeda/data/seleção/múltipla/sim-não), valores em contatos, renderização no perfil/leads, tenantizado.
Verification: campo criado num tenant não vaza para outro; valores salvos/exibidos.

### R8 — Tags + filtros
Aceite: filtrar por tags no Inbox e /leads (modo lista); selecionar tag mostra só correspondentes; server-side filter.
Verification: selecionar "Lead quente" → lista filtrada server-side (não client-only).

### R9 — Timeline completa do lead
Aceite: origem, criação, qualificações, alterações, tags, etapas do ROBÔ, eventos IA SEPARADOS, transferências, responsáveis, pipeline, agendamentos, venda/perda/encerramento, ator, data/hora.
Verification: lead com histórico denso mostra "como entrou → o que aconteceu → como saiu"; paginada (sem carregar tudo).

### R10 — Atividades do contato (compacta)
Aceite: visão operacional compacta (transferências, mudança de responsável, observações, ações, autor, data/hora); roles respeitados.
Verification: reusa mesma fonte de eventos com filtro de categoria; não duplica R9 (mesma tabela, duas visões).

### R11 — Duplicidade de contatos
Aceite: normalização de telefone na criação/entrada; identidade inequívoca (mesmo telefone normalizado) → consolidar sem duplicar; ambíguos → sinalizar; nunca perder mensagens/tags/histórico/observações/tarefas/relacionamentos; nunca merge por nome.
Verification: criar contato com mesmo telefone → consolida; nome parecido com telefone diferente → não merge, apenas sinaliza.

### R12 — Perfil lateral do contato
Aceite: auditado; melhorias pontuais sem recriar; chat continua principal.
Verification: nenhum regresso de largura/ux do chat.

### R13 — Busca global
Aceite: se existe, melhorar somente onde necessário; nunca criar segunda busca.
Verification: decisão registrada com evidência.

### R14 — Importação de contatos
Aceite: central CSV/XLSX; template oficial; guia curto; mapeamento de colunas; validação; duplicidade (via R11); erros claros por linha.
Verification: importar CSV de 10 linhas com 2 duplicadas → 8 novos, 2 sinalizados/consolidados; erro por linha legível.

### R15 — Exportação CSV
Aceite: CSV nas tabelas relevantes; /leads: selecionados e resultado filtrado; permissões respeitadas; streaming sem N+1.
Verification: exportar resultado filtrado baixa CSV coerente com filtros; sem permissão → 403.

### R16 — Preferências individuais
Aceite: tema, accent (se suportado), densidade, notificações/som/volume (link R1), persistidas por usuário; nunca mexem em config global.
Verification: mudar densidade não afeta outro usuário.

### R17 — Aguardando resposta
Aceite: fila de conversas com cliente aguardando humano; ao responder → sai automaticamente; estado vazio adequado; sem duplicar conversa/contato.
Verification: cliente manda msg → aparece na fila; atendente responde → some.

### R18 — Alterações não salvas (drafts)
Aceite: hook reutilizável (localStorage/IndexedDB + TTL), restauração segura pós-reload, strip fina "Alterações não salvas" com Ver/Descartar/Salvar, sem modais.
Verification: editar, recarregar, strip aparece; descartar limpa.

### R19 — Lixeira / soft delete
Aceite: soft delete de contatos (mínimo viável); lixeira da empresa; quem/when/item; restaurar; retenção; exclusão definitiva; permissões.
Verification: excluir contato → some das listas, aparece na lixeira; restaurar volta íntegro.

### R20 — Onboarding de configuração (independente do pattern)
Aceite: card na Home/Dashboard enquanto pendências essenciais (empresa, canal, equipe, pipeline, mínimos); ✓/○ com ações diretas; progresso derivado do backend (estado real das tabelas, não toggle manual); some ou vira compacto "Configuração concluída"; não bloqueia uso.
Verification: tenant novo sem canal mostra pendências; conectar canal+equipe+pipeline → some.

### R21 — Pay Oficial / CRM-WhatsApp port
Aceite: decisões de port baseadas na auditoria do legado; apenas o saudável; arquitetura/segurança/tenancy preservadas.
Verification: cada item portado tem decisão registrada.

### R22 — Fluxos de ROBÔ (determinístico)
Aceite: editor visual (blocos: mensagens, condições, ações, esperas, bifurcações, sequência), execução determinística, histórico de execução; ROBÔ ≠ IA (separação clara de dados e UI).
Verification: fluxo simples criado → executado numa conversa → histórico registra blocos executados; IA não misturada.

### R23 — Empty states e feedback
Aceite: audit + padrão único; ações contextuais; feedback discreto Salvando.../Salvo/Falha/Sincronizando.
Verification: telas novas (tarefas, importação, notificações, fila) têm empty state com ação.

### R24 — Status/disponibilidade
Aceite: auditar (já existe pool/attendants availability); não criar sistema paralelo.
Verification: decisão registrada; nenhuma tabela paralela de disponibilidade.

### R25 — Duplicar
Aceite: não espalhar "Duplicar"; avaliar root/templates/empresas; decisão registrada.
Verification: se implementado, apenas onde auditoria justificar.

### R26 — Presets de criação de empresas (root)
Aceite: root cria empresa a partir de config existente; copia SOMENTE pipeline/tags/campos personalizados/preferências básicas/fluxos selecionados; NUNCA contatos/conversas/credenciais/tokens/dados privados.
Verification: criar preset de tenant A para B → B tem pipeline+tags+campos, zero contatos/conversas/credenciais de A.

### R27 — Permissões
Aceite: novas features com ACL no backend; UX de permissões agrupada por módulo quando necessário.
Verification: cada endpoint novo tem requirePermission; painel esconde sem permissão.

## Invariants
- Toda query nova com tenant_id escopado (zero vazamento cross-tenant); testes de isolamento onde houver risco.
- Autorização no backend em TODA operação sensível (requirePermission); frontend só esconde.
- Migrations 0167+ numeradas sequencialmente, idempotentes, sem destruir dados; fresh-migrations deve passar.
- Nenhuma credencial hardcoded; segredos via env.
- Compat Safari 12-15 via lib/compat.ts; dvh em styles/legacy-compat.css; IME-safe no composer.
- Sem N+1; paginação keyset nos endpoints de lista; contadores server-side.
- Realtime apenas se infra existente suportar barato; senão poll curto, documentado.
- Testes que asserem source-strings: grepar antes de editar; manter contratos de aria/roles.
- Não comitar .hermes/, .claude/, .agents/, comments.md; escopo git apps/atendon/**.
- NUNCA deployar sem pedido explícito.

## Edge Cases
- Duplicidade ambígua (mesmo telefone, nomes diferentes) → sinalizar, nunca auto-merge silencioso.
- Upload exatamente no limite da quota → rejeitar quando ultrapassar, aceitar quando dentro; soma correta de bytes (base64 decodificado).
- Drafts: TTL vencido → não restaurar; dados corrompidos no storage → ignorar silenciosamente.
- Merge/consolidação com conversas ativas → transferir FKs, preservar histórico e sessões.
- Notificações: usuário desativado/removido da equipe → não receber novas.
- Onboarding: tenant root/demonstração sem pendências → estado compacto, não some com erro.
- Fluxos de robô: loop de bifurcação → detector de ciclo (execução com limite e log).

## Dependencies
- R2/R3 dependem da infra de eventos/notificações (nova) + notes (nova).
- R6 depende de R2 (notificação de atribuição) e do manifest do shell.
- R9/R10 dependem da fonte de eventos unificada (decidir: reaproveitar auditoria existente vs tabela nova — AUDIT decide).
- R14/R11 compartilham normalização/consolidação.
- R4 depende de como anexos são armazenados hoje (base64) — quota mede bytes.
- R22 é o maior item; portar do legado conforme auditoria; pode entrar em onda separada.
- PA (pattern) é independente e entra primeiro; usado por R14/R20 quando fizer sentido.

## Affected Areas
(Auditoria preencherá com path:line)

## Non-goals
- Favoritos; ações em massa genéricas; atalhos extensos; chat corporativo; experimentais.
- Reescrever o shell do zero; redesign total (handoff guia densidade, não reescrita).
- Sistema paralelo de disponibilidade; segunda busca global; wizard genérico; stepper tradicional.
- Jira/Trello; Discord interno.

## Constraints
- Stack atual (Node backend + Next panel), sem dependência nova sem justificativa forte.
- Migration numbers 0167+ sequenciais; coordinar entre workers (números pré-atribuídos pela SPEC).
- Baseline: comparar falhas por NOME de arquivo (baseline-v5-backend-failing-files.txt).
- Compat, testes source-string, eslint --max-warnings=0.

## Required Tests
- Tenancy: pelo menos 1 teste de isolamento por feature com dados sensíveis (prefs, notas, tarefas, campos, lixeira, importação).
- Unit/UX: composer "/", FlowConnect, onboarding derivation, drafts TTL.
- Integração backend: tarefas, notificações, campos personalizados, quota, import/export, soft delete, fluxo robô (execução + histórico).
- fresh-migrations + typecheck + lint + build em cada onda.

## Definition of Done
- [ ] Classificação EXISTS/PARTIAL/MISSING/REFACTOR consolidada com evidência
- [ ] R1-R27 + PA implementados ou explicitamente adiados com motivo
- [ ] Migrations 0167+ aplicam em fresh-migrations
- [ ] Painel: testes, tsc, build+lint verdes; backend: sem falha NOVA vs baseline
- [ ] Revisão independente (worker hostil) aprovada
- [ ] Auditoria final: funcional, visual (360/1280), tenancy, permissões, responsividade
- [ ] progress.md atualizado; entrega final com criado/reaproveitado/refatorado/migrations/testes/bugs/adiados/riscos

# SPEC: Pipeline — movimentação livre para qualquer etapa + indicador de etapa automatizada
## Objective
Lead pode ser movido para QUALQUER caixa/etapa do pipeline, vindo de qualquer fase, sem ser
bloqueado pelo grafo de transições; toda coluna do quadro indica se é uma etapa automatizada
(IA/Ligação) ou manual. Governança permanece disponível como opção reversível no Configurar.
## Source
comments.md:228 — "Ser possivel locomover status do lead no pipeline para qualquer caixa,
independentemente de qual fase o lead esta, inclusive, preciso que apareca na etapa se é uma
etapa automatizada ou não".
## Current State
- Flag por tenant `tenants.pipeline_enforce_transitions` (migration 0156). Backfill setou TRUE
  nos tenants existentes → movimentação limitada ao grafo configurado.
- Painel já sabe operar com enforce=false (page.tsx:140-141 constrói todos os pares) e o backend
  já dispensa os grafos com enforceTransitions=false (organization/service.ts:489-510).
- NÃO existe rota para alternar o flag; NÃO existe UI para ele.
- Colunas operacionais são projeções (lib/pipeline.ts:171-211): operational_kind "ai_follow_up"
  (Follow-up N) e "call" (Ligação); persistem na etapa-fonte (page.tsx:210-216). Nenhum
  indicador textual de automação no board/lista/dialog.
## Desired Behavior
1. Por padrão (após migration), TODOS os tenants ficam em modo LIVRE: mover para qualquer etapa
   ativa não configurada em pipeline_transitions é permitido (drag, botão Mover, dialog e bulk).
2. O modo governado continua alcançável: toggle "Movimentação livre entre qualquer etapa" no
   Configurar pipeline (pipeline.manage) grava o flag e o quadro reage imediatamente.
3. Indicador de automação: cada coluna do board, item da lista e opção do dialog exibe se a etapa
   é "Automatizada (IA)" (ai_follow_up), "Automatizada (Ligação)" (call) ou "Manual".
4. Colunas ai_follow_up continuam NÃO-droppáveis e fora de targetsForLead (são projeções da
   automação; o destino persistido nelas seria a etapa-fonte).
## Requirements
### R1 — Migration 0166_pipeline_default_free_movement.sql
(renumerada de 0162: número ocupado por 0162_rbac_owner_admin_backfill de outra frente)
Acceptance Criteria:
- `UPDATE tenants SET pipeline_enforce_transitions=false` (idempotente, sem tocar a coluna DDL).
- Não re-executa DDL de 0156; comentário explica a troca de padrão do produto.
Verification:
- fresh-migrations em banco limpo (scripts/run-tests.ts tests/fresh-migrations.integration.test.ts)
  → 0162 aplica; SELECT mostra false após migrar.
### R2 — Rota backend para o toggle
PATCH /organization/pipeline/settings { enforce_transitions: boolean } — requirePermission
"pipeline.manage", mesma guarda de feature flag das rotas de stages (case_organization_v1),
audit(), e retorno { enforce_transitions }. GET /organization/pipeline já devolve o flag
(service:290-343) — sem mudança de shape.
Acceptance Criteria:
- Com flag=false, PATCH /organization/leads/:id/stage para um par SEM aresta configurada retorna
  200 (moveLeadToStage com enforceTransitions=false) — regra "qualquer caixa" provada em teste.
- Com flag=true, o mesmo movimento retorna 409 "Transição não habilitada..." (governança preservada).
- Sem pipeline.manage → 403.
Verification:
- Novo teste apps/backend/tests/organization-pipeline-free-movement.integration.test.ts:
  (a) modo livre move lead de "novo" direto para "fechado" com payload comercial e grava histórico;
  (b) modo governado devolve 409 no mesmo movimento; (c) PATCH settings sem permissão → 403;
  (d) isolação por tenant (flag de outro tenant não afeta). Rodar com env limpo:
  cd apps/backend && unset DATABASE_URL TEST_DATABASE_URL NODE_ENV && npx tsx scripts/run-tests.ts tests/<arquivo>.
### R3 — UI do toggle no Configurar pipeline
No dialog do PipelineSettings (pipeline-settings.tsx): seção "Movimentação" com checkbox
"Movimentação livre entre qualquer etapa" + texto curto do efeito; onChange → PATCH R2 e
onChanged() para revalidar /organization/pipeline. Escondido se !canManage (já é o caso).
Acceptance Criteria:
- Toggle ligado → board aceita drop em qualquer coluna manual/operacional-call; desligado → volta
  a respeitar o grafo (comportamentos já implementados em page.tsx:140-141 e board:152).
- Texto explica que etapas "Automatizadas (IA)" continuam não-droppáveis.
Verification:
- npx vitest run tests/pipeline-card-clean.test.tsx + novo teste de source no item R5.
### R4 — Indicador de automação por etapa
Board (PipelineColumn header), PipelineList e PipelineTransitionDialog exibem pill discreto:
- operational_kind "ai_follow_up" → "IA";
- operational_kind "call" → "Ligação";
- sem operational_kind → "Manual".
Acceptance Criteria:
- Pill presente para TODAS as etapas (pedido: automatizada OU NÃO); não quebra aria-label
  existente (`${stage.name}, ${leads.length} lead(s)`).
- PipelineStage type já tem operational_kind opcional — sem mudança de contrato de API.
Verification:
- npx vitest run tests/pipeline.test.ts tests/pipeline-view-list.test.tsx
  tests/pipeline-card-clean.test.tsx.
### R5 — Proteção de regressão (source + comportamento)
Novo tests/pipeline-free-movement-ui.test.ts: source assertions de page.tsx
(`enforce_transitions === false` → todos os pares), de pipeline-settings.tsx (chamada PATCH
/organization/pipeline/settings) e de pipeline-board.tsx (ai_follow_up nunca droppable).
Acceptance Criteria:
- Testes falham se alguém restringir o modo livre ou tornar ai_follow_up droppable.
Verification:
- npx vitest run tests/pipeline-free-movement-ui.test.ts; sabotagem: tornar ai_follow_up
  droppable → teste falha; restaurar → passa.
## Invariants
- Escopo/tenant: nenhum lead pode atravessar tenant (manter locks e invariantes do service).
- Dados comerciais obrigatórios continuam exigidos (fechado → venda; perdido → motivo;
  em_negociacao/proposta/follow_up → próxima ação) — modo livre NÃO dispensa payload.
- Colunas ai_follow_up permanecem fora do drop; "Ligação" permanece droppable (persiste na fonte).
- Nenhum commit/push/deploy por agentes.
## Edge Cases
- Tenant novo: coluna DEFAULT false (livre) — 0156 mantém.
- Layout salvo com etapas arquivadas; stages vazio; lead sem pipeline_stage_id (legacy) —
  caminhos atuais de fallback inalterados.
- Bulk apply em modo livre: erros de pipeline_transition não ocorrem (service 630-641 respeita flag).
## Dependencies
- Nenhuma com os outros SPECs. Backend + painel.
## Affected Areas
apps/backend/src/db/migrations/0166_pipeline_default_free_movement.sql (NOVO),
apps/backend/src/modules/organization/{routes,service}.ts (toggle + leitura do flag no service),
apps/backend/tests/organization-pipeline-free-movement.integration.test.ts (NOVO),
apps/panel/components/{pipeline-settings,pipeline-board,pipeline-list,pipeline-transition-dialog}.tsx,
apps/panel/app/leads/pipeline/page.tsx, apps/panel/tests/pipeline-free-movement-ui.test.ts (NOVO).
## Non-goals
- Não mudar o schema de pipeline_stages/pipeline_transitions; não implementar edição de automação;
  não alterar domínio de status técnicos.
## Constraints
- Migrations idempotentes (padrão fresh-migrations); env limpo nos testes backend (poluição de env
  derruba suíte); sem eslint-disable.
## Required Tests
Ver R2 (integração backend, 4 casos) e R5 (UI/source). Rodar também
tests/organization.integration.test.ts (arquivo que existia no baseline) para regressão.
## Definition of Done
- [ ] R1–R5 implementados; testes novos verdes 2x; backend+panel sem falhas além do baseline;
      typecheck/lint limpos.

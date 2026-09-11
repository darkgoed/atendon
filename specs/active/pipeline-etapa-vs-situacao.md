# SPEC: Pipeline — etapa comercial separada de situação e movimentação livre

## Objective
Separar coluna comercial de situação operacional, reduzir a densidade padrão do Kanban e permitir movimentação livre por tenant sem remover validações comerciais, domínio, isolamento ou locks.

## Source
Plano `.hermes/plans/2026-09-10_223826-atendon-conversas-dashboard-pipeline-instagram.md`, adendo executivo e seção C; `comments.md` bloco Pipeline.

## Current State
Existem 10 status técnicos, `DOMAIN_TRANSITIONS`, `pipeline_transitions`, CHECK/trigger de banco e validações comerciais. `GET /organization/pipeline` entrega configuração e o mapper real de leads fica em `modules/scheduling/service.ts`; não tratar esse GET como lista de leads. O card possui preferências de campos.

## Desired Behavior
Tenant novo nasce com movimentação livre (`pipeline_enforce_transitions=false`); tenant existente mantém legado travado quando 0156 adiciona a coluna. Com flag false, as duas restrições de SEQUÊNCIA (grafo TS e aresta configurada) são dispensadas, mas validação comercial, tenant, permissão, lock e CHECK/trigger continuam. DOMAIN_TRANSITIONS permanece intacto e é exigido quando flag true. O board oferece seis colunas-base; `aguardando_resposta`, `agendado`, `proposta_enviada` e `follow_up` continuam dados legados e aparecem como `situacao`, não são apagados/migrados.

## Requirements

### R1 — Migration 0156 segura
Criar `0156_pipeline_free_movement.sql` com `ADD COLUMN IF NOT EXISTS pipeline_enforce_transitions BOOLEAN NOT NULL DEFAULT false`, comentário explicativo e atualização única de tenants já existentes para `true` somente no momento de adicionar a coluna, protegida para não reaplicar atualização incondicional em segunda execução. Não remover/afrouxar `DOMAIN_TRANSITIONS`, trigger 0112 ou CHECKs.

Acceptance Criteria:
- Fresh migration é idempotente; reexecução não reclassifica tenants nem toca dados de produção.
- Flag false dispensa restrições de sequência dos dois grafos, NÃO validações comerciais. O grafo TS legado não é apagado nem alterado e continua protegendo o modo true.

Verification: `fresh-migrations.integration.test.ts` e teste de valores para tenant novo/existente.

### R2 — Movimentação individual e bulk
Em `organization/service.ts`, ler o flag dentro da mesma transação que trava o lead com `FOR UPDATE`; exigir `domainAllowsStageTransition` e `pipeline_transitions` apenas quando `enforce===true`. Em `validateBulk`, ler uma vez e só emitir `domain_transition`/`pipeline_transition` quando true. Flag ausente ou tenant não encontrado não concede movimentação livre por acidente.

Acceptance Criteria:
- Com false, `novo → agendado` sem aresta passa com etapa ativa e acesso autorizado, mesmo que o grafo TS legado proíba a sequência; o grafo continua intacto para true.
- Com true, a mesma transição sem aresta retorna 409.
- `fechado` sem `sale_value` continua 400; `perdido` sem motivo/nota exigida continua 400.
- Permissões, isolamento, locks e trigger permanecem ativos para rotas individuais e bulk.

Verification: `pipeline-free-movement.integration.test.ts` cobre os quatro casos, bulk e concorrência/tenant scope.

### R3 — Etapas-base e situação derivada
Em `organization/domain.ts`, adicionar `DEFAULT_BOARD_STATUSES = novo, em_atendimento, qualificado, em_negociacao, fechado, perdido` e `LeadSituation`/`leadSituation` com precedência do plano. `GET /organization/pipeline` retorna configuração com `is_default_board` por stage e `enforce_transitions`; NÃO retorna leads. A resposta real de listagem de leads, via mapper em `modules/scheduling/service.ts`, ganha `situacao` calculada no servidor. Registrar projeção de legado; não fingir migração completa nem perder cards.

Acceptance Criteria:
- Coluna técnica não-base continua acessível e dados legados continuam válidos.
- Situação é rótulo do card, não altera coluna/etapa.
- Preferência explícita da empresa/usuário continua respeitada.

Verification: teste de mapper e integração/UI para `situacao`, todas as precedências e toggle.

### R4 — Card e diálogos
Em `pipeline-card.tsx`, padrão mostra exatamente nome, interesse, responsável, situação e próxima ação; defaults de origin/qualification/nextMeeting/stalled ficam ocultos sem apagar suporte a preferências salvas. Situação usa chip existente e rótulos pt-BR. Pipeline page/UI esconde não-base por padrão, com “Mostrar todas as etapas”; ao ocultar, projeta leads nas colunas comerciais apropriadas e mantém acesso ao toggle.

Ao mover para `fechado`, exigir valor e aceitar `sale_product`, `sale_channel` (modalidade) e `sale_source` no `commercialTransitionPayloadSchema`, persistindo JSONB aditivo `outcome_metadata` em `scheduling_leads` na mesma transação comercial. O banco existente cria metadados no lead em migration 0156; não usar `scheduling_appointments.outcome_metadata` como substituto. Responsável vem de `assigned_member_id`; diálogo pode usar endpoint de atribuição, sem duplicar.

Ao mover para perdido, manter catálogo `lead_loss_reasons` e nota obrigatória quando configurada. Não codificar “Sem crédito” etc. como enum. `ConversationStatusPicker` oferece todas as etapas ativas quando `enforce_transitions=false`, lendo `enforce_transitions`; quando true preserva arestas configuradas.

Acceptance Criteria:
- `outcome_metadata` contém os três novos campos e é gravado atomicamente com efeitos comerciais.
- Falta de motivo/nota continua rejeitada; nenhuma validação comercial é removida, inclusive em modo livre.
- Novo→agendado não é bloqueado erroneamente pelo grafo quando flag false.

Verification: `pipeline-free-movement.integration.test.ts` e `pipeline-card-clean.test.tsx` validam comportamento, não strings do fonte.

## Invariants
- `DOMAIN_TRANSITIONS`, trigger 0112, CHECKs, locks, permissões e isolamento são preservados.
- Etapa, situação, status de conversa e outcome são conceitos distintos.
- Dados antigos não são apagados nem atualizados em massa na segunda execução.
- Responsável é uma única fonte; `outcome_metadata` fica no lead.

## Edge Cases
Tenant existente na reexecução; tenant novo; flag ausente/null; etapa técnica legada oculta; lead sem appointment; `aguardando_resposta` e `awaitingReply` simultâneos; venda sem metadados opcionais; motivo de perda que exige nota; bulk multi-tenant; corrida em lead.

## Dependencies
`organization/domain.ts`, `organization/service.ts/routes.ts`, `scheduling/service.ts`, `commercial-journey/schemas.ts/service.ts`, `pipeline_stages`, `pipeline_transitions`, trigger 0112, UI pipeline e picker.

## Affected Areas
`0156_pipeline_free_movement.sql`, backend organization/commercial/scheduling, `pipeline-card.tsx`, `pipeline-transition-dialog.tsx`, `conversation-status-picker.tsx`, `pipeline.ts`, `pipeline/page.tsx` e testes.

## Non-goals
Não remover status técnicos, não apagar/reseedar grafo, não ligar flag para NB/produção, não criar UI para configurar pipeline_enforce_transitions nesta execução (o toggle visual “Mostrar todas as etapas” É obrigatório), não migrar todos os leads, não duplicar responsável, não mover metadados para appointment.

## Constraints
Migrations aditivas/idempotentes; transações pg reais; arquivos <500 linhas; testes importam produção; nenhuma alteração de produção, stage, commit, push ou deploy.

## Required Tests
`pipeline-free-movement.integration.test.ts`; `pipeline-card-clean.test.tsx`; `fresh-migrations.integration.test.ts`; testes de mapper/rotas para `situacao`, `is_default_board` e `enforce_transitions`.

## Definition of Done
- [ ] R1–R4 cobertos sem contradição entre flag false, domínio e trigger.
- [ ] O caso novo→agendado é testado nos dois valores do flag.
- [ ] Metadados no lead, dinheiro, motivo, responsável e legado são verificados.
- [ ] Cada teste roda duas vezes e detecta sabotagem semântica.
- [ ] Revisão independente/gates pertencem ao orquestrador.

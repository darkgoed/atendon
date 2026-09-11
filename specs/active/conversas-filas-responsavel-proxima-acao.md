# SPEC: Conversas — filas, responsável e próxima ação

## Objective
Entregar filas de atendimento por tenant, reabertura na fila inicial, filtros e pendências, ações rápidas, próxima ação e pré-briefing no inbox, sem confundir fila com pipeline.

## Source
Plano `.hermes/plans/2026-09-10_223826-atendon-conversas-dashboard-pipeline-instagram.md`, adendo executivo e seção A; `comments.md` bloco Conversas.

## Current State
- `conversations` já possui status, responsável, escopo e reabertura automática no upsert de mensagens, mas não possui fila.
- `scheduling_leads.next_action`/`next_action_at` já existem e são editáveis por follow-up; não há exposição integrada no inbox nem pendências.
- Claim/assign, scheduler e resolver já existem.
- RBAC real é `apps/backend/src/auth/rbac.ts`; `PermissionKey` deve ser derivado de `PERMISSIONS` e novos papéis devem consumir esse catálogo.

## Desired Behavior
Cada tenant tem filas nomeadas e ordenáveis (`Novo contato`, `Agendado`, `Resolvido`), com fila inicial única. Mensagem nova cria conversa na inicial; mensagem em conversa fechada reabre e volta à inicial; conversa aberta mantém sua fila. O inbox filtra por fila, conexão, não lidas e pendência, mostra responsável/próxima ação/canal e oferece ações atômicas.

## Requirements

### R1 — Migration 0154 e modelo de filas
Criar `apps/backend/src/db/migrations/0154_conversation_queues.sql` com tabela `conversation_queues` e `conversations.queue_id` nullable, FK composta `(queue_id, tenant_id)` com `ON DELETE SET NULL` somente para `queue_id`, constraints de nome 1–60, cor hexadecimal, posição não negativa, exclusividade initial/resolved e índices. SQL deve ser aditivo/idempotente onde aplicável, incluir rollback comentado, sem alterar dados de produção nem reexecutar backfill destrutivo.

Acceptance Criteria:
- Há no máximo uma fila inicial e uma resolvida ativas por tenant; nome ativo é único case-insensitive.
- Backfill fecha→resolvida e demais→inicial; seed de tenant existente e novo cria as três filas sem duplicar.
- A FK nunca anula `tenant_id`.

Verification: `fresh-migrations.integration.test.ts` aplica todas as migrations em banco virgem; teste de constraints, idempotência e tenant isolation.

### R2 — Reabertura e criação na fila inicial
Atualizar `modules/messages/repository.ts` no mesmo upsert transacional: conversa nova recebe a fila inicial; conversa fechada que recebe mensagem vira `open`, limpa `resolved_at` e retorna à fila inicial; conversa aberta conserva sua fila; ausência de fila inicial tolera `NULL`.

Acceptance Criteria:
- Não há duas chamadas HTTP nem janela entre status e fila.
- `status`, `resolved_at` e `queue_id` permanecem coerentes.

Verification: `conversation-queue-reopen.integration.test.ts`, duas execuções consecutivas.

### R3 — Contrato de endpoints de fila
Criar `modules/conversations/queues.ts`, registrar em `app.ts`, usando `requirePermission`, auditoria, tenant transaction e `conversationScopeCondition` nas rotas de conversa:

| Método/rota | Acesso | Contrato |
|---|---|---|
| GET `/conversation-queues` | `conversations.read` | `?include_archived=true`; `{ queues: Queue[] }`, ordenado `position,id` |
| POST `/conversation-queues` | `conversations.queues.manage` | `{name,color?}`; `201 {queue}`, posição `max+10` |
| PATCH `/conversation-queues/:id` | manage | pelo menos um de `name,color,position`; `{queue}` |
| POST `/conversation-queues/reorder` | manage | `{ids}` exatamente todas as filas ativas, sem repetição; `{queues}` |
| DELETE `/conversation-queues/:id` | manage | `204`; `409` para initial/resolved; arquivada realoca conversas à inicial na mesma transação |
| PATCH `/conversations/:id/queue` | `conversations.reply` | `{queue_id}`; `{ok:true,queue_id,status}` |

`Queue` é `{id,name,color,position,is_initial,is_resolved,archived_at,conversation_count}`, contando apenas conversas abertas.

Acceptance Criteria:
- Selecionar fila resolvida faz `status='closed', resolved_at=now()`; qualquer outra faz `status='open', resolved_at=NULL`, atomicamente. Os handlers legados resolve/reopen e reativação automática mantêm fila/status coerentes na mesma escrita; a UI não precisa emitir duas requisições para resolver.
- Reorder bloqueia com `SELECT ... FOR UPDATE` todas as filas ativas do tenant antes de recalcular; conjunto incompleto/duplicado dá `400`. Criação/edição de posição/arquivamento usam a mesma ordem de lock por tenant para evitar corridas com reorder. As contagens abertas em Queue respeitam escopo de conversa do usuário.
- Toda query filtra tenant; atendente fora do escopo recebe `404`; alterações são auditadas.
- `conversations.queues.manage` existe no catálogo `PERMISSIONS`/RBAC e é provisionada sem união manual divergente.

Verification: `conversation-queues.integration.test.ts` cobre CRUD, lock/conjunto, status, arquivamento, escopo `mine` e autorização.

### R4 — Listagem e pendências
No `GET /conversations`, preservar `$1..$3` e apendar filtros `$4/$5` sem renumerar: `queue_id`, `session_id`, `unread`, `pending_action`; incluir fila, `lead.next_action`, `next_action_at`, vencimento, origem/campanha. Booleanos HTTP devem aceitar explicitamente apenas strings `true`/`false`, nunca `z.coerce.boolean()`.

Criar `GET /conversations/pending-actions`, permissão `conversations.read`, escopo de conversa, itens do contrato do plano, janela `next_action_at <= now()+15 minutes`, `LIMIT 50`, ordenação `next_action_at ASC, id` e `overdue` calculado em SQL. `total`/`overdue_total` contam o conjunto completo antes do limite.

Acceptance Criteria:
- Filtros combinados com `filter=mine` respeitam escopo e não vazam tenant.
- Comparações de horário são SQL/relógio do banco; nenhum timestamp é comparado em JS.

Verification: `conversations-filters.integration.test.ts` cobre cada filtro, combinação, janela, totais e desempate determinístico.

### R5 — UI do inbox e componentes
Em `conversas/page.tsx`, sem redesenhar tokens, fontes, raios, paleta ou grid: chips de filas preservam as quatro abas existentes; seletor usa `GET/PATCH`; ações rápidas usam endpoints existentes e resolução move à fila resolvida; conexão envia `session_id` ao servidor, mantendo a função exportada `filterConversationsByConnection` para o teste legado. Não lido usa `data-unread`, `font-semibold` e cores existentes.

Criar `conversation-next-action.tsx` e `conversation-pre-briefing.tsx` com as props do plano. Follow-up envia `{proxima_acao,proxima_acao_em_local}` (não UTC), descrição obrigatória ≤500, responsável só quando permitido e via endpoint de atribuição existente; vencido usa `var(--warn-border)`/`var(--warn)` e “Pendência”. Briefing omite campos ausentes e, vazio, mostra apenas “Sem dados de briefing ainda”.

Acceptance Criteria:
- Após escrita, revalida lista/thread; falha parcial é explicitada, nunca falso sucesso.
- Criar/renomear/ordenar/arquivar filas existe em `conversation-queue-manager.tsx`, protegido por gestão, com `onSaved` opcional.
- Próxima ação usa `conversationId` opcional para atribuição; não inventa responsável no follow-up.

Verification: `conversation-queues-ui.test.tsx` e `conversation-next-action.test.tsx`, com jsdom na primeira linha, exercitam renderização e comportamento real.

## Invariants
- Isolamento por `tenant_id`, permissões e escopo de conversa em leitura e escrita.
- Fila é atendimento, não pipeline; status e fila mudam atomicamente.
- Fila inicial não é arquivável/removível; dados antigos continuam válidos.
- Nenhum parâmetro existente é renumerado.

## Edge Cases
Tenant sem fila inicial; fila arquivada com conversas; reorder concorrente; conversa sem lead/ação; timestamp exatamente `now`; `false` HTTP; usuário sem escopo; mensagem simultânea em conversa aberta/fechada.

## Dependencies
Schema atual de conversations/leads, `auth/rbac.ts`, `case-scope.ts`, `withTenantTransaction`, endpoints claim/assign/resolve e follow-up, migrations até 0153.

## Affected Areas
`0154_conversation_queues.sql`, `modules/conversations/queues.ts`, `modules/messages/repository.ts`, handlers em `app.ts`, `apps/panel/app/conversas/page.tsx`, componentes novos e testes listados.

## Non-goals
Não criar ingestão de canal, não transformar fila em pipeline, não alterar produção/flag, não substituir atribuição existente, não mudar tokens visuais, não criar teste-teatro nem editar `comments.md`.

## Constraints
Arquivos novos <500 linhas; pg puro; migrations aditivas/idempotentes; toda escrita multi-passo em transação; sem stage/commit/push/deploy; testes importam produção e não executam providers reais.

## Required Tests
`conversation-queues.integration.test.ts`; `conversation-queue-reopen.integration.test.ts`; `conversations-filters.integration.test.ts`; `conversation-queues-ui.test.tsx`; `conversation-next-action.test.tsx`; `fresh-migrations.integration.test.ts`.

## Definition of Done
- [ ] R1–R5 e cada critério verificável atendidos.
- [ ] Cada teste roda duas vezes e falha após sabotagem semântica apropriada, com evidência bruta.
- [ ] Nenhuma contradição de responsável, escopo, `false`, totais ou reabertura permanece.
- [ ] Revisão independente aprova; gates e regressão ficam para o orquestrador.

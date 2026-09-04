# A4 — Recursos com limite natural e concorrência

Escopo: backend em `apps/backend/src`. Linhas referem-se ao checkout analisado.

## Recursos

1. **Usuários do workspace (convites/membros)**
   - Convite criado em `apps/backend/src/modules/workspaces/routes.ts:594`, tabela `workspace_invitations`; fluxo manual usa `BEGIN`/`COMMIT` no mesmo arquivo (aprox. `:548-599`). Não há contagem/limite de convites ou membros antes do INSERT.
   - Aceite cria usuário novo em `apps/backend/src/modules/workspaces/routes.ts:703`, tabela `users`, e membro ativo em `:714`, tabela `workspace_members`; ambos na transação explícita do fluxo (`BEGIN` antes do trecho e `COMMIT` em `:734`). Há verificação de membro existente (`:708-710`), mas não contagem/limite e a decisão não é um gate de capacidade.
   - O convite também verifica membro por e-mail em `:580-588`; sem limite e sem proteção de capacidade para concorrência.

2. **Conexões WhatsApp**
   - Provisionamento inicial do tenant cria uma sessão em `apps/backend/src/modules/root/routes.ts:124`, tabela `whatsapp_sessions`, dentro do fluxo de criação de tenant (transação explícita do endpoint). Provisionamento/seed também faz INSERT condicional em `apps/backend/src/db/provision-newave.ts:92` e `apps/backend/src/db/seed.ts:68`.
   - `modules/whatsapp` não contém criação de sessão; `session-repository.ts` apenas lê/atualiza `whatsapp_sessions` (`:10-18`, `:43-58`). Não há contagem por tenant nem limite de conexões; a aplicação seleciona a sessão mais recente/única em vários pontos.

3. **Pipelines/funis**
   - O recurso persistido é a etapa do funil: `apps/backend/src/modules/organization/service.ts:329`, tabela `pipeline_stages`, em `withTransaction` (`:327`). Não há contagem/limite de pipelines/etapas no create.
   - Transições são criadas em `apps/backend/src/modules/organization/service.ts:448`, tabela `pipeline_transitions`, também dentro de `withTransaction`; sem limite.
   - A edição de etapa calcula `lead_count` em `organization/service.ts:347-353`, mas isso é validação de etapa em uso, não limite de quantidade.
   - `commercial-journey` não cria pipeline; usa etapas e leads existentes e executa transações locais em `apps/backend/src/modules/commercial-journey/service.ts:52` e chamadas em `:350`, `:399`, `:440`.

4. **Contatos/leads**
   - Conversa/contato é criado por upsert em `apps/backend/src/modules/messages/repository.ts:419-441`, tabela `conversations`, no contexto de transação do repositório (o mesmo fluxo cria lead automaticamente em `:444-454`).
   - Lead é criado explicitamente em `apps/backend/src/modules/scheduling/service.ts:2887` (INSERT iniciado no bloco imediatamente posterior ao update/branch) e em `messages/repository.ts:444`; tabela `scheduling_leads`.
   - O fluxo possui deduplicação por tenant/telefone e locks em caminhos de atualização, mas não há contagem/limite de contatos/leads por tenant. Portanto, duas criações de números distintos podem exceder qualquer limite futuro sem gate adicional.

5. **Campos personalizados, tags, automações, integrações e webhooks**
   - **Tags existem:** criação em `apps/backend/src/modules/organization/service.ts:127`, tabela `lead_tags`, dentro de `withTransaction` (`:125`); sem contagem/limite. Atribuição cria em `:184`, tabela `lead_tag_assignments`, também transacional.
   - Não foram encontrados recursos/tabelas/rotas de campos personalizados no backend pesquisado.
   - Não há entidade de integrações/webhooks configuráveis por tenant sendo criada; “webhook” encontrado é o endpoint Evolution (`app.ts:456`) e notificações configuradas, não um cadastro de webhooks. Automações aparecem como lógica (`commercial-journey/automation.ts`), não como recurso criado/contado.

6. **Agendamentos/agenda**
   - Agendamento criado em `apps/backend/src/modules/scheduling/service.ts:2082`, tabela `scheduling_appointments` (o INSERT começa nesse ponto e termina antes do outbox em `:2117`), no fluxo transacional com `PoolClient`; a função de transação local está no mesmo serviço (uso de `client` e `BEGIN`/`COMMIT`).
   - Outbox de provisionamento criado em `:2117`, tabela `scheduling_meeting_provisioning_outbox`, na mesma transação.
   - Leads/agenda têm locks e regras de disponibilidade/conflito, mas não há limite de quantidade de agendamentos por tenant/plano. Existem limites naturais operacionais (slots, disponibilidade e conflito), não quota SaaS.

## Transações e concorrência

7. **Padrão de transação:** o helper central é `apps/backend/src/db/tenant-transaction.ts:17`, `withTenantTransaction(tenantId, work)`: `pool.connect()` em `:23`, `BEGIN` em `:26`, define `SET LOCAL app.tenant_id`, executa callback, faz commit/rollback e libera cliente. Nem todos os módulos usam o helper: `organization/service.ts` tem `withTransaction` local; scheduling, provisioning e outros usam wrappers locais sobre `pool.connect()`/`BEGIN`/`COMMIT`. Não existe `db.tx()` do pg-promise.

8. **Locks existentes:** sim. Há muitos `SELECT ... FOR UPDATE` e `FOR UPDATE SKIP LOCKED`. Exemplos: `workspaces/routes.ts:258,365-377,676`; `organization/service.ts:149,353,403`; `scheduling/service.ts:636,708,937,1037,1132,1665,2234,2430`; `commercial-journey/reconciliation.ts:23`. Há advisory locks: `organization/service.ts:644`; `scheduling/service.ts:527,1442,2712,2826`; `assignments/service.ts:47`; `operations/deployment-snapshots.ts:58`; `tripz-ai/repository.ts:503`. São locks de invariantes/serialização existentes, não gates gerais de plano.

## Erros HTTP

9. O handler global está em `apps/backend/src/app.ts:402-416`; respostas de erro incluem objeto com `error`/mensagem e, quando presente, `code` do erro (o trecho envia `statusCode`, `code`, `message`/detalhes conforme o caso). Erros de domínio são construídos com `statusCode`: por exemplo `organization/service.ts:152` lança `httpError(404,"Etiqueta não encontrada")`; `workspaces/routes.ts:588` lança `httpError(409,"Usuário já pertence a este workspace")`; `scheduling/service.ts:2860` lança `httpError(400,"origem é obrigatória ao criar um lead")`. Caso explícito com code: `app.ts:2390` responde `409` com `{ ok:false, code:"idempotency_conflict" }`; `web-push/routes.ts:76` responde `{ code:error.code, error:"Endpoint inválido" }`. O formato não é uniformemente `{statusCode,code,message}` no body: `statusCode` é HTTP, e `code` só existe em alguns erros.

## Testes

10. Testes ficam em `apps/backend/tests/`, com 110 arquivos `.test.ts`; padrão Vitest (confirmado pelos nomes/configuração do pacote e imports `vitest` nos testes). Integrações usam banco real e `pg.Pool`; fixture de tenant é criada diretamente com SQL em `apps/backend/tests/saas-foundation.integration.test.ts:58-62`: `BEGIN`, `INSERT INTO tenants(...) RETURNING id` para tenants A/B/C e `ensureWorkspaceDefaultRoles(client, tenantId)`. O mesmo teste faz rollback/limpeza no teardown. Há teste dedicado do helper em `apps/backend/tests/tenant-transaction.test.ts`.

## Implicação para limites

Os pontos de criação são majoritariamente transacionais, mas nenhum faz hoje `count + limite` protegido contra concorrência. Para quotas de plano, o gate deve ocorrer na mesma transação do INSERT e serializar por tenant (por exemplo, lock de uma linha estável do tenant ou advisory transaction lock), evitando o padrão TOCTOU de contar fora da transação. Índices/constraints continuam necessários como segunda linha para unicidade/idempotência.

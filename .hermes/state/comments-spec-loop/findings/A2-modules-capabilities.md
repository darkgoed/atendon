# A2 — Inventário de módulos, capabilities e feature flags

Escopo: leitura do código existente em `apps/backend/src` e `apps/panel/app`. Nenhum arquivo de código foi alterado.

## 1. Sistema de capabilities / feature flags

### Fontes e tabelas

- `apps/backend/src/modules/operations/feature-flags.ts:5-22` mantém as listas compiladas: `FEATURE_FLAG_KEYS` (rollouts e capabilities) e `CAPABILITY_KEYS` (`dashboard_v1`, `leads_v1`, `pipeline_v1`, `appointments_v1`, `post_sales_v1`, `tripz_ai_v1`, `workspace_admin_v1`).
- A tabela principal é `feature_flag_definitions`, consultada em `feature-flags.ts:153-160` e criada/evoluída pela migration `0118...sql:3-18`. Ela guarda catálogo, descrição, `kind` (`rollout`/`capability`), defaults, estado global, kill switch, configurabilidade por tenant, disponibilidade e ordem de UI.
- `tenant_feature_flag_overrides` guarda override por tenant (`feature-flags.ts:165-174`, `:280-286`, `:329-338`). Não há criação dessa tabela em 0118; ela já existia e é populada para capabilities na migration (`0118:104-124`).
- `tenant_capability_support` é o suporte/provisionamento por tenant para capabilities `supported_tenants` (`0118:82-94`), com FK para `tenants` e `feature_flag_definitions`.
- `capability_dependencies` guarda dependências entre capabilities (`0118:63-80`): `pipeline_v1 -> leads_v1` e `appointments_v1 -> leads_v1` (`0118:73-77`).
- `tenants` é lida para resolver todos os tenants (`feature-flags.ts:214-222`), mas não guarda a capability diretamente.

### Como `resolveCapability` decide

`resolveCapability(client, tenantId, key)` (`feature-flags.ts:197-203`) chama `listEffectiveCapabilities`, carrega as definições e dependências, filtra pelo `key` e retorna `EffectiveCapability`; se a chave não estiver no catálogo, lança `Error("Capability não encontrada")` com `statusCode: 500` (não define `code`).

A decisão base (`decideFeatureFlag`, `feature-flags.ts:99-123`) segue exatamente esta precedência: **unsupported → kill switch → tenant override → global → default**. Se `availability_mode='supported_tenants'`, o tenant só é suportado quando existe linha correspondente em `tenant_capability_support`; nesse caso `supported=false` desabilita antes de qualquer override. Flags globais (`case_organization_v1`, `dashboard_widgets_v1`, `web_push_v1`) não aceitam override de tenant (`:27-30`, `:117-120`).

Depois, `resolveFeatureFlagRows` (`:124-151`) resolve dependências recursivamente. Uma capability habilitada fica desabilitada com `source="dependency"` e `blockedBy` quando qualquer dependência está desabilitada; ciclos também desabilitam. Portanto a resolução é por tenant, sem cache, e não concede permissão: o gate é uma barreira adicional.

`assertCapability`/`enforceRequestCapability` em `apps/backend/src/capabilities/gate.ts:80-109` resolve usando `session.tenantId` após autenticação. Se desabilitada, retorna erro com **HTTP 409**, `code="FEATURE_FLAG_DISABLED"`, mensagem `Funcionalidade indisponível para esta empresa` e campo `feature` com a chave. Capability inexistente é o caso distinto de **HTTP 500**, sem `code` explícito. O catálogo é dinamicamente extensível no banco: `0118:7-18` remove/recria a validação versionada e `0118:12-18` adiciona metadados; contudo o tipo/API compilado ainda lista `CAPABILITY_KEYS` estaticamente.

As rotas protegidas diretamente pelo gate incluem APIs públicas de leads/agendamentos (`gate.ts:10-21`) e superfícies do painel: dashboard, organização/leads/pipeline/bulk, scheduling, conexão/agente/uso/humanização/assinatura/follow-ups/stickers e administração do workspace (`gate.ts:24-77`).

## 2. Todos os módulos backend

- **ai-router** — roteamento e clientes de provedores de IA, incluindo OpenRouter/transcrição/análise; não registra `routes.ts` próprio.
- **assignments** — atribuição e gestão operacional de responsáveis por leads/appointments; sem rotas próprias detectadas.
- **commercial-journey** — automações e reconciliação da jornada comercial, incluindo resultados de reuniões; sem rotas próprias detectadas.
- **dashboard** — agregação de dados da visão geral do workspace; sem rotas próprias (consumido pelo app principal).
- **dashboard-widgets** — catálogo, layout e dados de widgets: `GET /dashboard/widgets/catalog`, `GET|PUT|DELETE /dashboard/widgets/layout`, `GET /dashboard/widgets/:key` (`dashboard-widgets/routes.ts:232-269`).
- **meet** — salas, tokens, entrada e gravações: `POST /meet/rooms`, `GET /meet/rooms/:id/token`, `GET /meet/join/:code`, `GET /meet/recordings`, `GET /meet/recordings/:id/file` (`meet/routes.ts:116-184`).
- **messages** — persistência, processamento de mensagens, conversas, follow-ups e mídia; rotas centrais são registradas no `apps/backend/src/app.ts`.
- **operations** — feature flags/capabilities, snapshots e operações administrativas: `GET /feature-flags`, `GET /capabilities`, `GET /root/feature-flags`, `GET /root/workspaces/:tenantId/feature-flags`, `GET /root/workspaces/:tenantId/capabilities`, `PATCH /root/workspaces/:tenantId/capabilities`, `PATCH /root/feature-flags/:key/global`, `PATCH /root/feature-flags/:key/kill-switch`, `PUT|DELETE /root/workspaces/:tenantId/feature-flags/:key/override` (`operations/routes.ts:94-350`).
- **organization** — tags, motivos de perda, saved views, pipeline/estágios/transições e operações em massa: `/organization/tags`, `/organization/loss-reasons`, `/organization/saved-views`, `/organization/pipeline...`, `/organization/leads/:leadId/stage`, `/organization/bulk...` (`organization/routes.ts:124-287`).
- **post-sales** — clientes, arquivo/restauração, checklist, opções e dívidas: `/post-sales/clients...`, `/post-sales/debts`, `/post-sales/options`, `/post-sales/checklist-template...` (`post-sales/routes.ts:69-191`).
- **qualification** — fluxos/sessões de qualificação e ação contextual: `GET /qualification/flows`, `GET /qualification/flows/:id`, `GET /qualification/sessions`, `PUT /qualification/flows/:id`, `POST /scheduling/leads/:id/qualification/:acao` (`qualification/routes.ts:32-92`).
- **realtime** — eventos em tempo real: `GET /events` (`realtime/routes.ts:47`).
- **root** — administração de workspaces, acesso, auditoria e métricas: `GET|POST /root/workspaces`, `PATCH /root/workspaces/:id`, `POST /root/workspaces/:id/access`, `DELETE /root/workspaces/:id/contacts-and-messages`, `GET /root/audit-logs`, `GET /root/operations/metrics` (`root/routes.ts:65-351`).
- **scheduling** — leads, agenda, disponibilidade, atendentes, notificações, configurações AtendON/Google Meet e integrações: `/leads`, `/categorias`, `/parceiros`, `/agendamentos...`, `/scheduling/leads...`, `/scheduling/appointments...`, `/scheduling/config/...`, `/scheduling/attendants...` (`scheduling/routes.ts:114-1102`).
- **stickers** — figurinhas geradas/geridas por IA: `GET /ai-stickers`, `GET /ai-stickers/:id/content`, `POST /ai-stickers`, `PATCH /ai-stickers/:id`, `DELETE /ai-stickers/:id` (`stickers/routes.ts:37-87`).
- **tripz-ai** — conversas IA, mensagens, anexos, propostas, preview/PDF e documentos: `/tripz-ai/conversations...` (`tripz-ai/routes.ts:104-357`).
- **usage** — consultas/indicadores de uso; sem `routes.ts` próprio (superfícies registradas em `app.ts`).
- **web-push** — preferências, subscriptions e entregas push: `GET /me/push`, `PATCH /me/push/preferences`, `POST|DELETE /me/push/subscriptions` (`web-push/routes.ts:41-95`).
- **whatsapp** — conexão/cliente Evolution, sessões e envio/processamento WhatsApp; rotas centrais registradas em `app.ts`, sem `routes.ts` no módulo.
- **workspaces** — membros, papéis, convites, timezone, transferência de proprietário e auditoria: `/workspaces/current/timezone`, `/workspaces/current/members...`, `/workspaces/current/roles...`, `/workspaces/current/invitations...`, `/invitations/:token`, `/auth/accept-invitation`, `/workspaces/current/audit-logs` (`workspaces/routes.ts:153-754`).

## 3. Páginas do painel (`apps/panel/app`)

Diretórios que contêm `page.*`: `403`, `agenda`, `agente`, `agente/figurinhas`, `alertas`, `alterar-senha`, `conexao`, `configuracoes`, `conversas`, `convite`, `follow-ups`, `humanizacao`, `invitations/[token]`, `leads`, `leads/[id]`, `leads/pipeline`, `login`, `meet/[roomId]`, `offline`, `perfil`, `pos-venda`, `pos-venda/cobranca`, `pos-venda/configurar`, `reuniao/[code]`, `root/audit`, `root/workspaces`, `tripz-ai`, `uso`, `workspace/audit`, `workspace/members`, `workspace/roles`.

## 4. Candidatos a ENTITLEMENT comercial

Candidatos baseados somente em funcionalidades existentes e agrupados em capabilities/módulos reais:

- `DASHBOARD`
- `LEADS_E_QUALIFICACAO`
- `PIPELINE`
- `AGENDAMENTOS_E_AGENDA`
- `POS_VENDA`
- `TRIPZ_IA`
- `ADMINISTRACAO_WORKSPACE`
- `WHATSAPP_E_CONVERSAS`
- `ATENDON_MEET_E_GRAVACOES`
- `GOOGLE_MEET`
- `FOLLOW_UPS`
- `AI_STICKERS`
- `WEB_PUSH`
- `OPERACOES_EM_MASSA`

Os cinco primeiros/top-level e `TRIPZ_IA`/`ADMINISTRACAO_WORKSPACE` já têm representação de capability no catálogo (`feature-flags.ts:11-22`, `0118:31-61`). Os demais são candidatos comerciais derivados de módulos/rotas existentes, mas ainda **não** são entitlements de plano.

## 5. Funcionalidades futuras (não existem hoje)

- `PLANOS_SAAS` — FUTURE_FEATURE: não há entidade/serviço de planos.
- `ASSINATURAS` — FUTURE_FEATURE: a página `pos-venda/cobranca` é cobrança de cliente pós-venda, não assinatura do SaaS.
- `BILLING_SAAS` — FUTURE_FEATURE: nenhuma ocorrência de `billing` no backend/painel.
- `QUOTAS_COMERCIAIS` — FUTURE_FEATURE: não há quota comercial; limites encontrados são paginação, tamanho de payload, rate limit e limites técnicos.
- `LIMITE_DE_USUARIOS_POR_PLANO` — FUTURE_FEATURE.
- `LIMITE_DE_LEADS_POR_PLANO` — FUTURE_FEATURE.
- `LIMITE_DE_MENSAGENS_POR_PLANO` — FUTURE_FEATURE.
- `METERING_E_COBRANCA_RECORRENTE` — FUTURE_FEATURE.

## 6. Plano, assinatura, cobrança e limites atuais

A busca por `plan`, `subscription`, `billing`, `quota` e `limit` não revela noção de plano SaaS, assinatura comercial, cobrança recorrente ou quota. `subscription` aparece apenas como subscription técnica de Web Push (`web_push_subscriptions` e tipos PushSubscription). `limit` aparece em paginação SQL/schemas, rate limiting HTTP (`@fastify/rate-limit`), tamanho/limites técnicos de mídia e lotes de worker — não como limite comercial por tenant. A única página com “cobrança” está sob pós-venda (`apps/panel/app/pos-venda/cobranca`), portanto não demonstra billing do produto.

**Conclusão:** feature flags/capabilities atuais são um catálogo operacional de rollout e habilitação por tenant, com dependências e suporte técnico; entitlement comercial por plano ainda deve ser uma camada nova que reutilize o gate, sem duplicá-lo.

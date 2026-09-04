# SPEC: Camada SaaS comercial do AtendON (planos, entitlements, limites, consumo, cobrança)

## Objective

Adicionar ao AtendON uma camada comercial multiempresa: planos configuráveis pelo ROOT,
entitlements (direitos por empresa), limites com enforcement transacional, medição de consumo
por período de cobrança, assinaturas com ciclo de vida, e cobrança plugável por provedor.
O sistema atual deve continuar funcionando sem nenhuma mudança de comportamento observável
para os tenants existentes.

## Source

`comments.md` (44 seções). Este SPEC é a fonte de verdade técnica; `comments.md` é intenção.

## Current State (verificado, com path:line)

O AtendON **já é** multi-tenant com RBAC, ROOT e auditoria. Esta etapa NÃO refaz nada disso.

- Tenant = `tenants.id` (UUID); tabelas de domínio usam `tenant_id`. Não existe `company_id`.
  Resolução e validação por request: `apps/backend/src/auth/session.ts:81-120`.
- Sessão: cookie HTTP-only `atendon_session`, JWT HS256 12h com `sessionVersion`
  (`auth/session.ts:26-78`). ROOT = `users.is_root` revalidado no banco (`auth/session.ts:141-146`).
- RBAC: `users`, `permissions`, `workspace_roles`, `workspace_role_permissions`,
  `workspace_members`, `workspace_invitations` (`db/migrations/0017_saas_foundation.sql:11-70`);
  catálogo runtime em `auth/rbac.ts:3-67`; papéis OWNER/ADMIN/SUPERVISOR/OPERADOR (`rbac.ts:117-131`).
- Auditoria: tabela `audit_logs` (`0017_saas_foundation.sql:73-91`); helper local em
  `modules/root/routes.ts:46-62`. Não há helper genérico compartilhado.
- **Feature flags operacionais JÁ EXISTEM** e são dinâmicos por tenant:
  `feature_flag_definitions`, `tenant_feature_flag_overrides`, `tenant_capability_support`,
  `capability_dependencies` (`0118_dynamic_capability_catalog.sql:3-124`);
  resolução em `modules/operations/feature-flags.ts:99-203`; gate HTTP em
  `capabilities/gate.ts:83-96`, que hoje devolve **409 `FEATURE_FLAG_DISABLED`**.
- Transações: helper `withTenantTransaction` (`db/tenant-transaction.ts:17-38`), `pool.connect()`
  + `BEGIN`. `SELECT ... FOR UPDATE` e advisory locks já são usados no projeto
  (ex.: `modules/organization/service.ts:149,353,644`).
- Consumo de IA já registrado por request de provider em `usage_logs`
  (`0001_core.sql:56-71` + `0010_usage_provider_request.sql` + `0102_ai_provider_observability.sql`),
  com `ai_model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd`,
  `provider_request_id`, `call_reason`. Gravação em `modules/messages/repository.ts:1008-1012`.
- Agregação de mensagens do lead (4 mensagens -> 1 resposta): `modules/messages/humanizer.ts:321-352`
  (`debounceInbound` / `flushDebounce`), acionada de `process-message.ts:1035-1053`.
  A geração principal é `inbound_reply` em `process-message.ts:2015-2020`.
- Migrations: runner com advisory lock, checksum e `schema_migrations`
  (`db/migration-runner.ts:80-207`); arquivos `NNNN_snake_case.sql`; última = `0131`.
  O nome da última migration é fixado em **2 pontos** de
  `apps/backend/tests/fresh-migrations.integration.test.ts:32` e `:287`.
- Existe facilidade de criptografia de dados no projeto: `db/rotate-data-encryption.ts`
  (script `npm run rotate:data-key`).
- Painel Next.js App Router; menu central em `lib/panel-manifest.ts:30-41,61-89`;
  client de API em `lib/api.ts:16-59` (cookie, `ApiError` com status+body);
  gating por capability em `lib/capabilities.tsx:28-75` e `components/panel-access-guard.tsx:61-85`;
  área ROOT em `app/root/workspaces` e `app/root/audit`.
- **NÃO existe hoje**: nenhuma noção de plano, assinatura, cobrança, quota ou limite comercial.

## Desired Behavior

Três camadas independentes e compostas, nunca duplicadas:

```
Feature flag (o produto tem/está operacional)  -> já existe -> 409 FEATURE_FLAG_DISABLED
        ↓
Entitlement (a empresa tem direito comercial)  -> novo     -> 403 FEATURE_NOT_AVAILABLE
        ↓
Limit      (a empresa ainda tem saldo)         -> novo     -> 409 PLAN_LIMIT_REACHED
```

Resolução de entitlement efetivo (§10):
`Plan defaults -> plan_features/plan_limits -> tenant_entitlement_overrides -> Effective`

## Requirements

### R1 — Catálogos dinâmicos de feature e limite

Criar `feature_catalog` e `limit_catalog` como TABELAS (não enums TypeScript), para que o ROOT
possa adicionar novos direitos sem alterar código (§2, §22).

Acceptance Criteria:
- Inserir uma linha nova em `feature_catalog` torna a chave utilizável em planos e overrides
  sem recompilar o backend.
- Nenhum `if (plan.code === 'PRO')` existe no código. Verificação: `grep` por comparação de
  código de plano em `apps/backend/src` retorna 0 ocorrências fora de seeds/migrations.
- `limit_catalog.period` distingue `lifetime` (ex.: MAX_USERS) de `billing_period`
  (ex.: MAX_AI_INTERACTIONS).
- `feature_catalog.is_future = true` marca `FUTURE_FEATURE`; chaves futuras NÃO são enforçadas.

Verification:
- `npm test -w @atendon/backend` cobrindo teste que insere chave nova e resolve entitlement.

### R2 — Modelo de dados

Tabelas novas (UUID PK `gen_random_uuid()`, `TIMESTAMPTZ NOT NULL DEFAULT now()`, FK
`tenant_id -> tenants(id) ON DELETE CASCADE`, seguindo a convenção do projeto):

```
feature_catalog(key PK, label, description, category, is_future, created_at)
limit_catalog(key PK, label, unit, period, is_enforced, created_at)
plans(id, code UNIQUE, name, description, status active|archived, monthly_price_cents,
      setup_price_cents, currency default 'BRL', billing_period_months default 1,
      trial_days, grace_period_days default 7, is_internal, position, created_at, updated_at)
plan_features(plan_id, feature_key, enabled, PK(plan_id,feature_key))
plan_limits(plan_id, limit_key, limit_value BIGINT NULL /* NULL = ilimitado */,
      PK(plan_id,limit_key))
tenant_subscriptions(id, tenant_id UNIQUE, plan_id, status, current_period_start,
      current_period_end, trial_ends_at, grace_period_ends_at, canceled_at, suspended_at,
      price_override_cents, setup_price_override_cents, discount_type, discount_value,
      discount_expires_at, billing_provider_id, external_subscription_id, created_at, updated_at)
tenant_entitlement_overrides(id, tenant_id, kind feature|limit, key, bool_value, int_value,
      reason, expires_at, granted_by_user_id, created_at, updated_at,
      UNIQUE(tenant_id,kind,key))
subscription_events(id, tenant_id, subscription_id, event_type, from_plan_id, to_plan_id,
      from_status, to_status, actor_user_id, metadata JSONB, created_at)
usage_counters(tenant_id, period_start, period_end, metric_key, used BIGINT,
      updated_at, PK(tenant_id,period_start,metric_key))
usage_events(id, tenant_id, metric_key, quantity, idempotency_key, occurred_at, metadata,
      UNIQUE(tenant_id,metric_key,idempotency_key))
billing_providers(id, code UNIQUE, name, enabled, environment sandbox|production,
      credentials_encrypted, credentials_hint, webhook_secret_encrypted, accepted_methods TEXT[],
      last_event_at, created_at, updated_at)
billing_accounts(id, tenant_id UNIQUE, provider_id, external_customer_id, document, email,
      created_at, updated_at)
invoices(id, tenant_id, subscription_id, provider_id, external_id, kind, amount_cents, currency,
      status, due_date, period_start, period_end, paid_at, metadata JSONB, created_at, updated_at)
payments(id, tenant_id, invoice_id, provider_id, external_id, amount_cents, currency, status,
      method, paid_at, confirmed_by_user_id, metadata JSONB, created_at, updated_at)
billing_events(id, provider_id, external_event_id, event_type, payload JSONB, signature_valid,
      tenant_id, processed_at, processing_error, created_at,
      UNIQUE(provider_id, external_event_id))
```

Acceptance Criteria:
- NÃO criar tabela nova de custo de IA por request: reutilizar `usage_logs` (§36 "evitar duplicação").
- `status` de assinatura restrito por CHECK a
  `TRIALING|ACTIVE|PAST_DUE|GRACE_PERIOD|SUSPENDED|CANCELED|EXPIRED` (§11).
- Nenhuma migration destrutiva; nenhuma tabela existente perde coluna ou constraint.

### R3 — Seed dos planos (§3, §37)

Códigos imutáveis `BASIC`, `MEDIUM`, `PRO` (chave), nomes exibidos "Básico", "Médio", "Pro".
Preços: 497,00 / 897,00 / 1097,00 BRL em centavos.
Features e limites conforme §3, gravados como linhas de `plan_features`/`plan_limits`.

Acceptance Criteria:
- Nenhum número do §3 aparece hardcoded em código TypeScript; todos vivem no banco.
- ROOT consegue editar preço, feature e limite de qualquer plano pela API sem deploy.
- Migration de seed é idempotente (re-execução não duplica nem sobrescreve edição do ROOT).

### R4 — Plano de compatibilidade e backfill (§38) — INVARIANTE DE SEGURANÇA

Criar plano interno `LEGACY_UNLIMITED` (`is_internal = true`): todas as features do catálogo
habilitadas, todos os limites `NULL` (ilimitado).
Todo tenant existente no momento da migration recebe `tenant_subscriptions` com esse plano,
status `ACTIVE`, sem provider de cobrança.

Acceptance Criteria:
- Após aplicar todas as migrations num dump equivalente ao de produção, **nenhuma** rota passa a
  responder 403/409 que antes respondia 2xx.
- A migration usa `SELECT ... FROM tenants FOR UPDATE` + `INSERT ... ON CONFLICT DO NOTHING`
  para ser segura sob concorrência e reexecução.
- Tenant criado DEPOIS da migration sem plano explícito NÃO fica sem assinatura: o ROOT
  atribui plano na criação do workspace, e a ausência de assinatura é tratada como
  `LEGACY_UNLIMITED` até o ROOT decidir (fail-open documentado, ver R6).

### R5 — Serviço de entitlements (§5)

Módulo único `apps/backend/src/billing/entitlements.ts` com a API:

```ts
can(tenantId, featureKey): Promise<boolean>
getLimit(tenantId, limitKey): Promise<number | null>     // null = ilimitado
getUsage(tenantId, metricKey): Promise<number>
hasReachedLimit(tenantId, limitKey): Promise<boolean>
getEffectiveEntitlements(tenantId): Promise<EffectiveEntitlements>
assertFeature(tenantId, featureKey): Promise<void>       // lança 403 FEATURE_NOT_AVAILABLE
```

O enforcement transacional de limite NÃO vive aqui — vive em `billing/limits.ts` (R7), porque
exige o `PoolClient` da transação do chamador. `entitlements.ts` só resolve direitos.

Acceptance Criteria:
- É a ÚNICA fonte de verdade; nenhum outro arquivo consulta `plan_features`/`plan_limits`
  diretamente fora deste módulo e das rotas ROOT de administração.
- Override de tenant com `expires_at` no passado é ignorado.
- Assinatura `SUSPENDED`/`EXPIRED`/`CANCELED` nega toda feature comercial exceto as marcadas
  como `category = 'core'` (login, leitura de conversas, faturas) — a empresa nunca perde acesso
  aos próprios dados, apenas a capacidade de operar/criar.
- `PAST_DUE` e `GRACE_PERIOD` mantêm acesso normal (§11: falha pontual não corta acesso).

### R5.1 — Fábrica de erros de billing (pré-requisito descoberto na implementação)

O helper `httpError` existente aceita **apenas 2 argumentos**
(`modules/scheduling/service.ts:252` — `httpError(statusCode, message)`), sem `code`.
E o error handler global (`app.ts:418-423`) só propaga os campos
`error`, `code`, `feature` e `existingId` para o cliente — **qualquer outro campo é
descartado silenciosamente**.

Portanto:
- Criar `apps/backend/src/billing/errors.ts` seguindo o padrão já usado em
  `capabilities/gate.ts:65-71` (`Object.assign(new Error(msg), { statusCode, code, ... })`).
- Estender a allowlist do handler em `app.ts` com um único campo novo `details`
  (objeto), propagado apenas quando `status < 500`. É a alteração mínima que não
  muda nenhum contrato existente.
- `403` -> `{ error, code: "FEATURE_NOT_AVAILABLE", feature, details: { requiredPlans } }`
- `409` -> `{ error, code: "PLAN_LIMIT_REACHED", details: { limit, current, max, planName } }`

Acceptance Criteria:
- Teste prova que `details` chega ao cliente num 403 e num 409 reais.
- Nenhuma resposta de erro existente ganha ou perde campo.

### R6 — Enforcement de feature no backend (§6)

Estender o hook que já roda `enforceRequestCapability` (`app.ts`, hook `onRequest`) com
`enforceRequestEntitlement`, em módulo novo `apps/backend/src/billing/entitlement-gate.ts`.

Ordem de avaliação obrigatória: `autenticação -> workspace -> capability (409) ->
entitlement (403) -> permissão RBAC (403) -> handler`.
Justificativa: se o produto desligou a funcionalidade (kill switch), responder "faça upgrade"
seria mentira; a realidade operacional vem antes da promessa comercial.

Acceptance Criteria:
- `POST /agendamentos` com tenant no plano BASIC responde **403** com body
  `{ error: <mensagem amigável>, code: "FEATURE_NOT_AVAILABLE", feature: "CALENDAR",
     requiredPlans: ["MEDIUM","PRO"] }`.
- O código `FEATURE_FLAG_DISABLED` (409) e seu comportamento atual permanecem **inalterados** —
  há consumidores no painel (`lib/feature-flags.ts:22-31`, `components/error-toasts.tsx:68-92`).
- Rotas ROOT, `/auth/*`, `/me`, faturas do próprio tenant e webhooks NUNCA são bloqueadas por
  entitlement.
- Tenant sem assinatura é tratado como `LEGACY_UNLIMITED` (fail-open) e o fato é logado em WARN.

### R7 — Enforcement de limites sem race condition (§23)

Helper transacional em `apps/backend/src/billing/limits.ts`:
`assertLimitWithinTransaction(client, tenantId, limitKey, delta)` — executa
`SELECT id FROM tenant_subscriptions WHERE tenant_id = $1 FOR UPDATE` (serializa por tenant),
conta o recurso e compara com o limite efetivo, tudo no MESMO `client` da transação do chamador.

Pontos de aplicação (verificados como os locais reais de criação):
- `MAX_USERS` -> aceite de convite (`modules/workspaces/routes.ts:703-714`) e criação de convite
  (`:594`). Somente membros `active` consomem franquia (§29).
- `MAX_WHATSAPP_CONNECTIONS` -> `modules/root/routes.ts:124` (criação é operação ROOT).
- `MAX_AI_INTERACTIONS` -> ver R8.
- `MAX_PIPELINES` -> **declarado no catálogo com valores 1/3/10, SEM enforcement**: não existe
  entidade de funil no AtendON (só `pipeline_stages` plano por tenant,
  `0098_case_organization_v1.sql:91`). Multi-funil = `FUTURE_FEATURE`.
- `MAX_CONTACTS`, `MAX_STORAGE`, `MAX_AUTOMATIONS`, `MAX_CUSTOM_FIELDS` -> catálogo,
  `is_enforced = false` (recurso inexistente ou não comercializado agora).

Acceptance Criteria:
- Teste de concorrência: duas requisições simultâneas de criação com 1 vaga restante resultam em
  exatamente 1 sucesso e 1 `409 PLAN_LIMIT_REACHED`.
- Body do 409: `{ error, code: "PLAN_LIMIT_REACHED", limit: "MAX_USERS", current, max, planName }`.
- Nenhuma checagem de limite ocorre fora de transação.

### R8 — Medição de consumo de IA (§20, §21, §30)

Contabilizar **1 interação** no fim do turno lógico, após a geração final ser aceita —
NUNCA por request de provider (um turno tem tool calls, retries e síntese:
`modules/ai-router/openrouter.ts:620-625,672-723`).

Escopo da franquia (decisão registrada): consomem `MAX_AI_INTERACTIONS` apenas
`inbound_reply` (`process-message.ts:2015-2020`) e `follow_up` (`messages/ai-follow-up.ts:233-240`).
Transcrição de áudio e análise de mídia são medidas em custo (já vão para `usage_logs`) mas
NÃO descontam da franquia — §21 define interação como "uma geração/resposta".

Acceptance Criteria:
- 4 mensagens do lead agregadas pelo debounce (`humanizer.ts:321-352`) geram exatamente
  **1** incremento de `MAX_AI_INTERACTIONS`.
- O incremento é idempotente por `usage_events.idempotency_key` derivada do turno lógico
  (tenant + conversa + id do turno); reprocessamento não conta duas vezes.
- `usage_counters` é zerado por período: novo `current_period_start` cria linha nova; o histórico
  anterior permanece (§30 — nada é apagado).
- Ao atingir a franquia, o comportamento é definido e testado: a IA para de gerar resposta e o
  evento é registrado; a mensagem do lead NÃO é perdida e a conversa cai para atendimento humano.
- Custo real continua em `usage_logs` com modelo, tokens de input/output/cached e `cost_usd`.

### R9 — Ciclo de vida da assinatura (§11, §24, §25, §26)

Máquina de estados em `apps/backend/src/billing/subscription.ts`, com transições explícitas e
registro em `subscription_events`.

Acceptance Criteria:
- Upgrade libera features imediatamente e NÃO apaga configuração anterior (§24).
- Downgrade NUNCA apaga recurso (§25): se o uso atual excede o novo limite, a assinatura fica
  marcada `OVER_LIMIT` (flag derivada, não estado) — criação de novos recursos é bloqueada,
  os existentes continuam funcionando, e o admin escolhe o que arquivar.
- Cancelamento não destrói dados (§26); ROOT pode reativar.
- Vencimento sem pagamento: `ACTIVE -> PAST_DUE -> GRACE_PERIOD (grace_period_days) -> SUSPENDED`.
- ROOT reativa manualmente a partir de qualquer estado.

### R10 — Abstração de cobrança (§12-§17)

Interface `BillingProvider` em `apps/backend/src/billing/providers/types.ts`:
`createCustomer / createSubscription / cancelSubscription / createPayment / getPayment / handleWebhook`.

Implementações nesta etapa:
- `ManualPixProvider` — funcional (§16): gera payload PIX copia-e-cola + QR a partir da chave
  configurada pelo ROOT; estados `Aguardando confirmação | Pago | Rejeitado | Expirado`;
  ROOT confirma pagamento manualmente.
- `MercadoPagoProvider` — funcional para Pix e cartão, com webhook (§13).
- `StripeProvider` e `PagBankProvider` — registrados e plugáveis, lançando `NOT_IMPLEMENTED`
  em métodos não suportados (§14, §15). A arquitetura os aceita sem alteração de domínio.

Acceptance Criteria:
- Nenhuma chamada específica de gateway existe fora de `billing/providers/*`.
  Verificação: `grep -r "mercadopago\|stripe\|pagbank" apps/backend/src --include=*.ts` só
  retorna arquivos sob `billing/providers/`.
- Credenciais são gravadas cifradas com `encryptSecret`/`decryptSecret` já existentes
  (`modules/ai-router/secret-box.ts:37-86`, AES-256-GCM com keyring e suporte a rotação —
  o mesmo mecanismo já usado por `modules/messages/repository.ts` e `scheduling/service.ts`),
  e **nunca** retornadas pela API: o painel recebe apenas `credentials_hint` no formato
  `••••••••••7HsA` (§17). Os novos campos cifrados devem ser incluídos em
  `db/data-key-rotation.ts` para não ficarem órfãos na rotação de chave.
- Nenhum secret aparece em log (§40).

### R11 — Webhooks idempotentes (§18)

Rota pública `POST /billing/webhooks/:providerCode`, sem sessão, com validação de assinatura.

Acceptance Criteria:
- Assinatura inválida -> 401 e nada é processado.
- Evento repetido (mesmo `external_event_id`) é aceito com 200 mas **não** reprocessa:
  garantido por `UNIQUE(provider_id, external_event_id)` em `billing_events`.
- Teste obrigatório: webhook de aprovação entregue 2x resulta em 1 pagamento, 1 fatura paga e
  1 renovação de assinatura.
- Toda a mutação decorrente do webhook ocorre em UMA transação.
- Falha no processamento grava `processing_error` e permite retry seguro.

### R12 — API ROOT de administração (§8, §9)

Novo módulo `apps/backend/src/modules/saas/routes.ts`, todas as rotas exigindo `requireRoot`:

```
GET|POST            /root/saas/plans
GET|PATCH           /root/saas/plans/:id
POST                /root/saas/plans/:id/archive
POST                /root/saas/plans/:id/duplicate
GET                 /root/saas/catalog            (features + limites)
GET                 /root/saas/tenants            (plano, status, uso x limite)
GET                 /root/saas/tenants/:tenantId
POST                /root/saas/tenants/:tenantId/subscription      (atribuir/trocar plano)
POST                /root/saas/tenants/:tenantId/subscription/suspend|reactivate|cancel
PUT|DELETE          /root/saas/tenants/:tenantId/overrides/:kind/:key
GET                 /root/saas/invoices
POST                /root/saas/invoices/:id/confirm-manual-payment
GET                 /root/saas/usage
GET|PUT             /root/saas/providers
GET                 /root/saas/events
```

E para o tenant (somente leitura do próprio plano):
```
GET  /billing/my-plan     -> plano, status, features efetivas, limites e uso atual
```

Acceptance Criteria:
- Plano com histórico (assinatura ou fatura) NÃO pode ser apagado; apenas arquivado (§8).
- Toda mutação ROOT grava em `audit_logs` com antes/depois (§27).
- `GET /billing/my-plan` nunca expõe credencial de gateway nem dado de outro tenant.

### R13 — Frontend (§7, §8, §9, §39)

- Painel ROOT: `apps/panel/app/root/saas/{planos,empresas,assinaturas,cobrancas,consumo,gateways,historico}`,
  seguindo o padrão existente de `app/root/workspaces/page.tsx` (classes `.btn`, `.card`,
  `.admin-table`, `ModalDialog`).
- Gating por entitlement no painel do cliente: `apps/panel/lib/entitlements.tsx`, espelhando
  `lib/capabilities.tsx:28-75`; `panel-manifest.ts` ganha campo `entitlement` por item.
- Recurso bloqueado aparece como upsell, não some (§7):
  "Agenda — Disponível a partir do plano Médio. [Ver plano]".
- Limite atingido gera mensagem de negócio, nunca erro técnico (§39):
  "Você atingiu o limite de 8 usuários do seu plano. Plano atual: Médio. Uso: 8/8."

Acceptance Criteria:
- Esconder no frontend nunca substitui o bloqueio no backend (teste de R6 prova isso).
- Nenhuma página nova quebra o `eslint --max-warnings=0` do build do painel.

### R14 — Auditoria e observabilidade (§27, §40)

Acceptance Criteria:
- São auditados: alteração de plano, de limite, concessão de override, suspensão/reativação,
  alteração de gateway, pagamento aprovado/recusado — com ator, tenant, antes, depois, timestamp.
- Logs de billing/webhook/entitlement nunca contêm token, secret, credencial ou dado de cartão.

## Invariants

1. Nenhum tenant existente perde acesso a nada por causa desta implementação (R4).
2. `tenant_id` continua sendo o único eixo de isolamento; nenhuma rota nova aceita `tenant_id`
   vindo do cliente sem revalidar membership/ROOT.
3. Um administrador de empresa NUNCA altera plano, limite, override ou assinatura (§28) —
   todas essas rotas são `requireRoot`.
4. Nenhuma decisão comercial por nome/código de plano em código (§2).
5. Nenhuma exclusão automática de recurso por downgrade (§25).
6. Idempotência em webhooks e em medição de consumo.
7. O contrato de erro `409 FEATURE_FLAG_DISABLED` existente permanece intacto.

## Edge Cases

- Tenant sem assinatura -> fail-open como `LEGACY_UNLIMITED` + WARN.
- Override expirado -> ignorado.
- Limite `NULL` -> ilimitado (diferente de `0`, que é proibido).
- Franquia de IA = 0 (plano BASIC) -> IA nem é chamada; conversa vai para humano.
- Downgrade com uso acima do limite -> `OVER_LIMIT`, sem exclusão.
- Webhook de tenant desconhecido -> registrado em `billing_events` com `tenant_id NULL`, sem erro 500.
- Troca de plano no meio do período -> período de cobrança atual preservado; efeito de features
  é imediato.
- ROOT criando conexão WhatsApp para tenant no limite -> 409, a menos que conceda override antes.

## Dependencies

R1 -> R2 -> R3 -> R4 -> R5 -> {R6, R7, R8} -> R9 -> R10 -> R11 -> R12 -> R13; R14 transversal.

## Affected Areas

- Novo: `apps/backend/src/billing/**`, `apps/backend/src/modules/saas/**`,
  migrations `0132..0134`, `apps/panel/app/root/saas/**`, `apps/panel/lib/entitlements.tsx`.
- Alterado (cirúrgico): `apps/backend/src/app.ts` (registro de rotas + hook),
  `modules/workspaces/routes.ts` (limite de usuários), `modules/root/routes.ts` (limite WhatsApp),
  `modules/messages/process-message.ts` e `ai-follow-up.ts` (medição),
  `apps/panel/lib/panel-manifest.ts`, `apps/panel/components/shell.tsx`,
  `apps/backend/tests/fresh-migrations.integration.test.ts` (nome da última migration, 2 pontos).

## Non-goals (§43)

Site comercial público, landing page, página pública de preços, cadastro self-service, checkout
público, onboarding automático, criação automática de empresa após pagamento, trial público.
Também fora: BI/dashboard de MRR-ARR-churn (§31 — apenas estruturar os dados), sistema completo
de cupons (§32 — apenas o modelo), comercialização de add-ons (§34 — apenas a arquitetura),
multi-funil, e enforcement de limites cujo recurso não existe.

## Constraints

- Escopo git: `apps/atendon/**`. Nunca `git add -A` na raiz.
- Não deployar. Deploy é decisão explícita do usuário.
- Convenções do projeto vencem: UUID + `gen_random_uuid()`, `TIMESTAMPTZ DEFAULT now()`,
  migrations `NNNN_snake_case.sql`, Vitest, `httpError(status, msg, code)`.
- Arquivos abaixo de 500 linhas (CLAUDE.md).
- Sem refatoração ampla fora do necessário (§19).

## Required Tests (§41)

Backend (`apps/backend/tests/`):
- `saas-entitlements.integration.test.ts`: BASIC não acessa IA nem agenda; MEDIUM acessa IA;
  PRO acessa tudo que está configurado; override de tenant prevalece sobre o plano.
- `saas-limits.integration.test.ts`: 4º usuário no BASIC é recusado com 409 PLAN_LIMIT_REACHED;
  2ª conexão WhatsApp no BASIC é recusada; concorrência (2 requests, 1 vaga) -> 1 sucesso.
- `saas-usage.integration.test.ts`: 4 mensagens agregadas = 1 interação; franquia estourada é
  tratada; reset por período preserva histórico; idempotência do contador.
- `saas-subscription.integration.test.ts`: ACTIVE tem acesso; PAST_DUE e GRACE_PERIOD mantêm
  acesso; SUSPENDED bloqueia operação mas não leitura dos próprios dados; downgrade marca
  OVER_LIMIT sem apagar recurso.
- `saas-billing-webhooks.integration.test.ts`: webhook duplicado não duplica pagamento nem
  renova duas vezes; aprovação atualiza assinatura; falha não marca como aprovado;
  assinatura inválida -> 401.
- `saas-security.integration.test.ts`: usuário da empresa A não lê plano/consumo da B;
  ADMIN de empresa recebe 403 em toda rota `/root/saas/*`; chamada direta a endpoint restrito
  não contorna entitlement; credencial de gateway nunca volta na API.
- `fresh-migrations.integration.test.ts` atualizado (2 pontos).

Painel (`apps/panel/tests/`):
- entitlement gating esconde/mostra corretamente e mostra upsell;
- mensagem de limite atingido é a de negócio, não a técnica.

## Definition of Done

- [ ] Migrations aplicam em banco limpo e em banco com dados, sem erro.
- [ ] Backfill provado: nenhuma rota regride de 2xx para 403/409 para tenants existentes.
- [ ] `npm run lint` sem novos erros.
- [ ] `npm run typecheck` sem novos erros.
- [ ] `npm test` sem NOVAS falhas em relação ao baseline registrado do HEAD.
- [ ] Todos os testes de §41 existem e passam.
- [ ] `grep` prova: nenhum gateway fora de `billing/providers/`, nenhum plano hardcoded.
- [ ] Revisão independente (Fase 8) aprovada.
- [ ] Nenhum deploy executado.

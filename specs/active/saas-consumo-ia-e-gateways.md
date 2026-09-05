# SPEC: Consumo de IA, franquia, crédito de uso, rollover e gateways configuráveis

## Objective

Adicionar ao AtendON a camada de **monetização por consumo de IA** sobre a camada comercial
já entregue no ciclo anterior (planos, entitlements, limites, assinaturas, providers):

- franquia mensal de IA por plano, **sempre mensal**, independente da periodicidade de pagamento;
- bloqueio ao esgotar a franquia, sem derrubar o resto do produto;
- Crédito de Uso (overage) com teto em BRL ou ilimitado;
- contabilização de **custo real** (tokens/modelo) e preço faturável por estratégia configurável;
- rollover parcial de franquia não utilizada;
- ciclos MONTHLY/QUARTERLY/YEARLY com descontos e snapshot financeiro;
- alertas, dashboard de consumo, histórico e fatura discriminada;
- configuração dos gateways (Mercado Pago com OAuth) pelo painel ROOT, sem `.env` e sem deploy.

Zero regressão: o sistema em produção (3 tenants em `LEGACY_UNLIMITED`) deve continuar
funcionando exatamente como hoje.

## Source

`comments.md` (82 seções, reescrito). Este SPEC é a fonte de verdade técnica.

## Current State (verificado por leitura direta, com path:line)

Entregue e **em produção** pelo ciclo anterior (commit local 94b5998 / remoto 8ddd764):

- `feature_catalog`, `limit_catalog`, `plans`, `plan_features`, `plan_limits`,
  `billing_providers`, `tenant_subscriptions`, `tenant_entitlement_overrides`,
  `subscription_events`, `usage_counters`, `usage_events`, `billing_accounts`,
  `invoices`, `payments`, `billing_events` — `db/migrations/0132_saas_commercial_foundation.sql`.
- Seed de planos BASIC/MEDIUM/PRO/LEGACY_UNLIMITED — `0133_saas_seed_plans.sql`.
  `MAX_AI_INTERACTIONS` = 0 / 10000 / 40000 / NULL.
- Backfill de tenants existentes para `LEGACY_UNLIMITED` — `0134_saas_backfill_existing_tenants.sql`.
- `billing/entitlements.ts` resolve entitlement efetivo (plano → overrides).
- `billing/limits.ts` `assertLimitWithinTransaction` com `SELECT ... FOR UPDATE`.
- `billing/ai-metering.ts:53` `reserveAiInteraction` — reserva atômica de 1 interação por
  turno lógico, idempotente por `sha256(tenantId, purpose, logicalTurnId)`, fail-open.
  Consumidores: `modules/messages/process-message.ts:2501`, `modules/messages/ai-follow-up.ts:872`.
- `billing/webhook-service.ts` — recebe webhook, portão de idempotência
  `ON CONFLICT (provider_id, external_event_id)`, efeitos financeiros na mesma transação.
- `modules/saas/routes.ts` — 14 rotas `/root/saas/*` (ROOT) + `/billing/my-plan` (tenant).
- Painel: `app/root/saas/planos`, `lib/entitlements.tsx`, `lib/plan-errors.ts`,
  `components/feature-locked.tsx`.

Fatos que restringem o desenho desta etapa:

1. **Não existe rotina periódica que avance o período de assinatura.**
   `current_period_start/end` só avançam dentro do webhook de pagamento aprovado
   (`billing/webhook-service.ts:133-134`, `now() + billing_period_months`).
   Os `setInterval` do worker (`worker.ts:371-526`) e os repeatables
   (`queue/meet-maintenance-queue.ts:18,24`) são de outros domínios.
2. **`usage_counters` é chaveado pelo período de COBRANÇA**
   (`billing/usage.ts:2`, `entitlements.ts:58`, `ai-metering.ts:71`:
   `period_start = (SELECT current_period_start FROM tenant_subscriptions ...)`).
   Com `billing_period_months = 12` isso produziria **um único balde de 12 meses** —
   violação direta do §2. Este é o defeito estrutural que a etapa precisa corrigir.
3. **Custo real já é capturado**: `modules/ai-router/openrouter.ts:19-28` valida
   `usage.prompt_tokens`, `completion_tokens`, `cost`, `prompt_tokens_details.cached_tokens`.
   Persistido em `usage_logs` (`modules/messages/repository.ts:1007-1012`) com
   `ai_model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd`,
   `provider_request_id`, `call_reason`. `cost_usd` **vem do provider**, não é calculado.
4. **Não existe conversão USD→BRL** em nenhum ponto do código.
5. **Não existe tabela de configuração global** (só settings por tenant e por domínio:
   `tenant_ai_settings`, `scheduling_notification_settings`, etc.).
6. RBAC é um catálogo estático em `auth/rbac.ts:3-66` sincronizado por
   `ensurePermissionCatalog` (`rbac.ts:106`); OWNER/ADMIN recebem todas as permissões
   exceto módulo `tripz_ai` (`rbac.ts:143-147`). Não existe permissão de billing.
7. Criptografia reutilizável: `modules/ai-router/secret-box.ts` (AES-256-GCM + keyring +
   rotação), chave mestra em env (`config.ts:329-338`). **Não** existe `db/secret-box.ts`.
8. Pontos de geração de IA: `openrouter.ts:383-398` (transcrição de áudio),
   além de `inbound_reply` (`process-message.ts`), `follow_up` (`ai-follow-up.ts`),
   qualificação (`modules/scheduling/contextual-qualification.ts:210`).

## Desired Behavior

### Separação de períodos (correção estrutural)

```
BillingPeriod  (pagamento)  MONTHLY | QUARTERLY | YEARLY   -> tenant_subscriptions
UsagePeriod    (consumo)    SEMPRE mensal                  -> usage_periods  (NOVO)
```

Um plano anual gera **12 UsagePeriods sucessivos de 10.000**, nunca 120.000 de uma vez (§2).

### Ordem de consumo (§39, §50)

```
1. ROLLOVER  (o que expira primeiro)
2. BONUS     (o que expira primeiro)
3. INCLUDED  (franquia base do mês)
4. OVERAGE   (Crédito de Uso, cobrado em BRL)
```

### Fluxo de execução de IA (§16)

```
resolver entitlement -> AI habilitada? -> UsagePeriod aberto ->
saldo (rollover/bonus/included)? -> consumir -> executar
                       |sem saldo|
                       -> Crédito de Uso ativo? -nao-> RECUSAR (403 AI_QUOTA_EXCEEDED)
                                              -sim-> reservar custo estimado ->
                                                     cap excedido? -sim-> RECUSAR
                                                     -nao-> executar -> reconciliar custo real
```

## Requirements

### R1 — UsagePeriod mensal desacoplado do ciclo de cobrança

Criar `usage_periods`:

```
usage_periods(
  id UUID PK, tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES tenant_subscriptions(id),
  sequence INT NOT NULL,                    -- 1,2,3... dentro da assinatura
  start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL,
  included_limit BIGINT,                    -- NULL = ilimitado (snapshot do plano)
  included_usage BIGINT NOT NULL DEFAULT 0,
  rollover_granted BIGINT NOT NULL DEFAULT 0, rollover_usage BIGINT NOT NULL DEFAULT 0,
  bonus_granted BIGINT NOT NULL DEFAULT 0,   bonus_usage BIGINT NOT NULL DEFAULT 0,
  overage_usage BIGINT NOT NULL DEFAULT 0,
  overage_amount_brl_cents BIGINT NOT NULL DEFAULT 0,
  provider_cost_usd_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',      -- OPEN | CLOSED | INVOICED
  closed_at TIMESTAMPTZ, invoiced_at TIMESTAMPTZ,
  created_at, updated_at,
  UNIQUE(tenant_id, start_at)
)
CREATE UNIQUE INDEX ... ON usage_periods(tenant_id) WHERE status='OPEN';
```

Acceptance Criteria:
- Existe **no máximo um** período `OPEN` por tenant, garantido por índice único parcial —
  não por lógica de aplicação.
- `start_at`/`end_at` avançam de 1 mês calendário a partir do dia de aniversário da assinatura,
  independentemente de `plans.billing_period_months`.
- Fechar um período **nunca** apaga o anterior; cria um novo registro (§14).
- Valores monetários em **inteiros** (`_cents` / `_micros`). Nenhum `float` para dinheiro.
- `included_limit` é o **snapshot do limite efetivo** (plano + override do ROOT) no momento
  em que o período abre. A checagem de saldo em runtime usa o snapshot, **não** re-resolve o
  entitlement a cada mensagem — isso também elimina a dívida de performance registrada no
  ciclo anterior (~4-6 queries por mensagem).
- Exceção explícita: um override do ROOT aplicado **no meio do período** atualiza
  `included_limit` do período `OPEN` imediatamente (senão a concessão só valeria no mês
  seguinte, contrariando §21). A atualização registra evento de auditoria.

Verification:
- Teste de integração: assinatura com `billing_period_months=12` gera 12 períodos mensais
  distintos, cada um com `included_limit = 10000`; assert de que nenhum período tem 120000.
- Teste que tenta inserir 2 períodos `OPEN` para o mesmo tenant e recebe violação de unicidade.

### R2 — Rotação de período e migração de `usage_counters`

`usage_counters`/`usage_events` passam a referenciar `usage_period_id` em vez de
`period_start` derivado da assinatura.

**Decisão do arquiteto — fonte única de verdade.** Para `MAX_AI_INTERACTIONS`, a fonte de
verdade de consumo passa a ser **`usage_periods` + `ai_usage_ledger`**. `usage_counters`
continua existindo para as demais métricas, mas **não** pode haver dois contadores de
interações de IA divergindo. Qualquer leitura de uso de IA vem do período; nenhuma rota,
teste ou relatório novo pode ler `usage_counters` para a métrica de IA.

Acceptance Criteria:
- A migration cria o período `OPEN` corrente para toda assinatura existente e **migra** o
  contador de IA atual para `usage_periods.included_usage`. Nenhum consumo existente é
  perdido nem contado duas vezes. Assert: soma antes = soma depois.
- Grep de verificação: nenhuma leitura de `usage_counters` com `metric_key='MAX_AI_INTERACTIONS'`
  permanece no código após a migração.
- `billing/usage.ts:getCurrentPeriod` e `entitlements.ts:getUsage` passam a resolver pelo
  `usage_periods` aberto. Tenant sem assinatura continua **fail-open** (comportamento atual).
- Um reconciliador no worker (padrão `setInterval` já usado em `worker.ts:371-526`) fecha
  períodos vencidos e abre o seguinte. A rotação é **idempotente** e serializada por
  `SELECT ... FOR UPDATE` em `tenant_subscriptions`: duas execuções simultâneas do
  reconciliador não podem criar dois períodos.
- A rotação também acontece **sob demanda**, na primeira reserva de IA após `end_at`,
  para que um worker parado não conceda franquia infinita nem bloqueie o cliente.

Verification:
- Teste que roda a rotação 2x em paralelo (`Promise.all`) e assert de exatamente 1 período novo.
- Teste com data manipulada: período vencido + reserva de IA → rotaciona e concede franquia nova.

### R3 — UsageLedger: lançamento individual por interação (§9, §15)

Criar `ai_usage_ledger`:

```
ai_usage_ledger(
  id UUID PK, tenant_id, subscription_id, usage_period_id,
  interaction_key TEXT NOT NULL,          -- = idempotency_key do turno lógico
  purpose TEXT NOT NULL,                  -- inbound_reply | follow_up | ...
  consumption_type TEXT NOT NULL,         -- INCLUDED | ROLLOVER | BONUS | OVERAGE
  model TEXT, input_tokens BIGINT, output_tokens BIGINT, cached_tokens BIGINT,
  input_price_per_million_micros BIGINT, output_price_per_million_micros BIGINT,
  provider_cost_usd_micros BIGINT, provider_cost_brl_cents BIGINT,
  billable_amount_brl_cents BIGINT NOT NULL DEFAULT 0,
  pricing_strategy TEXT NOT NULL, pricing_snapshot JSONB NOT NULL,
  usd_brl_rate_micros BIGINT,
  reconciled BOOLEAN NOT NULL DEFAULT false,
  created_at, reconciled_at,
  UNIQUE(tenant_id, interaction_key)
)
```

Acceptance Criteria:
- Um lançamento por **turno lógico**, não por request de provider (§8). Reprocessar o mesmo
  turno não cria segundo lançamento (garantido pelo UNIQUE, não por checagem prévia).
- `pricing_snapshot` guarda a regra vigente no momento — trocar a estratégia depois **não**
  altera lançamentos históricos (§11).
- A soma de `billable_amount_brl_cents` dos lançamentos `OVERAGE` de um período é igual a
  `usage_periods.overage_amount_brl_cents`. Testado por asserção de igualdade.

Verification:
- Teste: 3 mensagens do lead agrupadas pelo debounce → 1 lançamento (§8).
- Teste de reconciliação: lançamento estimado é atualizado com custo real e o agregado do
  período acompanha, sem dupla contagem.

### R4 — Pricing de IA configurável (§7, §10, §11)

Criar `ai_pricing_rules` (versionada, nunca editada in-place) e
`ai_model_prices(model, input_price_per_million_micros, output_price_per_million_micros,
cached_input_price_per_million_micros, effective_from, effective_to)`.

Estratégias: `COST_PLUS_MARKUP`, `FIXED_PER_INTERACTION`, `CUSTOM`.

**Decisão do arquiteto (§11 delega explicitamente): estratégia inicial = `COST_PLUS_MARKUP`.**
Justificativa: §7 proíbe preço fixo por mensagem e §9/§10 exigem custo real do provider com
margem aplicada; `usage.cost` já vem do OpenRouter (`openrouter.ts:22`), então cost-plus é a
única estratégia que pode ser calculada com os dados que o sistema realmente possui hoje.
`FIXED_PER_INTERACTION` fica implementada e testada, mas não ativa.

Acceptance Criteria:
- Markup **não** hardcoded: vem de `ai_pricing_rules`, editável pelo ROOT.
- Trocar a regra cria nova versão; lançamentos antigos mantêm o `pricing_snapshot` original.
- Conversão USD→BRL usa taxa **configurável** (`billing_settings.usd_brl_rate_micros`),
  nunca uma chamada de cotação externa no caminho quente. A taxa usada é gravada no
  lançamento (`usd_brl_rate_micros`), para reprodutibilidade da fatura.
- Se o provider não devolver `cost`, o custo é derivado de `ai_model_prices` pelos tokens;
  se o modelo não estiver na tabela, o lançamento é gravado com custo 0 e
  `pricing_snapshot.fallback = 'unknown_model'` — **nunca** falha o atendimento.

Verification:
- Teste unitário do cálculo cost-plus com números fechados (custo 0,005 → markup → 0,015).
- Teste de que alterar a regra não muda o `billable_amount` de lançamento anterior.

### R5 — Crédito de Uso (overage) com spending cap (§3-§6, §17)

Criar `tenant_usage_credit_settings(tenant_id UNIQUE, enabled, limit_type FIXED|UNLIMITED,
monthly_spending_limit_cents, updated_by_user_id, updated_at, confirmed_unlimited_at)`.

**Mecanismo obrigatório de reserva/reconciliação (não inventar alternativa).**
O §17 exige que R$19,98 usados de R$20,00 não permitam consumo descontrolado. Desenho fixo:

```
1. TX: FOR UPDATE em tenant_subscriptions
2. estimated_cents = estimativa da regra de pricing vigente (piso configurável)
3. se (overage_amount_brl_cents + reserved_cents + estimated_cents) > cap  -> RECUSA
4. grava ledger com billable_amount = estimated_cents, reconciled = false
   e soma estimated_cents em usage_periods.reserved_cents
5. COMMIT  -> executa a geração de IA
6. TX curta: substitui a estimativa pelo custo real, zera a reserva daquele lançamento,
   marca reconciled = true. O delta (real - estimado) entra em overage_amount_brl_cents.
```

O passo 3 usa `overage + reservado`, nunca só o já gastado — é isso que impede N chamadas
concorrentes de passarem juntas pela mesma folga. Um lançamento não reconciliado por falha
de processo é reconciliado pelo mesmo reconciliador do worker (R2) usando `usage_logs` como
fonte do custo real; reservas órfãs mais velhas que uma janela configurável são liberadas.

Acceptance Criteria:
- Franquia esgotada + crédito **desativado** → IA recusa nova geração; **nenhum outro módulo
  é bloqueado** (Conversas, Pipeline, Agenda continuam) (§4). Erro `403 AI_QUOTA_EXCEEDED`
  com `details` contendo `{ used, limit, creditEnabled:false }`.
- Franquia esgotada + crédito **ativo FIXED** → executa, contabiliza OVERAGE, desconta do teto.
- Ao atingir o teto → recusa. **O gasto acumulado nunca ultrapassa o cap de forma
  significativa** (§17): antes da geração é feita uma **reserva estimada**; após a resposta,
  o valor real **reconcilia** a reserva. Se o real exceder a reserva, o excedente é
  registrado e a próxima chamada é recusada — o cap pode ser ultrapassado no máximo pelo
  erro de uma única estimativa, nunca por N chamadas concorrentes.
- `UNLIMITED` exige confirmação explícita (`confirmed_unlimited_at` só é preenchido por
  requisição que envia o aceite); sem cap, mas com alertas (§6).
- Alterar essas configurações exige permissão `billing.manage` (R6).

Verification:
- Teste de concorrência: cap R$20,00 com R$19,98 usados e 5 chamadas simultâneas →
  no máximo 1 executa; as outras recebem recusa. Assert do total gravado ≤ cap + 1 estimativa.
- Teste: `UNLIMITED` sem `confirmed_unlimited_at` é rejeitado com 400.

### R6 — Permissão `billing.manage` (§20, §80)

Adicionar ao catálogo `auth/rbac.ts` a permissão `billing.manage`
(module `billing`, action `manage`, "Gerenciar assinatura e crédito de uso").

Acceptance Criteria:
- OWNER e ADMIN recebem por padrão (comportamento existente do bloco `rbac.ts:143-147`).
- SUPERVISOR e OPERADOR **não** recebem — assert explícito em teste.
- Toda rota que altera crédito de uso, limite ou plano do tenant exige `billing.manage`.
- Rotas `/root/saas/*` continuam exigindo **ROOT como primeira operação da rota**
  (invariante já estabelecido no ciclo anterior; um ADMIN não pode tocar em gateway central).

Verification:
- Teste HTTP: OPERADOR recebe 403 ao tentar ativar crédito de uso, e o banco **não muda**
  (consulta pós-403, não apenas o status).

### R7 — Rollover de franquia (§35-§44, §47-§54)

Criar `rollover_ledger(id, tenant_id, usage_period_id, source_period_id,
unused_included_usage, rollover_rate_bps, generated_amount, consumed_amount,
expired_amount, created_at, expires_at)` e colunas de configuração em `plans`:
`rollover_enabled`, `rollover_rate_bps`, `rollover_max_percentage_bps`,
`rollover_expiration_periods`.

Acceptance Criteria:
- Rollover é gerado **apenas no fechamento de um período com renovação válida** (§37).
  Assinatura em `PAST_DUE`/`SUSPENDED`/`CANCELED` **não** gera rollover até regularizar (§51).
- `generated = min(unused_included * rate, included_limit * max_percentage)` (§38).
- Base elegível é **somente a franquia INCLUDED não utilizada** — rollover e bonus consumidos
  não entram na conta (§41). Assert: período que recebeu 2.500 de rollover e usou 4.000 no
  total não gera rollover sobre 12.500.
- Consumo OVERAGE **nunca** gera rollover (§42).
- Saldo expira após `rollover_expiration_periods` (§40); expiração é registrada
  (`expired_amount`), nunca silenciosa.
- Cancelamento: impede novos rollovers, define expiração, e o saldo **não** vira dinheiro,
  saque ou reembolso (§53). Não existe endpoint que converta rollover em valor.
- Upgrade/downgrade: o saldo existente é preservado mas **truncado ao teto do novo plano**,
  com evento de auditoria do ajuste (§52).
- Rollover **não** reduz a mensalidade (§54): nenhum caminho de código aplica saldo de
  interações a `invoices.amount_cents`.

Verification (§57 — todos obrigatórios):
- usa toda a franquia → rollover 0
- usa metade → rollover = 50% da sobra
- não usa nada → respeita o teto (não 100% da franquia)
- rollover expira no período seguinte
- rollover não gera rollover
- overage não gera rollover
- bonus não é confundido com rollover
- pagamento não confirmado não gera rollover
- renovação não duplica rollover (rodar 2x → mesmo saldo)
- webhook repetido não gera saldo duas vezes
- chamadas simultâneas não geram inconsistência
- mudança de plano respeita o novo teto
- ROOT consegue auditar e ajustar

### R8 — Bonus / ajuste manual do ROOT (§49)

`usage_grants(id, tenant_id, usage_period_id, kind BONUS, amount, reason, granted_by_user_id,
expires_at, created_at)`.

Acceptance Criteria:
- Concessão exige ROOT + motivo obrigatório; grava `subscription_events` (§48).
- BONUS é contabilizado separadamente de ROLLOVER em todos os relatórios.
- Nenhum caminho altera saldo sem registro de auditoria (§48: "nunca alterar saldo silenciosamente").

### R9 — Ordem de consumo e concorrência (§18, §39, §50)

Estender `reserveAiInteraction` (`billing/ai-metering.ts:53`) para consumir na ordem
ROLLOVER(expira antes) → BONUS(expira antes) → INCLUDED → OVERAGE.

Acceptance Criteria:
- Toda a decisão (ler saldo, escolher balde, gravar consumo) acontece **numa única
  transação**, serializada por `SELECT ... FOR UPDATE` em `tenant_subscriptions` — o mesmo
  mecanismo já provado no ciclo anterior. Não pode existir janela check-then-act.
- Idempotência por turno lógico preservada: reprocessar o mesmo `aiTurnId` não consome de novo.
- **Fail-open preservado**: erro de infraestrutura na contabilização não derruba o atendimento
  (comportamento atual de `ai-metering.ts:85-88` e `process-message.ts:2496-2506`).
- Quando a quota é recusada, a mensagem do lead **não é perdida**: mantém o caminho de
  fallback humano já existente (`markInboundProcessed` + retorno "fallback").

Verification:
- Teste: 5 reservas simultâneas com 1 vaga → exatamente 1 concedida (teste equivalente ao
  `billing-ai-reserve.integration.test.ts` já existente, estendido para os 4 baldes).
- Teste da ordem: tenant com rollover 2.500 + franquia 10.000 → as 2.500 primeiras
  interações debitam ROLLOVER; a 2.501ª debita INCLUDED.

### R10 — Alertas de franquia e de crédito (§22, §23)

`usage_alerts(id, tenant_id, usage_period_id, alert_type QUOTA|CREDIT, threshold_bps,
triggered_at, UNIQUE(tenant_id, usage_period_id, alert_type, threshold_bps))`.

Acceptance Criteria:
- Franquia: 80% / 90% / 100%. Crédito: 50% / 80% / 100%.
- Cada limiar dispara **no máximo uma vez por período** — garantido pelo UNIQUE, não por
  variável em memória (§22 "evitar envio repetitivo").
- Thresholds configuráveis pelo ROOT, sem hardcode.

Verification:
- Teste: cruzar 80% duas vezes (uso sobe, desce, sobe) → 1 registro apenas.

### R11 — Billing cycles e PlanPrice (§27-§32)

Criar `plan_prices(id, plan_id, billing_cycle MONTHLY|QUARTERLY|YEARLY, base_price_cents,
discount_type, discount_value, final_price_cents, currency, active,
UNIQUE(plan_id, billing_cycle) WHERE active)`.

Preços iniciais (§29-§31), todos editáveis pelo ROOT:
BASIC 497 / MEDIUM 897 / PRO 1097 mensal; desconto 10% trimestral, 20% anual.

Acceptance Criteria:
- `tenant_subscriptions` guarda **snapshot financeiro** da contratação (§32):
  `base_price_cents`, `discount_type`, `discount_value`, `final_price_cents`, `currency`,
  `billing_cycle`. Alterar `plan_prices` depois **não** altera contrato vigente.
- A **periodicidade de pagamento é independente da periodicidade de consumo** (§27):
  mudar para YEARLY não altera o tamanho do UsagePeriod.
- Overage é fechado **mensalmente** mesmo em contrato anual (§34); não espera 12 meses.

Verification:
- Teste: assinatura YEARLY, alterar preço do plano, assert de que `final_price_cents` da
  assinatura permanece o antigo.
- Teste: contrato anual acumula overage no mês 1 e ele é faturável antes do mês 12.

### R12 — Fatura discriminada e histórico (§25, §26, §33)

Criar `invoice_line_items(id, invoice_id, kind PLAN|DISCOUNT|AI_OVERAGE|ADDON|CREDIT,
description, quantity, unit_amount_cents, amount_cents, usage_period_id, metadata)`.

Acceptance Criteria:
- A invoice discrimina Plano, Desconto, Uso adicional, Add-ons, Total (§26).
- `sum(invoice_line_items.amount_cents) = invoices.amount_cents` — asserção em teste.
- Fechar um UsagePeriod com overage gera a linha `AI_OVERAGE` referenciando aquele período,
  e marca o período como `INVOICED`. Fechar duas vezes **não** duplica a linha.
- Histórico mensal por período: franquia, uso, excedente, cobrança adicional (§25).

### R13 — Métricas ROOT (§55)

Endpoint ROOT agregando por empresa / plano / mês: franquia concedida, franquia consumida,
rollover gerado/utilizado/expirado, overage gerado, receita de overage, custo real de IA.

Acceptance Criteria:
- Consulta agregada em SQL, não em JavaScript sobre todos os lançamentos.
- Só ROOT acessa (checagem como primeira operação da rota).
- Custo real vem do ledger, não de estimativa.

### R14 — Configuração global sem hardcode (§21, §56)

Criar `billing_settings` (linha única, singleton) com:
`default_rollover_rate_bps` (5000), `default_rollover_max_percentage_bps` (5000),
`default_rollover_expiration_periods` (1), `usd_brl_rate_micros`,
`credit_min_cents` (1000), `credit_max_cents` (100000), `credit_suggested_cents BIGINT[]`
(2000, 5000, 10000, 20000), `allow_custom_credit`, `allow_unlimited_credit`,
`quota_alert_thresholds_bps`, `credit_alert_thresholds_bps`.

Acceptance Criteria:
- Nenhum dos valores acima aparece literal no código fora da migration de seed.
  Verificação: grep por `5000`/`0.5`/`20.00` nos módulos de billing retorna 0 ocorrências
  de regra de negócio.
- ROOT pode exceder os limites do cliente manualmente (§21), com auditoria.
- O cliente não pode definir crédito fora de [min, max] — validado no backend.

### R15 — Gateways configuráveis pelo painel ROOT (§60-§63, §67-§69, §76-§80)

Estender `billing_providers` (já existe) com configuração comercial e credenciais por
ambiente, sem `.env` e sem deploy.

Acceptance Criteria:
- Credenciais **nunca** em plaintext: cifradas com `modules/ai-router/secret-box.ts`
  (AES-256-GCM + keyring, já usado no projeto). A **chave mestra permanece em env**
  (§68/§69: exatamente uma chave de infraestrutura, o resto no banco cifrado).
- `SANDBOX` e `PRODUCTION` têm **configuração própria e transações nunca se misturam** (§77).
  Modelado como linhas distintas por (code, environment), não como flag mutável.
- A API **nunca** devolve o secret completo — apenas hint `••••••••7F2A` (§65). Substituir
  é permitido; visualizar não.
- Separar credenciais de configuração comercial (§76): alterar prazo de PIX/boleto,
  métodos habilitados ou grace period **não** exige reconectar o gateway.
- Estados do provider (§78): `NOT_CONFIGURED`, `CONNECTED`, `TOKEN_EXPIRING`, `AUTH_ERROR`,
  `DISCONNECTED`, `DISABLED`.
- Eventos de auditoria (§79): `GATEWAY_CONNECTED`, `GATEWAY_DISCONNECTED`,
  `GATEWAY_CREDENTIAL_ROTATED`, `GATEWAY_AUTH_FAILED`, `GATEWAY_WEBHOOK_RECEIVED`,
  `GATEWAY_WEBHOOK_FAILED`. **Nenhum secret nos logs** — verificado por grep no diretório.
- Somente ROOT opera gateways (§80).

### R16 — Mercado Pago: OAuth (§61, §64, §65, §66, §72)

Implementar `MercadoPagoProvider` sobre a interface `BillingProvider` existente
(`billing/providers/types.ts`). Sem SDK: HTTP direto, para não acoplar o sistema à SDK (§62).

Dados confirmados na documentação oficial (verificados pelo orquestrador):
- Autorização: `https://auth.mercadopago.com/authorization?client_id=<APP_ID>&response_type=code&platform_id=mp&state=<RANDOM>&redirect_uri=<URL>`
- Token: `POST https://api.mercadopago.com/oauth/token` (JSON) com
  `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`.
  `test_token: true` gera credenciais de sandbox.
- Refresh: mesmo endpoint, `grant_type=refresh_token`; requer escopo `offline_access`;
  o `refresh_token` **também é rotacionado** e deve ser gravado junto com o novo access token.
- `redirect_uri` deve bater **exatamente** com o cadastrado; parâmetros extras vão no `state`.

Acceptance Criteria:
- `state` anti-CSRF: gerado no backend, persistido com expiração curta, **uso único**,
  validado no callback. Um `state` reutilizado é rejeitado.
- O callback **nunca** confia no frontend (§64): a troca do code acontece server-side.
- Access token, refresh token e expiração são gravados **atomicamente** na mesma transação —
  nunca sobrescrever só o access token.
- Renovação automática antes da expiração; falha de auth muda o status para `AUTH_ERROR`
  e registra `GATEWAY_AUTH_FAILED` (sem o token na mensagem).
- Desconectar (§72): revoga quando suportado, invalida credenciais armazenadas,
  **mantém** histórico financeiro e pagamentos, e bloqueia novas cobranças por aquele provider.
- Fallback de Access Token manual (§66) existe, mas OAuth é o caminho preferido.

Verification:
- Teste: callback com `state` inválido/reutilizado → 400, e **nenhuma** credencial gravada.
- Teste: rotação de refresh token grava os dois valores; simular falha no meio → rollback,
  credencial antiga intacta.

### R17 — Mercado Pago: webhook assinado (§73, §74)

Dados confirmados na documentação oficial (verificados pelo orquestrador):
- Header `x-signature: ts=<millis>,v1=<hex>`; header `x-request-id`; query param `data.id`.
- Manifest: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
- Assinatura: `HMAC-SHA256(secret, manifest)` em hexadecimal.
- `data.id` alfanumérico maiúsculo deve ser **convertido para minúsculo** no manifest.
- Se `data.id` ou `x-request-id` **não** vierem, os campos correspondentes devem ser
  **removidos** do manifest antes do HMAC.
- Payload: `{ id, live_mode, type, date_created, user_id, api_version, action, data:{id} }`.
- O Mercado Pago **reenvia a cada 15 minutos** até receber resposta de sucesso.

Acceptance Criteria:
- Assinatura inválida → `401`, registrado para auditoria, **zero efeito financeiro**.
- Comparação da assinatura em **tempo constante** (`crypto.timingSafeEqual`), não `===`.
- `ts` fora de uma janela de tolerância configurável → rejeitado (anti-replay).
- **Nunca** considerar pagamento aprovado pelo payload (§74): após validar a assinatura,
  o backend **consulta o recurso no provider** (`GET /v1/payments/{data.id}`) e usa o status
  retornado pela API como verdade.
- Idempotência e dedup reutilizam o portão já existente e provado
  (`billing/webhook-service.ts`, `UNIQUE(provider_id, external_event_id)`), sem duplicar código.
- Reentrega do mesmo evento **não** renova a assinatura duas vezes: asserção de
  `current_period_end` antes/depois (padrão já usado em
  `billing-webhook-processing.integration.test.ts`).
- Falha no meio do processamento → ROLLBACK, evento **não** marcado como processado,
  para que o retry do provider seja seguro.

### R18 — Teste de conexão e dados do vínculo (§70, §71)

Acceptance Criteria:
- Botão "Testar conexão" chama a API do provider e devolve sucesso/falha.
- Mensagem de erro e logs **nunca** contêm token (§70) — verificado por teste que injeta um
  token conhecido e faz assert de que ele não aparece na resposta nem no log capturado.
- Exibir conta vinculada, ambiente, data de conexão e última validação, quando a API fornecer.

### R19 — Painel: consumo, crédito, histórico, gateways (§19, §24, §45, §46, §63, §75, §81)

Acceptance Criteria:
- Tela do cliente `Assinatura → Uso de IA → Crédito de Uso` (§19) com opções
  R$20/50/100/200/Personalizado/Sem limite, **vindas da configuração**, não hardcoded.
- Dashboard de consumo (§24, §45): franquia do mês, créditos acumulados, total disponível,
  utilizado, % e dias para renovar; crédito adicional em BRL quando em overage.
- Vocabulário obrigatório (§45): "Créditos de IA" / "Interações acumuladas" /
  "Franquia acumulada". **Nunca** "R$ de crédito" para rollover.
- Previsão de rollover (§46) apresentada como estimativa.
- Conversão BRL→interações (§12) sempre rotulada como **estimativa**; nunca promessa fixa.
- Área ROOT de gateways (§63) com status, ambiente, conectar/desconectar/testar.
- Stripe/InfinitePay/PagBank aparecem como "Em breve" (§81); sem OAuth nem API deles.
- Só quem tem `billing.manage` vê e opera os controles de crédito; os demais veem leitura.

## Invariants

- **I0** Unidade comercial (§8): **uma interação = uma geração/resposta da IA ao lead**.
  Contam contra a franquia apenas `inbound_reply` e `follow_up` — o turno lógico já
  identificado por `aiTurnId`. **Não** contam: mensagens individuais recebidas do lead
  (o debounce agrega 4 mensagens em 1 resposta = 1 interação), tool calls, retries internos,
  transcrição de áudio, análise de mídia e qualificação. Esses últimos são medidos em
  **custo** (`usage_logs`, e no ledger quando ligados a um turno), mas não descontam franquia.
  Decisão herdada do ciclo anterior (D2) e mantida por coerência com §8 e §21.
- **I1** Dinheiro sempre em inteiros (cents/micros). Nenhuma coluna monetária em float.
- **I2** Nenhum limite, taxa, markup ou preço hardcoded no código (§1, §21, §56, §58).
- **I3** Nenhuma decisão de negócio por **nome/código de plano** (`plan.code === 'PRO'`).
- **I4** Tenants existentes (`LEGACY_UNLIMITED`) não sofrem nenhuma mudança observável.
- **I5** Falha da camada de billing **nunca** derruba o atendimento (fail-open), exceto a
  recusa deliberada por quota/cap.
- **I6** Nenhum secret em log, resposta de API ou mensagem de erro.
- **I7** Rollover não é moeda: não vira desconto, saque ou reembolso (§53, §54).
- **I8** Toda alteração de saldo tem trilha de auditoria (§48).
- **I9** Sandbox e produção nunca compartilham credencial ou transação (§77).
- **I10** Toda rota `/root/*` valida ROOT como **primeira operação**, antes de qualquer escrita.

## Edge Cases

- Assinatura sem `usage_period` aberto (tenant legado) → fail-open, cria período sob demanda.
- Plano com `MAX_AI_INTERACTIONS = NULL` (ilimitado) → nunca entra em overage nem gera rollover.
- Plano BASIC com IA desabilitada → recusa antes de qualquer cálculo de custo.
- Provider devolve `cost` ausente ou zero → deriva por tokens; modelo desconhecido → custo 0
  com marcação, sem quebrar.
- Turno lógico reprocessado após o período rotacionar → o lançamento pertence ao período
  original (chave por `interaction_key`), não duplica no novo.
- Downgrade no meio do período com uso acima do novo limite → não apaga recurso; marca
  over-limit (regra já estabelecida no ciclo anterior).
- Webhook chegando durante grace period → segue a política de billing existente.
- Relógio: toda comparação de período usa `now()` do banco, não `Date.now()` do processo.

## Dependencies

- R2 depende de R1. R3/R9 dependem de R1+R2. R7 depende de R1+R3. R10 depende de R1.
- R12 depende de R11+R3. R16/R17/R18 dependem de R15. R19 depende de R5+R7+R10+R15.
- R4 e R6 e R14 são independentes e podem ir primeiro.

## Affected Areas

- `apps/backend/src/db/migrations/` — novas migrations (0135+), sequenciais.
  `apps/backend/tests/fresh-migrations.integration.test.ts` fixa o nome da **última**
  migration em **2 pontos** (`:32` e `:287`) — ambos precisam ser atualizados.
- `apps/backend/src/billing/` — ledger, pricing, rollover, periods, credit, alerts.
- `apps/backend/src/billing/providers/mercadopago.ts` — implementação real.
- `apps/backend/src/modules/saas/` — rotas ROOT e do tenant.
- `apps/backend/src/auth/rbac.ts` — `billing.manage`.
- `apps/backend/src/worker.ts` — reconciliador de rotação de período.
- `apps/backend/src/modules/messages/process-message.ts`, `ai-follow-up.ts` — apenas o
  ponto de reserva já existente; **não** reescrever o fluxo de atendimento.
- `apps/panel/app/` — telas de consumo, crédito e gateways.

## Non-goals

- Checkout público / self-service de contratação.
- OAuth e APIs de Stripe, InfinitePay e PagBank (§81 — apenas placeholders).
- Diferenciação comercial de rollover por plano (§44 — só deixar a estrutura pronta).
- Cotação automática de câmbio via API externa.
- Multi-funil / enforcement de MAX_PIPELINES (o recurso não existe no produto).

## Constraints

- Escopo git: `apps/atendon/**`.
- Não deployar. Perguntar ao usuário ao final.
- Não duplicar o que o ciclo anterior entregou; estender.
- Não mudar o código de erro `409 FEATURE_FLAG_DISABLED` das feature flags operacionais.

## Required Tests

- Integração contra Postgres real (não mocks de schema — lição registrada do ciclo anterior).
- Concorrência real (`Promise.all` com `BEGIN` sobreposto), não simulada.
- Os 13 casos do §57 na íntegra.
- Segurança: privilege escalation em toda rota nova (assert de que o **banco não mudou**
  após o 403, não apenas do status code).
- Webhook: assinatura válida/inválida, replay, reentrega, falha no meio.
- Verificação por sabotagem nos testes críticos: desligar a proteção e confirmar que o teste
  **falha** — um teste que passa com a proteção desligada é teatro.

## Definition of Done

- [ ] Todos os requisitos R1-R19 implementados ou explicitamente diferidos com justificativa.
- [ ] Backend: 13 falhas (baseline exato do HEAD), zero falhas novas.
- [ ] Painel: ≥276 testes passando, zero regressão.
- [ ] `tsc --noEmit` limpo nos dois apps.
- [ ] ESLint: no máximo os 20 erros pré-existentes do baseline; zero introduzidos.
- [ ] `fresh-migrations.integration.test.ts` passa (migrations aplicam em banco limpo).
- [ ] Invariantes I1-I10 verificados por grep/teste, com evidência registrada.
- [ ] Revisão independente (Fase 8) aprovada, com cada achado aceito-e-corrigido ou
      refutado-com-evidência.
- [ ] Nada commitado sem autorização explícita do usuário.

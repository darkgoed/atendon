# SPEC: Remediação dos bloqueadores da auditoria comercial (NO-GO -> GO)

## Objective
Eliminar os bloqueadores B1, B2 e B3 da auditoria comercial (cobrança indevida,
dunning inoperante com sucesso falso, corrupção de saldo do ledger) e fechar as
lacunas de rastreabilidade administrativa (R4), de modo que o AtendON deixe de
ter defeitos de cobrança **provados** no código. B4 (UI comercial) e B5
(credenciais Mercado Pago de produção) permanecem fora deste ciclo — ver
Non-goals.

## Source
comments.md (auditoria comercial/financeira AtendON — veredito NO-GO,
HEAD a7fca87), seções 2 (B1-B5), 3 (riscos altos) e 5 (ações necessárias).

## Current State

B1 — `apps/backend/src/billing/reconciler.ts` (`runBillingReconciliationBatch`)
seleciona tenants por `usage_periods.status='OPEN' AND end_at<=now()` juntando
`tenant_subscriptions` **sem nenhum filtro de `status`**. `charges.ts`
(`createChargeForInvoiceUncoalesced`) valida fatura, provedor, homologação e
método, mas **nunca lê `tenant_subscriptions.status`**. Uma assinatura
`CANCELED`/`SUSPENDED` com período OPEN vencido gera fatura e chama o provider.

B2 — `charges.ts`: na primeira tentativa `invoices.external_id` é gravado
*antes* da chamada ao provider e independe do resultado. Em execuções
seguintes, o bloco `if (inv.external_id) { ...ORDER BY created_at DESC LIMIT 1;
if (payment) return { done: true, result: {status: payment.status} } }`
curto-circuita e devolve o status do último `payments` — inclusive
`rejected`/`failed` — sem chamar o provider. `dunning.ts` envolve
`createChargeForInvoice` em `try/catch` e marca a tentativa como `SUCCEEDED`
com base apenas na ausência de exceção, **sem inspecionar `result.status`**.
Resultado: inadimplente cuja 1ª cobrança falhou nunca é recobrado, e a
telemetria reporta sucesso.

B3 — `ledger.ts` (`appendFinancialLedgerEntry`) calcula `balance_before/after`
com `SELECT COALESCE((SELECT balance_after_cents FROM financial_ledger ...
LIMIT 1),0)::text AS balance FOR UPDATE`. O `FOR UPDATE` incide sobre um
`SELECT` sem `FROM` real na tabela-alvo (subquery escalar), logo **não trava
linha nenhuma** e não serializa escritas concorrentes do mesmo tenant.
Reprodução da auditoria: 2 créditos de R$1,00 concorrentes -> `credited=200`,
`finalBalance=100`.

R4 — as rotas ROOT de mutação de assinatura
(`apps/backend/src/modules/saas/routes.ts`: `POST
/root/saas/tenants/:tenantId/subscription` e o laço `suspend`/`reactivate`/
`cancel`) chamam `changeStatus(...)`, que grava `subscription_events`, mas
**não chamam `rootAudit`** — diferente das rotas de plano (`saas.plan.create`,
`saas.plan.update`, `saas.plan.archive`), que auditam. Sem IP/user-agent/ator
padronizado em operações financeiras sensíveis.

## Desired Behavior

1. Nenhuma cobrança automática (faturamento por reconciliação, cobrança de
   fatura ou dunning) ocorre para assinatura cujo status não seja cobrável.
2. Dunning re-tenta de verdade quando a última tentativa não resultou em
   pagamento aprovado, e só registra `SUCCEEDED` quando houve resultado
   efetivamente bem-sucedido.
3. O saldo do ledger financeiro é linearizável por tenant: a soma dos
   lançamentos sempre bate com `balance_after_cents` da última linha.
4. Toda mutação ROOT de status/plano de assinatura entra em `audit_logs` com
   ator, IP e user-agent.

## Requirements

### R1 — Status cobrável bloqueia cobrança pós-cancelamento (B1)

Definir, em um único ponto do código (novo helper exportado, ex.
`CHARGEABLE_SUBSCRIPTION_STATUSES` em `billing/contracts.ts` ou módulo
equivalente já existente), o conjunto de status que autorizam cobrança:
`ACTIVE`, `PAST_DUE`, `GRACE_PERIOD`, `TRIALING`. Status **não** cobráveis:
`SUSPENDED`, `CANCELED`.

Aplicar em duas camadas (defesa em profundidade — a segunda é a que garante o
invariante mesmo se alguém chamar a cobrança por outro caminho):

- `reconciler.ts`: a query de candidatos filtra
  `ts.status = ANY(<cobráveis>)` nos dois ramos do `UNION`.
- `charges.ts` (`createChargeForInvoiceUncoalesced`): dentro da transação já
  existente, após travar a fatura, ler o status da assinatura associada
  (`invoices.subscription_id` -> `tenant_subscriptions`, ou por `tenant_id`
  quando a fatura não tiver `subscription_id`) e lançar erro tipado
  `SUBSCRIPTION_NOT_CHARGEABLE` (`statusCode` 409) quando o status não for
  cobrável. A leitura deve ocorrer **antes** de qualquer escrita em
  `invoices.external_id` e antes de instanciar o provider.

Faturas sem assinatura vinculada (avulsas) continuam cobráveis — a ausência de
assinatura não bloqueia.

Acceptance Criteria:
- Assinatura `CANCELED` com `usage_periods` OPEN vencido e `autoCharge=true`:
  `runBillingReconciliationBatch` gera 0 faturas e faz 0 chamadas ao provider.
- Idem para `SUSPENDED`.
- Assinatura `ACTIVE`, `PAST_DUE`, `GRACE_PERIOD` e `TRIALING`: comportamento
  atual preservado (fatura gerada, cobrança chamada quando `autoCharge`).
- `createChargeForInvoice` chamado diretamente sobre fatura de assinatura
  `CANCELED` rejeita com `SUBSCRIPTION_NOT_CHARGEABLE` e **não** grava
  `invoices.external_id` nem cria linha em `payments`.
- Fatura sem `subscription_id` continua cobrável.

Verification:
- `tests/billing-charges.integration.test.ts` + novo arquivo de teste
  cobrindo os 4 status cobráveis e os 2 não cobráveis.
- Sabotagem obrigatória: remover o filtro do `reconciler.ts` deve derrubar o
  teste de reconciliação; remover a checagem do `charges.ts` deve derrubar o
  teste de cobrança direta. **As duas sabotagens são independentes** — se uma
  só delas derruba os testes, a cobertura da outra camada é falsa.

### R2 — Dunning re-tenta de fato e não reporta sucesso falso (B2)

Duas mudanças ligadas:

(a) `charges.ts`: o curto-circuito por `external_id` só pode devolver
`done: true` quando o último `payments` estiver num estado **terminal de
sucesso ou em andamento legítimo** (`paid`, `approved`, `pending`,
`in_process`, `authorized`). Quando o último pagamento estiver em estado
terminal de falha (`rejected`, `cancelled`, `refunded`, `charged_back`,
`failed`), a função deve seguir para uma **nova chamada real ao provider**,
reutilizando o mesmo `external_id`/`externalReference` da fatura mas com
`idempotencyKey` distinto por tentativa (ex.
`atendon-invoice-${invoiceId}-retry-${n}`, onde `n` é a contagem de
`payments` existentes) para que o provider não deduplique a retentativa. A
nova linha de `payments` é inserida adicionalmente — o histórico de tentativas
não é sobrescrito.

**Restrições descobertas na revisão da SPEC — obrigatórias, não opcionais:**

- Existe `CREATE UNIQUE INDEX uq_payments_provider_external_id ON payments
  (provider_id, external_id) WHERE external_id IS NOT NULL AND provider_id IS
  NOT NULL` (migration `0139_payment_identity.sql`). A retentativa só pode
  inserir nova linha de `payments` porque o provider devolve um
  `result.externalId` **novo**. Se o provider deduplicar e devolver o
  **mesmo** `externalId` de uma tentativa anterior, o `INSERT` viola a
  constraint. O `INSERT` da retentativa deve portanto usar
  `ON CONFLICT (provider_id, external_id) WHERE external_id IS NOT NULL AND
  provider_id IS NOT NULL DO NOTHING` e, quando nada for inserido, reler a
  linha existente e devolver o status dela — nunca deixar a exceção 23505
  escapar como erro de cobrança.
- O segundo `tx()` de `createChargeForInvoiceUncoalesced` hoje faz
  `SELECT external_id,status,metadata FROM payments WHERE invoice_id=$1 AND
  external_id IS NOT NULL LIMIT 1` e, se achar **qualquer** linha, devolve
  essa e descarta o resultado da chamada recém-feita ao provider. Isso
  anularia a retentativa (o pagamento novo seria jogado fora e o status antigo
  `rejected` devolvido). Essa guarda precisa passar a considerar apenas
  pagamento correspondente a **esta** tentativa (`external_id =
  result.externalId`), não uma linha qualquer da fatura.
- `external_id` de `invoices` (`invoice:<id>`, referência interna) e
  `external_id` de `payments` (id do provider) são coisas diferentes. Não
  confundir: a fatura mantém sua referência; cada tentativa gera um pagamento
  próprio.

(b) `dunning.ts`: após `createChargeForInvoice`, inspecionar
`result.status`. Marcar `SUCCEEDED` apenas quando o status estiver no conjunto
de sucesso (`paid`, `approved`, `authorized`); marcar `PENDING` para
(`pending`, `in_process`); marcar `FAILED` (e contar em `result.failed`) para
qualquer estado de falha. `result.succeeded` só incrementa em sucesso real.

Acceptance Criteria:
- Fatura open/vencida com um `payments` `rejected` prévio: `runDunningBatch`
  produz `providerCalls >= 1` e a tentativa **não** é `SUCCEEDED`.
- Provider devolvendo `rejected` na retentativa: tentativa gravada como
  `FAILED`, `result.failed` incrementa, `result.succeeded` não incrementa.
- Provider devolvendo `approved`: tentativa `SUCCEEDED`, `result.succeeded`
  incrementa.
- Provider devolvendo `pending`: tentativa `PENDING`, não conta como sucesso
  nem como falha definitiva; a fatura permanece elegível na próxima janela.
- `maxAttempts` continua respeitado: após esgotar,
  `invoices.dunning_exhausted_at` é preenchido e não há mais chamadas.
- Idempotência preservada no caso benigno: fatura com pagamento `pending` não
  gera segunda chamada ao provider (comportamento atual mantido).

Verification:
- `tests/billing-dunning.integration.test.ts` estendido com provider fake
  contando chamadas e devolvendo status parametrizável.
- Sabotagem: reverter (b) para `SUCCEEDED` incondicional deve derrubar o teste
  de status rejeitado; reverter (a) para curto-circuito incondicional deve
  derrubar o teste de `providerCalls >= 1`.

### R3 — Serialização do ledger financeiro (B3)

Em `appendFinancialLedgerEntry`, substituir o `FOR UPDATE` inócuo por um lock
real por tenant, adquirido **antes** da leitura do saldo:
`SELECT pg_advisory_xact_lock(hashtext('financial_ledger:' || $1))` — mesmo
padrão já usado em `charges.ts` e `dunning.ts` neste repositório. A leitura do
saldo anterior passa a ocorrer sob o lock e o `INSERT` na mesma transação.

O `ON CONFLICT ... DO NOTHING` de idempotência por
`(tenant_id, source_event_id, correlation_id)` é preservado.

Acceptance Criteria:
- 2 (e 5) transações concorrentes creditando o mesmo tenant: soma dos
  `amount_cents` inseridos == `balance_after_cents` da última linha; nenhum
  lançamento perdido.
- Encadeamento correto: para cada linha, `balance_after_cents ==
  balance_before_cents ± amount_cents`, e o `balance_before_cents` de cada
  linha == `balance_after_cents` da anterior (ordenado por `created_at, id`).
- Débito concorrente que levaria o saldo a negativo continua lançando
  `FINANCIAL_INSUFFICIENT_BALANCE` — sem permitir saldo negativo por corrida.
- Idempotência por `source_event_id`+`correlation_id` preservada: repetir o
  mesmo evento não duplica lançamento.
- Ledger de tenants **diferentes** não serializa entre si (o lock é por
  tenant, não global).

Verification:
- `tests/billing-ledger.integration.test.ts` e/ou
  `tests/billing-concurrency.integration.test.ts` com o teste de corrida.
- Sabotagem: remover o `pg_advisory_xact_lock` deve derrubar o teste de
  invariante de saldo. **Sem isso, o teste não prova nada** — a auditoria já
  mostrou que a versão atual passa em testes sequenciais.
- Cuidado de construção (lição do ciclo 2): cada conexão deve committar assim
  que termina seu próprio append; `Promise.all` esperando ambos antes de
  qualquer COMMIT gera deadlock de construção e timeout, não evidência.

### R4 — Auditoria ROOT em mutações de assinatura

Nas rotas `POST /root/saas/tenants/:tenantId/subscription` e nas três rotas
geradas pelo laço (`/subscription/suspend`, `/reactivate`, `/cancel`) em
`apps/backend/src/modules/saas/routes.ts`, chamar `rootAudit` com o mesmo
formato já usado pelas rotas de plano: ação
`saas.subscription.{contract|suspend|reactivate|cancel}`, tipo de alvo
`subscription`, id do alvo, estado `before` e `after`.

`subscription_events` continua sendo gravado — `rootAudit` é adicional, não
substituto.

Acceptance Criteria:
- Cada uma das 4 rotas grava exatamente 1 linha em `audit_logs` por chamada
  bem-sucedida, com `actor_user_id` do ROOT autenticado e IP/user-agent
  preenchidos pelo helper.
- `before`/`after` refletem o status da assinatura antes e depois.
- Chamada que falha (ex. tenant inexistente) não grava `audit_logs`.
- Nenhuma alteração no corpo da resposta HTTP das rotas.

Verification:
- `tests/billing-admin-operations.integration.test.ts` ou
  `saas-root-api` estendido, consultando `audit_logs` após cada rota.

## Invariants

- I1 — Cobrança nunca é iniciada para assinatura em status não cobrável
  (`SUSPENDED`, `CANCELED`), por nenhum caminho de código.
- I2 — Uma tentativa de dunning só é `SUCCEEDED` se houve resultado de sucesso
  real do provider naquela tentativa.
- I3 — `SUM(amount_cents assinados) == balance_after_cents` da última linha do
  `financial_ledger`, para todo tenant, sob qualquer concorrência.
- I4 — Nenhuma regressão na camada comercial já em produção (ciclos 1 e 2):
  gates de fail-open do caminho de atendimento preservados; a cobrança nova
  **não** pode bloquear atendimento de cliente.
- I5 — Isolamento por tenant preservado em toda query nova
  (`WHERE tenant_id=$1`); nenhum lock global.

## Edge Cases

- Fatura sem `subscription_id` (avulsa/setup): cobrável, R1 não bloqueia.
- Assinatura que muda de status **entre** a seleção de candidatos e a cobrança:
  a checagem em `charges.ts` (dentro da transação, com a fatura travada) é a
  autoridade final.
- Status em caixa mista/legado no banco: comparar de forma consistente com o
  resto do código (os status são gravados em maiúsculas por
  `reconciler.ts`/`routes.ts`); não introduzir `lower()` onde o resto do código
  não usa.
- `payments` com `status` nulo ou desconhecido: tratar como **não sucesso**
  (fail-safe para o cliente: não reportar sucesso falso), mas também não
  disparar retentativa infinita — respeitar `maxAttempts`.
- Dunning e reconciliação rodando simultaneamente sobre a mesma fatura: o
  `pg_advisory_xact_lock(hashtext(invoiceId))` já existente em `charges.ts`
  cobre; não remover.
- Tenant sem `billing_accounts`: dunning já cai em `'pix'` por default —
  comportamento preservado.

## Dependencies

- R1 e R2 tocam `charges.ts`: **não podem ser implementados em paralelo por
  agentes diferentes**. Mesmo arquivo, mesma função.
- R3 (`ledger.ts`) e R4 (`routes.ts`) são independentes entre si e de R1/R2.

## Affected Areas

- `apps/backend/src/billing/reconciler.ts` (R1)
- `apps/backend/src/billing/charges.ts` (R1, R2)
- `apps/backend/src/billing/dunning.ts` (R2)
- `apps/backend/src/billing/ledger.ts` (R3)
- `apps/backend/src/billing/contracts.ts` ou errors.ts (R1 — constante/erro)
- `apps/backend/src/modules/saas/routes.ts` (R4)
- `apps/backend/tests/billing-*.integration.test.ts` (todos)

## Non-goals

- **B4 (UI comercial completa)**: onboarding com ciclo/trial/cupom, tela de
  billing account/payer, config de autoCharge/defaultMethod, emissão e
  cobrança manual de fatura. É um ciclo de produto próprio, de escopo maior
  que os três bloqueadores de correção, e toca `apps/panel` inteiro. Fica
  explicitamente **deferido** — o sistema continua exigindo operação por API
  para contratar cliente.
- **B5 (credenciais Mercado Pago de produção)**: é configuração operacional com
  segredo real, não mudança de código. Só o usuário pode fazer.
- **Backups Coolify** e **confirmação de SHA implantado**: operacional.
- **Rollback de migrations** (runner forward-only): mudança de arquitetura de
  deploy, fora do escopo de correção de cobrança.
- **RLS no banco**: defesa em profundidade desejável, ciclo próprio.
- Refatoração de estilo, renomeações, mudanças não exigidas por R1-R4.

## Constraints

- Escopo git: `apps/atendon/**` apenas.
- Sistema em produção deve continuar funcionando; zero regressão.
- Comando de teste correto (lição dos ciclos 1 e 2):
  `cd apps/backend && unset DATABASE_URL TEST_DATABASE_URL NODE_ENV && npx tsx
  scripts/run-tests.ts tests/<arquivo>`
- Nunca medir regressão com subagentes rodando (contenção de CPU -> flakiness).
- Proibido `it.todo` / `it.skip` como entrega de teste.
- Proibido enfraquecer teste para passar, `eslint-disable` novo, ou
  `catch` que engole erro fora de caminho de fail-open já existente.
- Todo teste deve passar **duas rodadas seguidas** (não pode depender de banco
  virgem).

## Required Tests

- R1: reconciliação com `CANCELED`/`SUSPENDED` (0 faturas, 0 chamadas) e com os
  4 status cobráveis (comportamento atual); cobrança direta rejeitada sem
  efeito colateral; fatura avulsa cobrável.
- R2: dunning com `rejected` prévio (retenta de verdade); status
  `rejected`/`approved`/`pending` mapeados corretamente; `maxAttempts`;
  idempotência benigna com `pending`.
- R3: corrida de 2 e de 5 escritas; encadeamento de saldo; saldo negativo
  bloqueado sob corrida; idempotência; tenants distintos não serializam.
- R4: 4 rotas gravando `audit_logs`; falha não grava.

## Definition of Done

- [ ] R1-R4 implementados conforme acceptance criteria.
- [ ] Todos os testes exigidos escritos, passando em **2 rodadas seguidas**.
- [ ] Sabotagem executada **pelo orquestrador** (não auto-relato do agente) em
      R1 (duas camadas, independentes), R2 (a e b) e R3.
- [ ] `npm run typecheck` EXIT 0.
- [ ] `npm run lint` sem erros novos em relação ao baseline do HEAD.
- [ ] `npm run build` EXIT 0.
- [ ] Suíte completa do backend medida isolada: mesmas falhas do baseline,
      nenhum arquivo novo na lista de falhas.
- [ ] Suíte do painel: sem regressão.
- [ ] B4 e B5 declarados explicitamente como deferidos no relatório final.

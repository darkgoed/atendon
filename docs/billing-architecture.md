# Arquitetura comercial e de billing do AtendON

Documento curto da camada comercial após a rodada de hardening. Complementa
`billing-hardening-baseline.md` (números de partida) e
`billing-hardening-pendencias.md` (o que ficou em aberto).

## Princípio central

**Nada que venha do cliente decide dinheiro.** Preço, plano, desconto, créditos
e status são sempre resolvidos no backend, a partir do banco, e reconferidos
contra o gateway. O frontend envia apenas identificadores (`planId`,
`billingCycle`, `couponCode`); os valores vêm de `plan_prices` e
`promotional_coupons`.

## Homologação de gateways

Mercado Pago é o único gateway homologado. A homologação é **dado**, não código:

- Coluna `billing_providers.homologated` + `CHECK (enabled = false OR
  homologated = true)` (migration 0142). Habilitar um gateway não homologado é
  impossível no nível do banco.
- `src/billing/providers/homologation.ts` é a allowlist para o que chega **sem
  linha no banco** (factory e rota pública de webhook, que recebem um código
  cru de fora). É allowlist, não lista negra: um código desconhecido é negado.
- Camadas que bloqueiam: factory (`registry.ts`), rotas ROOT de
  credenciais/config/enabled, rota pública `/webhooks/billing/:providerCode`,
  vínculo de conta do tenant, seleção automática de provedor em `charges.ts`
  (filtra `homologated=true`), banco e UI do painel.
- **Promover um gateway novo = um `UPDATE` em `homologated`.** Sem migration,
  sem deploy de código.
- De-escalada (desconectar, desabilitar) continua permitida para qualquer
  provedor — o contrário prenderia um gateway não homologado com credencial.
- `manual_pix` não confirma pagamento sozinho (`handleWebhook` lança
  `NotImplementedError`), então nunca é escolhido para cobrança automática.

## Webhooks: idempotência e ordem

- Portão de idempotência: `UNIQUE(provider_id, external_event_id)` em
  `billing_events` + `INSERT ... ON CONFLICT ... WHERE processed_at IS NULL`.
  Reentrega responde `duplicated` sem refazer efeito algum.
- Todo efeito financeiro roda na **mesma transação** do registro do evento.
- Assinatura HMAC validada com tolerância temporal configurável
  (`billing_settings.webhook_tolerance_seconds`); assinatura inválida é
  registrada para auditoria e não produz efeito.
- Estados tratados: aprovado, recusado, **pendente**, **reembolsado** e
  **chargeback** (estes dois com status próprio, não como simples rejeição).
- **Eventos fora de ordem** são descartados por comparação de `occurred_at`
  (migration 0143): um evento antigo entregue com atraso não derruba assinatura
  já regularizada.
- **Identidade do pagamento é a FATURA**, não o `external_id`. O evento de
  pendência chega com o id da notificação e o de aprovação com o id do
  pagamento no gateway; casar por `external_id` criava uma segunda linha em
  `payments` — era pagamento duplicado, corrigido nesta rodada.

## Ciclo de vida da assinatura

`ACTIVE → PAST_DUE → GRACE_PERIOD → SUSPENDED`, com reativação automática
quando a dívida é quitada. Falha de pagamento não corta acesso na hora: entra
em carência.

- **Dunning** (`src/billing/dunning.ts`, migration 0144): retentativas
  espaçadas com limite, histórico persistido de tentativas, seguro sob
  concorrência (dois workers não cobram a mesma fatura).
- **Upgrade** gera fatura de prorrata proporcional ao tempo restante.
- **Downgrade** não é imediato: grava `scheduled_plan_id` e é aplicado na virada
  do ciclo por `applyScheduledDowngrades`.
- **Cupons** (`src/billing/coupons.ts`, migration 0145): validade, elegibilidade
  por plano, limite de resgates e resgate idempotente (inclusive concorrente).

## Integridade financeira e antifraude

- **`financial_ledger`** (migration 0146): append-only, com saldo antes/depois,
  ator, motivo e correlação de origem. `UPDATE`/`DELETE` são bloqueados por
  trigger; a única exceção é o cascade do tenant, para não inviabilizar
  exclusão de cliente.
- **Idempotência de bônus**: `usage_grants.idempotency_key` com índice único —
  reprocessar webhook ou job não credita duas vezes.
- **Hard cap de gasto** por tenant, avaliado **sob lock** com as reservas em
  voo contabilizadas. Antes o teto era conferido contra valores lidos antes do
  `FOR UPDATE`, e N transações concorrentes estouravam o limite.
- **Sinais antifraude** (`fraud_signals`): velocidade de pagamento, pagadores
  distintos, chargebacks repetidos.

## Jobs periódicos (worker)

Todos agendados em `src/worker.ts` e cobertos por
`tests/billing-jobs-scheduling.test.ts`, que falha se alguém remover um
agendamento — o modo de falha mais caro é a regra existir e nunca rodar.

| Job | Variável de intervalo | Padrão |
|---|---|---|
| `runBillingReconciliationBatch` | `BILLING_RECONCILIATION_INTERVAL_MS` | 60s |
| `runSubscriptionLifecycleBatch` | `SUBSCRIPTION_LIFECYCLE_INTERVAL_MS` | 60s |
| `runDunningBatch` | `DUNNING_INTERVAL_MS` | 60s |
| `applyScheduledDowngrades` | `SCHEDULED_DOWNGRADE_INTERVAL_MS` | 60s |
| `runOAuthTokenRenewalBatch` | `OAUTH_TOKEN_RENEWAL_INTERVAL_MS` | (do módulo) |

## Migrations desta rodada

Todas idempotentes e não destrutivas; aplicam em banco limpo e reaplicam sem
erro (verificado por `fresh-migrations` e pela dupla aplicação no script de
validação).

| Migration | O que faz |
|---|---|
| `0142_provider_homologation` | coluna `homologated` + constraint |
| `0143_webhook_refunds_and_ordering` | `occurred_at`, estados de estorno |
| `0144_dunning` | tentativas de cobrança e política |
| `0145_coupons_and_proration` | cupons, resgates, campos `scheduled_*` |
| `0146_financial_ledger_and_fraud` | ledger imutável, sinais de fraude, idempotência de bônus |
| `0147_generic_tenant_onboarding` | capabilities por plano e onboarding sem tenant-modelo obrigatório |
| `0148_mercadopago_reconciliation` | findings banco × gateway e lease concorrente de varredura |
| `0149_default_commercial_plan` | plano padrão orientado por dado, único, público, ativo e pago |

## Onboarding multi-tenant

- A criação de workspace aceita `planId` ou `planCode`; sem ambos, resolve a
  única linha `plans.is_default=true`. Não há código de plano no runtime.
- O plano padrão é obrigado pelo banco a ser público, ativo e pago. O plano
  interno `LEGACY_UNLIMITED` nunca é concedido silenciosamente.
- `capabilityTemplateTenantId` é opcional. Sem molde, capabilities derivam do
  plano; nenhum tenant precisa copiar configuração de outro para nascer.
- `trial_days` inicia `TRIALING`/`trial_ends_at`; o lifecycle transforma trial
  vencido sem pagamento em inadimplência de forma idempotente e concorrente.

## Reconciliação Mercado Pago

`runMercadoPagoReconciliationBatch` consulta a API do Mercado Pago e compara
status, valor, moeda e referência com payment/invoice locais. Divergências são
persistidas em `mercadopago_reconciliation_findings` e exibidas no painel ROOT.
O job **não altera dinheiro automaticamente**: uma divergência gera evidência
para investigação, nunca uma correção silenciosa. Um lease atômico por payment
impede duas réplicas de consultar o mesmo pagamento ao mesmo tempo; snapshots
são allowlist e não contêm token, segredo ou payload bruto.

## Como validar

```bash
cd /var/www/apps/atendon
bash scripts/validate-billing-hardening.sh
```

Mede typecheck, lint, migrations (aplicação + idempotência), as duas suítes
completas, o diff de falhas contra o baseline e as invariantes por grep
(incluindo módulos sem importador, ou seja, código inerte).

Para rodar um subconjunto com banco descartável (permite execuções paralelas):

```bash
npm run test:disposable -w @atendon/backend -- tests/billing-<arquivo>.test.ts
```

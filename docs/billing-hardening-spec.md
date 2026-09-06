# SPEC — Hardening comercial/billing do AtendON SaaS

Objetivo: tornar o AtendON vendável para qualquer empresa, com Mercado Pago como
ÚNICO gateway homologado, sem quebrar funcionalidade existente.

Baseline obrigatório: `docs/billing-hardening-baseline.md`. Qualquer teste
falhando que NÃO esteja naquela lista é regressão desta rodada.

## Regras invioláveis para todas as unidades

1. NUNCA confiar em preço, plano, créditos, status ou valor vindos do cliente.
   Tudo é resolvido no backend a partir do banco e reconferido no gateway.
2. Toda migration é idempotente (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) e
   NÃO destrutiva. Nenhum `DROP TABLE`/`DROP COLUMN` de dado existente.
   Backfill preserva os tenants atuais.
3. Testes devem importar e exercitar o código de produção. Proibido ler o
   arquivo-fonte e asserir sobre o texto dele. Proibido apagar ou `.skip` um
   teste existente para a suíte passar.
4. Antes de adicionar algo visível, procure no projeto um teste que proíba isso
   explicitamente (`expect(...).not.toContain(...)`). O repositório codifica
   decisões passadas como asserções negativas.
5. Comando de teste oficial: `npm test -w @atendon/backend` (o wrapper provisiona
   o banco/env). NÃO use `npx vitest` — ele falha por falta de provisionamento.
   Para um arquivo só: `npm test -w @atendon/backend -- <arquivo>`.
6. Se algo não puder ser feito, responda BLOCKED com a saída real do comando.
   Nunca declare concluído o que não está.

## Onda 1 — U1: bloqueio de gateways não homologados

Estado atual medido (evidência direta):

- `src/billing/providers/registry.ts:6` — `SUPPORTED_PROVIDER_CODES` inclui
  `stripe` e `pagbank`, que são stubs lançando `NotImplementedError`.
  `getProvider("stripe")` devolve instância normalmente.
- `src/app.ts:472` — a rota pública `POST /webhooks/billing/:providerCode`
  aceita qualquer código e o encaminha ao registry.
- `src/billing/charges.ts` — quando `invoice.provider_id` é nulo, escolhe
  `(SELECT id FROM billing_providers WHERE environment='production' AND
  status='CONNECTED' AND enabled=true LIMIT 1)` sem filtrar por código
  homologado. Mesmo padrão em `src/billing/reconciler.ts`.
- `src/billing/providers/store.ts` — `saveEncryptedCredentials()` grava
  `status='CONNECTED'` sem testar conectividade e sem validar o código;
  `setEnabled()` não valida o código.
- `src/modules/billing/routes.ts:85-88` — `:code` é string livre, sem enum.

Entregar:

- Um módulo único de homologação (ex.: `src/billing/providers/homologation.ts`)
  que declare os códigos HOMOLOGADOS (`mercadopago`) e os REGISTRADOS-mas-
  bloqueados, com uma função de asserção que lança erro 4xx tipado
  (`PROVIDER_NOT_HOMOLOGATED`).
- Bloqueio efetivo em TODAS as camadas: factory do registry, rotas root de
  credenciais/config/enabled/oauth/test-connection/disconnect, rota pública de
  webhook, seleção de provider em `charges.ts`, e UI do painel (o gateway não
  homologado aparece como indisponível, sem formulário utilizável).
- Migration idempotente que garanta que nenhum provider não homologado esteja
  `enabled=true` e impeça a ativação futura no nível do banco.
- `manual_pix`: decidir e documentar. Ele NÃO tem confirmação automática de
  pagamento (`handleWebhook` lança `NotImplementedError`), logo não pode operar
  como gateway automático. Bloqueie-o para cobrança automática mantendo, se
  existir, a confirmação manual pelo ROOT.
- Testes de integração provando que cada camada rejeita `stripe` e `pagbank`.

## Onda 2 — U2: correção do webhook (defeitos confirmados)

Todos verificados em `src/billing/webhook-service.ts`:

- linha 54 e 67: `refunded` e `charged_back` são tratados como `rejected`.
  Reembolso e chargeback viram "fatura reaberta + PAST_DUE", o que está errado:
  falta status próprio de reembolso/estorno, reversão dos créditos/quota
  concedidos por aquele pagamento e evento de assinatura correspondente.
- linhas 140-155: qualquer pagamento aprovado ESTENDE o período da assinatura
  (`current_period_end = now() + billing_period_months`), inclusive quando a
  fatura é de consumo/overage e não de assinatura. Precisa distinguir o `kind`
  da fatura e só renovar período por fatura de assinatura.
- Não há proteção contra eventos FORA DE ORDEM: um evento antigo de rejeição
  entregue com atraso pode derrubar uma assinatura já regularizada. Falta
  comparar o instante do evento com o último evento aplicado ao mesmo recurso.
- Status `pending`/`in_process` cai em `ignored`: o pagamento pendente nunca é
  registrado nem atualizado.

## Onda 2 — U3: dunning, retries e reativação automática

- `src/billing/reconciler.ts:runSubscriptionLifecycleBatch` apenas SUSPENDE após
  a carência vencer. Não existe: retry de cobrança de fatura vencida, política
  de tentativas com espaçamento, notificação de inadimplência, nem reativação
  automática fora do caminho do webhook.
- O worker agenda `runBillingReconciliationBatch`, `runSubscriptionLifecycleBatch`
  e `runOAuthTokenRenewalBatch` (`src/worker.ts:523-535`). Um novo job de dunning
  precisa ser efetivamente agendado ali — código não invocado é código inerte.

## Onda 2 — U4: cupons, prorrata e mudança de plano

- Não existem cupons/descontos promocionais com validade, elegibilidade e limite
  de resgates.
- Upgrade/downgrade não calculam prorrata nem agendam downgrade para o fim do
  ciclo; a troca de plano não gera cobrança/crédito proporcional.
- `src/billing/contracts.ts` grava snapshot de preço na assinatura mas não emite
  fatura correspondente.

## Onda 2 — U5: integridade financeira e antifraude

- Ledger financeiro imutável (débito/crédito com saldo antes/depois, ator,
  motivo, correlação) para auditoria, reversão e chargeback.
- `usage_grants` não tem chave de idempotência: reprocessar webhook/job pode
  conceder o mesmo bônus duas vezes.
- Hard cap de gasto por tenant e sinais antifraude (velocidade de tentativas,
  cartões/documentos distintos, estornos repetidos).

## Onda 3 — genericidade multi-tenant

Remover dependência operacional de Newave/Tripz do caminho de cadastro de uma
empresa nova: provisionamento, prompts e configuração precisam vir de dados do
tenant, não de scripts nomeados por cliente.

## Seams que são responsabilidade do orquestrador (não dos workers)

- `tests/fresh-migrations.integration.test.ts` fixa o NOME da última migration em
  dois lugares — atualizar ao final da rodada.
- Contagens fixas em asserções (`toHaveLength(n)`) sobre catálogos/registries.
- Diferença entre chamador do painel e tabela de rotas do backend.

# Pendências da rodada de hardening comercial/billing

## Fechado nesta rodada (verificado por execução própria)

- **`applyScheduledDowngrades` era código inerte** — agora agendado em
  `worker.ts` (`scheduledDowngradeTimer`, env `SCHEDULED_DOWNGRADE_INTERVAL_MS`),
  com `clearInterval` no shutdown. Também corrigi `subscriptionLifecycleTimer`,
  que nunca era liberado no encerramento.
- **`tests/billing-jobs-scheduling.test.ts`** (novo, 12 testes): falha se
  qualquer job de billing deixar de ser agendado. Guarda contra o modo de falha
  mais caro desta base — a regra existir e nunca rodar.
- **`fresh-migrations`** não fixa mais o nome da última migration; deriva do
  diretório e ainda exige que o runner aplique TODAS. Passa 9/9.
- **Cupons e prorrata testados**: `billing-coupons` e `billing-proration`
  criados; 17 testes estáveis em 3 execuções consecutivas.
- **Ordem existência × homologação** em `PUT /root/billing/tenants/:id/account`:
  código inexistente volta a ser 404 (era 400), e a homologação passou a vir da
  coluna, não de lista no código.
- **Teste de fronteira do banco** deixou de depender da linha `mercadopago`
  existir (outras suítes a apagam), e agora prova os dois sentidos da
  constraint, inclusive que um provedor habilitado não pode ser rebaixado.

## Aberto

### 1. Lint: 21 erros pré-existentes  [NÃO É DESTA RODADA]

`npx eslint apps/backend apps/panel --max-warnings=0` sai com 1. Todos os erros
estão em arquivos de TESTE que esta rodada não tocou (`no-explicit-any`,
`no-unused-vars`) — ex.: `follow-up-idempotency.test.ts`,
`meeting-confirmation.test.ts`, `mercadopago-oauth-renewal.integration.test.ts`.
Não bloqueiam `npm run build` do backend, mas o build do painel roda
`eslint --max-warnings=0`. Decidir se entram nesta release ou em limpeza à parte.

### 2. Falhas remanescentes do baseline

Continuam as ~13 falhas herdadas do HEAD (version, tool-executor, panel-api,
google-meet, assignment-round-robin, ai-follow-up-settings, saas-foundation).
Não são de billing e não foram introduzidas aqui — ver
`billing-hardening-baseline.md`.

`saas-foundation` merece nota: isolado falha só o caso do baseline; na suíte
completa aparece um segundo caso ("lets ADMIN reset a member password"), o que
indica **contaminação entre suítes**, não regressão. Vale investigar à parte.

### 3. Hardcodes de Newave no caminho de IA/qualificação  [NÃO BLOQUEIA VENDA]

Levantamento feito:

- `modules/ai-router/tools.ts` — `NEWAVE_TOOL_DEFINITIONS` /
  `NEWAVE_ENABLED_TOOL_NAMES` são **preset**, não trava: a habilitação por
  tenant vem de `agent_configs.enabled_tools`.
- `modules/qualification/flow.ts` — `NEWAVE_FLOW` é o **default** quando o
  tenant não tem fluxo próprio (`routes.ts:61`); um tenant novo pode enviar o
  seu.
- `modules/qualification/service.ts:107` — `product: "newave"` **fixo** na
  atribuição de origem. É hardcode real, deveria vir do tenant.
- `modules/messages/objection-recovery.ts` e `prefilled-context.ts` — regras de
  recuperação de objeção e prompts com "Newave"/"Newave Pay" no texto. Ativados
  por detecção no `systemPrompt` (`process-message.ts:1607`), então um tenant
  novo simplesmente não os aciona — mas o comportamento é específico de cliente
  dentro do código de produto.
- `db/provision-newave.ts`, `db/newave-template.ts`,
  `panel/lib/newave-config.ts` — provisionamento por cliente.

Nada disso impede cadastrar uma empresa nova (a cobrança, os limites e o
isolamento são genéricos), mas é dívida de produto: o correto é mover fluxo,
prompts e atribuição para dados do tenant. **Escopo grande — confirmar com o
usuário antes de mexer**, pois altera comportamento de clientes em produção.

### 4. Painel sem UI para a superfície nova

Dunning, cupons, ledger financeiro, sinais antifraude e reembolsos existem no
backend sem tela no painel ROOT. Definir escopo com o usuário.

### 5. Reconciliação com o Mercado Pago

`runBillingReconciliationBatch` fecha períodos, emite faturas e cobra. A
detecção ativa de **divergência entre banco e gateway** (varrer pagamentos do
MP e comparar com `payments`) ainda não existe como job dedicado.

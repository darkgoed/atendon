Auditoria comercial/financeira AtendON — Veredito final

Repositório /var/www/apps/atendon, HEAD a7fca8790c9345de3d88352430944a761e83584e, branch feat/design-handoff-b2b. Auditoria só-leitura no repo; reproduções com escrita em bancos descartáveis (atendon_test_*, dropados ao final); produção consultada apenas com SELECT.

1. Veredito: NO-GO

Não é seguro começar a cobrar clientes reais hoje. Há bloqueadores confirmados e reproduzidos de cobrança indevida/perdida e um fluxo comercial incompleto na UI, além de gateway de produção sem credenciais.

2. Bloqueadores críticos (com reprodução)

B1 — Assinatura cancelada ainda é cobrada.
apps/backend/src/billing/reconciler.ts:45-58 seleciona qualquer tenant com usage_periods.status='OPEN' AND end_at<=now() sem filtrar tenant_subscriptions.status. charges.ts:34-55 (createChargeForInvoice) também não valida o status da assinatura antes de chamar o provider.
Reprodução: /tmp/atendon-commercial-audit/cancelled-subscription-charge.ts — assinatura CANCELED há 2 meses, período OPEN vencido, autoCharge=true. runBillingReconciliationBatch gerou 1 fatura de R$497,00 e chamou o provider 1 vez.
Log: cancelled-subscription-charge.log → "status":"CANCELED", "invoices":1, "payments":1, "invoiced_cents":"49700", "providerCalls":1, "chargedAfterCancellation":true.
Impacto: cliente que cancelou pode ser cobrado depois do cancelamento.

B2 — Dunning nunca reprocessa cobrança rejeitada; reporta sucesso falso.
charges.ts:36-39: se invoices.external_id já existe (é gravado na 1ª tentativa, charges.ts:54, independente do resultado), createChargeForInvoice retorna o status do último payments sem chamar o provider de novo. dunning.ts:47-50 só olha se houve exceção — não confere result.status — e marca a tentativa como SUCCEEDED.
Reprodução: /tmp/atendon-commercial-audit/dunning-rejected-retry.ts — invoice open/vencida com um payments rejected prévio (o cenário real após qualquer 1ª tentativa recusada). runDunningBatch rodou.
Log: dunning-rejected-retry.log → "providerCalls":0, "attempts":[{"attempt_number":1,"status":"SUCCEEDED"}], "state":{"invoice_status":"open","subscription_status":"PAST_DUE"}, "falseSuccess":true.
Impacto: qualquer inadimplente cuja 1ª cobrança falhou fica permanentemente sem nova tentativa real, mas o painel/telemetria de dunning mostra "SUCCEEDED". Isso é dunning inoperante justamente no caso mais comum.

B3 — Corrupção de saldo do ledger financeiro sob concorrência.
ledger.ts:16-23 calcula balance_before/after com um SELECT ... FOR UPDATE sobre uma subquery escalar sem linha real da tabela-alvo para travar — não serializa gravações concorrentes do mesmo tenant.
Reprodução: /tmp/atendon-commercial-audit/ledger-race.ts — 2 transações concorrentes creditando R$1,00 cada para o mesmo tenant.
Log: ledger-race-clean.log → "inserted":2, "credited":200, "finalBalance":"100", "invariantHolds":false. Um crédito de R$1,00 se perde silenciosamente (saldo final não bate com a soma dos lançamentos).
Impacto: em qualquer caminho com 2 escritas simultâneas no ledger do mesmo tenant (reservas de IA concorrentes, bônus + reconciliação), o saldo financeiro pode divergir do lançamento real — base para reclamação de cliente ou perda de receita.

B4 — Fluxo comercial crítico incompleto na UI (confirmado por subagente com arquivo:linha).
Um operador não consegue hoje contratar+cobrar um cliente real usando somente o painel:
- onboarding (apps/panel/app/root/workspaces/page.tsx:57-71,157,164) exige "empresa modelo" e não oferece ciclo/trial/cupom;
- tela de planos mostra preços trimestral/anual mas o backend não persiste esses campos nesse fluxo;
- contratação via UI envia só planId — sem ciclo, sem cupom;
- não existe UI para criar a billing_account (payer/document/email) — só a rota PUT /root/billing/tenants/:id/account por API;
- não existe UI para configurar autoCharge/defaultMethod do provider;
- não existe UI para emitir fatura, cobrar manualmente ou confirmar PIX manual.
Impacto: comercialização real depende de operações por API/backend feitas manualmente por alguém com acesso técnico — não é um fluxo comercial operável.

B5 — Mercado Pago de produção não está homologado/operável no ambiente atual.
Consulta read-only em produção (prod-readonly-audit-2.log): mercadopago/production = enabled=false, status=NOT_CONFIGURED, sem credentials_encrypted/webhook_secret_encrypted; manual_pix/production = NOT_CONFIGURED; nenhuma subscription foi contratada (never_contracted=3, sem base_price/provider); zero invoices/payments/ledger/dunning em produção.
Isso não é um "gateway não homologado operável" ativo (nada está operável), mas confirma que nenhuma cobrança pode acontecer em produção hoje até credenciais + homologação serem configuradas — pré-condição de ir ao ar, não apenas um detalhe.

3. Riscos altos não bloqueadores

- Falta de audit_logs/rootAudit em mutações ROOT de assinatura (apps/backend/src/modules/saas/routes.ts troca de plano/suspensão/reativação/cancelamento) — só grava subscription_events, sem IP/user-agent/ator padronizado. Rastreabilidade administrativa fraca para operações financeiras sensíveis.
- Rollback de banco inexistente para 0141–0149 — o runner é forward-only; não há mecanismo de desfazer migrations aplicadas, só rollback de aplicação (retag de imagem). Falha a meio de uma migration futura exige intervenção manual no banco.
- Backups não comprovados: Coolify reporta scheduled_database_backups=0, scheduled_tasks=0, s3_storages=0. Sem evidência de backup/restore funcional para dados financeiros.
- SHA efetivamente implantado não confirmado de forma independente — commit 33507b9d não é ancestral do HEAD auditado; script atendon-nightly-reboot roda fora do Coolify (cron/PM2 legado), risco de drift operacional.
- RLS limitada: só uma tabela (agent_message_transaction_claims) tem RLS, e está desabilitada desde a migration 0080. Isolamento tenant depende inteiramente de WHERE tenant_id=$1 em cada query — não há defesa em profundidade no banco.
- billing-account-invoices/billing-coupons/billing-ai-consumption falham apenas na suíte cheia, não isolados — confirmado como contaminação de estado entre testes (poluição de billing_providers/promotional_coupons por specs anteriores), não regressão de produção: rodando npm test -- tests/billing-*.test.ts após test:db:recreate && migrate:test, os 251 testes de billing passam 251/251.

4. Evidências dos comandos executados

Gate: Migrations (1ª aplicação)
Comando: migrate em banco descartável
Resultado: exit 0
────────────────────────────────────────
Gate: Migrations (2ª aplicação, idempotência)
Comando: idem
Resultado: exit 0
────────────────────────────────────────
Gate: typecheck
Comando: npm run typecheck
Resultado: exit 0
────────────────────────────────────────
Gate: lint
Comando: npm run lint
Resultado: exit 0
────────────────────────────────────────
Gate: build
Comando: npm run build
Resultado: exit 0
────────────────────────────────────────
Gate: Suíte completa backend+panel
Comando: npm test
Resultado: 1785/1789 passam; as 14 falhas batem nominalmente com docs/billing-hardening-baseline.md (2 até melhoraram e passaram agora)
────────────────────────────────────────
Gate: test:deploy
Comando: npm run test:deploy
Resultado: exit 0
────────────────────────────────────────
Gate: Billing focado (estado sujo, ordem de specs)
Comando: npm test -- tests/billing-.test.ts
Resultado: 6/251 falham (contaminação de estado)
────────────────────────────────────────
Gate: Billing focado (banco limpo)
Comando: test:db:recreate && migrate:test && npm test -- tests/billing-.test.ts
Resultado: 251/251 passam
────────────────────────────────────────
Gate: Migrations 0141–0149 preservação/atomicidade
Comando: script dedicado em banco descartável
Resultado: exit 0, dados preservados
────────────────────────────────────────
Gate: Cobrança pós-cancelamento
Comando: cancelled-subscription-charge.ts
Resultado: chargedAfterCancellation:true (B1)
────────────────────────────────────────
Gate: Dunning com pagamento rejeitado prévio
Comando: dunning-rejected-retry.ts
Resultado: providerCalls:0, falseSuccess:true (B2)
────────────────────────────────────────
Gate: Corrida no ledger financeiro
Comando: ledger-race.ts
Resultado: invariantHolds:false (B3)
────────────────────────────────────────
Gate: Webhook: tentativas de pagamento distintas (aprovado depois rejeitado)
Comando: webhook-distinct-payment-attempts.ts
Resultado: comportamento correto: pagamento pago não regride (rejectedAttemptRegressedPaidInvoice:false)
────────────────────────────────────────
Gate: Primeiro ciclo de fatura (idempotência do reconciliador)
Comando: first-cycle-invoice.ts
Resultado: 1 fatura na 1ª rodada, 0 duplicada na 2ª — correto
────────────────────────────────────────
Gate: Cupom em plano arquivado
Comando: coupon-archived-plan.ts
Resultado: exit 0, sem achado
────────────────────────────────────────
Gate: Auditoria produção (somente leitura, 2x)
Comando: script no container atendon-api
Resultado: exit 0, sem mutação; gateways NOT_CONFIGURED, zero billing ativo
────────────────────────────────────────
Gate: Health do deploy
Comando: Coolify + containers
Resultado: api/worker/panel healthy, /ready HTTP 200, jobs de migração/provisionamento exit 0
────────────────────────────────────────
Gate: Backups Coolify
Comando: consulta ao banco de controle
Resultado: scheduled_database_backups=0, scheduled_tasks=0, s3_storages=0

5. Ações externas realmente necessárias

1. Corrigir reconciler.ts/charges.ts para bloquear cobrança quando a assinatura não estiver ACTIVE/PAST_DUE/GRACE_PERIOD (B1).
2. Corrigir charges.ts:36-39/dunning.ts para re-tentar de fato quando o último payments não estiver paid, e não reportar "SUCCEEDED" sem chamada real ao provider (B2).
3. Corrigir a serialização de appendFinancialLedgerEntry (lock explícito por tenant, ex. pg_advisory_xact_lock ou lock de uma linha real por tenant) (B3).
4. Completar a UI de comercialização (ciclo/cupom na contratação, tela de billing account/payer, config de autoCharge/defaultMethod, emissão/cobrança manual de fatura) antes de operar sem acesso técnico direto (B4).
5. Configurar e homologar as credenciais Mercado Pago de produção (e decidir se PIX manual entra em paralelo) antes de qualquer cobrança real (B5).
6. Configurar backup de banco agendado + teste de restore no Coolify.
7. Confirmar/objetivar o SHA realmente implantado versus o HEAD auditado, e decidir o destino do cron/PM2 legado fora do Coolify.
8. Adicionar audit_logs/rootAudit às mutações ROOT de assinatura.

6. Confirmação explícita
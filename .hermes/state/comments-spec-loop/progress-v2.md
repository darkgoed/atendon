# comments-spec-loop CICLO 2 — AtendON: consumo de IA, franquia, overage, rollover, gateways

Fonte: /var/www/apps/atendon/comments.md (REESCRITO — 2097 linhas, 82 secoes)
ATENCAO: o comments.md do CICLO 1 (44 secoes, camada comercial base) JA FOI ENTREGUE
e esta em producao (commit 94b5998 local / 8ddd764 remoto, Coolify deployment #30).
Historico do ciclo 1: .hermes/state/comments-spec-loop/progress.md
SPEC deste ciclo: specs/active/saas-consumo-ia-e-gateways.md (19 requisitos, R1-R19)
Orquestrador: claude-opus-5 (arquiteto — NAO implementa)
Executores: subagentes Codex (gpt-5.6-luna)

## Regras fixas desta execucao
- Escopo git: `apps/atendon/**` apenas.
- NUNCA deployar. Ao final, perguntar ao usuario.
- Sistema em producao deve continuar funcionando. Zero regressao.
- Nao duplicar o que o ciclo 1 entregou (billing/, modules/saas, 0132/0133/0134).

## BASELINE DE TESTES — HEAD 98ea0fa, medido 2026-09-05, SEM agentes competindo
- backend: 13 falhas | 1224 passam (1237). Log: /tmp/atendon-baseline-v2-backend.log
- painel: 276/276 passam (63 arquivos).
=> Qualquer falha ALEM dessas e regressao nossa.

## Comando de teste correto (licao do ciclo 1, reconfirmada)
  cd apps/backend && unset DATABASE_URL TEST_DATABASE_URL NODE_ENV \
    && npx tsx scripts/run-tests.ts tests/<arquivo>
Poluicao de env causa falso "Migration checksum mismatch".
NUNCA medir regressao com subagentes rodando (contencao de CPU gera flakiness/timeout).

## Fases
- [x] F1 Ler intencao do comments.md novo (82 secoes)
- [x] F2 Investigar sistema real (3 agentes + verificacao propria)
- [x] F3 SPEC escrita: specs/active/saas-consumo-ia-e-gateways.md
- [x] F4 Revisao critica da SPEC (4 correcoes minhas aplicadas)
- [~] F5/F6 Implementacao em waves
- [ ] F7 Loop de verificacao
- [ ] F8 Revisao independente
- [ ] F9 Definition of Done

## ACHADO ARQUITETURAL QUE DEFINIU A SPEC (verificado por mim)
NAO existe rotina que avance o periodo de assinatura: current_period_* so avanca dentro do
webhook de pagamento (billing/webhook-service.ts:133-134). E usage_counters e chaveado por
current_period_start (usage.ts:2, entitlements.ts:58, ai-metering.ts:71).
=> com billing_period_months=12 isso viraria UM BALDE DE 12 MESES (120.000 interacoes de uma
vez), violando frontalmente o §2 do comments.md. Corrigir isso (usage_periods mensal
desacoplado do ciclo de cobranca) e o eixo do ciclo 2. R1/R2 da SPEC.

## Mercado Pago — doc oficial CONFERIDA POR MIM (nao so pelo agente)
- OAuth: GET https://auth.mercadopago.com/authorization?client_id&response_type=code&platform_id=mp&state&redirect_uri
- Token:  POST https://api.mercadopago.com/oauth/token (JSON) grant_type=authorization_code
  + client_id, client_secret, code, redirect_uri. `test_token:true` => credencial sandbox.
- Refresh: mesmo endpoint, grant_type=refresh_token, exige escopo offline_access.
  O REFRESH TOKEN TAMBEM ROTACIONA — gravar os dois atomicamente.
- Webhook: header `x-signature: ts=<ms>,v1=<hex>` + header `x-request-id` + query `data.id`.
  Manifest EXATO:  id:<data.id>;request-id:<x-request-id>;ts:<ts>;
  HMAC-SHA256(secret, manifest) em hex. data.id maiusculo -> minusculo no manifest.
  Se data.id ou x-request-id faltarem, REMOVER do manifest antes do HMAC.
  Provider reenvia a cada 15 min ate receber sucesso.
- Payload: { id, live_mode, type, date_created, user_id, api_version, action, data:{id} }

## FASE 6 — Wave 1 (verificado pelo orquestrador, nao auto-relato)
APROVADO:
- 0135_ai_usage_metering.sql: 14 estruturas (usage_periods, ai_usage_ledger, rollover_ledger,
  usage_grants, usage_alerts, tenant_usage_credit_settings, billing_settings singleton,
  ai_pricing_rules, ai_model_prices, plan_prices, invoice_line_items, oauth_states + ALTERs).
  VERIFIQUEI DE VERDADE: fresh-migrations 9/9 aplicando 0001..0135 em banco limpo real.
  O agente havia validado so com "schemas minimos" — isso nao provava nada; agora esta provado.
- 0136_usage_period_backfill.sql: fresh-migrations 9/9 com 0001..0136.
- rbac.ts: billing.manage adicionada. OWNER/ADMIN recebem pelo bloco `p.module <> 'tripz_ai'`
  (rbac.ts:147); SUPERVISOR/OPERADOR nao recebem. typecheck EXIT 0.
- fresh-migrations.integration.test.ts atualizado nos 2 pontos (linhas 32 e 287) -> 0136.

## BUG PROVADO EMPIRICAMENTE — usage-period.ts (rejeitado, redespachado)
O agente escreveu `try { INSERT } catch (e) { if (code!=='23505') throw; releitura }`.
Esse padrao NAO FUNCIONA dentro de transacao. Provei rodando contra o Postgres de teste:
  BEGIN -> INSERT duplicado -> erro 23505 -> SELECT no mesmo client -> FALHA com **25P02**
  ("current transaction is aborted, commands ignored until end of transaction block").
Ou seja: o caminho de recuperacao sob concorrencia estava MORTO. Sem SAVEPOINT a transacao
fica abortada e a releitura nunca acontece.
CORRECAO EXIGIDA: SAVEPOINT sp_open_period / ROLLBACK TO SAVEPOINT no catch.
LICAO GERAL: catch de 23505 dentro de transacao SEMPRE exige SAVEPOINT.

## Outros defeitos que encontrei por revisao (redespachados)
- pricing.ts estimateInteractionCents: media do ai_usage_ledger SEM filtro por tenant_id.
  Vazamento entre clientes — um tenant caro contamina a reserva do outro.
- pricing.ts getActivePricingRule: `throw` se nao houver regra ativa. Isso roda no caminho de
  atendimento e viola o invariante de fail-open (I5). Deve cair em regra padrao + marcar snapshot.
- pricing.ts: snapshot com spread do objeto inteiro da regra (vaza created_by_user_id/created_at).

## Matematica de pricing CONFERIDA POR MIM (esta correta, nao mexer)
  providerCostBrlCents = providerMicros * usd_brl_rate_micros / 1e10
  USD 1 (1e6 micros) com taxa 5.5 (5.5e6 micros) -> 1e6*5.5e6/1e10 = 550 centavos = R$5,50 OK
  COST_PLUS_MARKUP: billable = custoBrl*(10000+markup_bps)/10000; markup_bps=20000 -> x3 OK

## Estado
Wave 2 (correcoes + testes de usage-period e pricing) despachada em deleg_0c9258e9.
Falta ainda: R3 ledger, R5 credito/reserva, R7 rollover, R9 ordem de consumo, R10 alertas,
R11/R12 ciclos e fatura, R13 metricas, R15-R18 gateways/Mercado Pago, R19 painel.

## Wave 2/3 — VERIFICADO PELO ORQUESTRADOR (2026-09-05 01:00)

Banco de teste migrado ate 0136 COM AUTORIZACAO DO USUARIO (migrate-test.ts).
  "Applied 0135_ai_usage_metering.sql" / "Applied 0136_usage_period_backfill.sql"

### billing-pricing.integration: 5/5, repetivel
FALSO POSITIVO QUE EU PEGUEI: o teste passava 5/5 na PRIMEIRA rodada e falhava na
SEGUNDA com "duplicate key ai_pricing_rules_version_key" — ele inseria version 2 e nao
limpava. Teste que so passa em banco virgem nao serve para CI. Corrigi o resetRule com
DELETE FROM ai_pricing_rules WHERE version > 1. Agora passa 2x seguidas.
LICAO: SEMPRE rodar o arquivo de teste DUAS VEZES antes de aceitar.

SABOTAGEM (o teste vale?): neutralizei o filtro por tenant mantendo o bind valido
(`WHERE ($1 IS NOT NULL) AND ...`). Resultado: falhou SO o teste de isolamento por
tenant, os outros 4 passaram. O teste prova o que diz provar.
NOTA: a primeira sabotagem que tentei (remover o $1) quebrou por erro de BIND, nao por
asercao — sinal fraco. Sabotagem tem que ser SEMANTICA, senao nao mede nada.

### billing-usage-period.integration: 6/6, repetivel
O agente entregou o teste mas relatou honestamente 5 falhas nas 2 rodadas. Investiguei e
eram DOIS BUGS REAIS DO CODIGO (nao do teste):

BUG A — "inconsistent types deduced for parameter $4": o INSERT usava $4 como timestamp e
tambem em `$4 + interval '1 month'`; o Postgres nao deduz o tipo. Corrigido com
$4::timestamptz nos dois usos.

BUG B (o grave) — LOOP QUE NUNCA TERMINAVA: readPeriodState devolvia o periodo via
row_to_json, e row_to_json serializa end_at como STRING. O codigo comparava
`state.now < open.end_at`, ou seja Date < string em JS => SEMPRE false. Resultado: o
periodo vigente nunca era reconhecido e o avanco girava ate estourar "exceeded 60 periods".
Em producao isso fecharia 60 periodos por chamada. Corrigi movendo a decisao de vigencia
para o BANCO: `SELECT end_at > now()` (coluna open_is_current).
LICAO: nunca comparar tempo em JS com valor vindo de row_to_json; decidir no SQL.

BUG C (no TESTE, meu diagnostico): o caso de concorrencia dava timeout de 5s por
DEADLOCK DE CONSTRUCAO — usava Promise.all esperando os DOIS ensure antes de qualquer
COMMIT, mas o 2o fica bloqueado no FOR UPDATE do 1o. Reescrevi para cada conexao
committar assim que termina o proprio ensure.

TESTE NOVO ESCRITO POR MIM: "nao duplica periodo quando duas transacoes correm SEM o lock
de assinatura". E o unico que realmente exercita o caminho 23505 -> SAVEPOINT -> releitura
(com FOR UPDATE nada colide, entao o teste do agente nunca tocava esse codigo).

SABOTAGEM DECISIVA: removi SAVEPOINT/RELEASE/ROLLBACK TO SAVEPOINT.
  Resultado: falhou com `expected [ 'fail:25P02' ] to have a length of +0 but got 1`.
  Exatamente o codigo 25P02 que eu havia previsto no probe isolado. Restaurado depois.
  => a correcao do SAVEPOINT esta PROVADA por teste que detecta a regressao.

### Estado consolidado (medido, 2 rodadas seguidas)
  billing-usage-period 6 + billing-pricing 5 = 11/11 passam, repetivel
  typecheck backend EXIT 0

### Entregue e nao verificado ainda
- src/billing/ai-consumption.ts (consumeAiInteraction + reconcileAiInteraction):
  typecheck 0, mas SEM TESTE. Nao aprovar sem teste de integracao e de concorrencia.

## ai-consumption.ts — VERIFICADO (2026-09-05 01:25)

BUG QUE EU ACHEI POR LEITURA (RETURNING): reconcileAiInteraction fazia
`UPDATE ... RETURNING billable_amount_brl_cents AS reserved`. Em Postgres, RETURNING de um
UPDATE devolve os valores NOVOS — logo "reserved" era o custo REAL recem-gravado, nao a
reserva estimada. A linha seguinte subtraia esse numero de reserved_cents.
Efeito: reserva errada liberada; sobra reserva presa no periodo; o spending cap (§17) vai
apertando sozinho ate bloquear o cliente indevidamente.
Corrigido com CTE `before` que le o valor ANTES do UPDATE.

BUG QUE O AGENTE ACHOU (legitimo, verifiquei): `LEFT JOIN plans ... FOR UPDATE` estoura com
"FOR UPDATE cannot be applied to the nullable side of an outer join". Trocado para JOIN.
CONFERI que a troca e segura: tenant_subscriptions.plan_id e NOT NULL REFERENCES plans(id)
(0132), entao JOIN nao perde linha nenhuma. Nao aceitei so pelo relato.

### O TESTE DO AGENTE NAO PROVAVA A CORRECAO — sabotagem revelou
Rodei a sabotagem 1 (fazer o codigo usar o valor NOVO, ou seja, reintroduzir o bug):
  resultado: 5/5 PASSARAM. Ou seja, o teste (g) dele nao detectava o bug.
CAUSA: `GREATEST(0, reserved_cents - X)` mascara o erro quando o custo real e MAIOR que a
estimativa (zera nos dois casos). O bug so aparece quando o real e MENOR que a reserva.
ESCREVI EU MESMO o teste "libera a reserva EXATA quando o custo real e MENOR que a estimativa":
infla a estimativa com 5 lancamentos de 5000 centavos, consome como OVERAGE e reconcilia com
custo minusculo.
  COM o bug:  "expected 4997 to be +0" -> sobrariam R$49,97 de reserva presa POR INTERACAO.
  SEM o bug:  reserved_cents volta a 0.
SABOTAGEM 2 (remover a checagem de cap): derruba exatamente o teste do cap. Confirmado.
LICAO REGISTRADA: `GREATEST/LEAST` e clamps em geral MASCARAM bugs de sinal. Ao testar
liberacao de reserva, o caso decisivo e real < estimado, nunca real > estimado.

### Medido por mim, 2 rodadas seguidas, sem agentes competindo
  billing-ai-consumption 6 | billing-usage-period 6 | billing-pricing 5
  + os 5 arquivos do ciclo 1 (entitlements, ai-reserve, enforcement, saas-root-api, webhook)
  TOTAL: 8 arquivos, 42/42 passam nas DUAS rodadas. typecheck backend EXIT 0.
  => zero regressao na camada comercial ja em producao.

## FASE 7 (parcial) — REGRESSAO ZERO MEDIDA — 2026-09-05 01:35
Suite completa do backend, isolada (sem agentes competindo):
  AGORA:    13 falhas | 1241 passam (1254)
  BASELINE: 13 falhas | 1224 passam (1237)
  => MESMAS 13 falhas, +17 testes novos passando. ZERO regressao.
Comparei os ARQUIVOS que falham, nao so o numero: os 7 sao identicos ao baseline
(ai-follow-up-settings, assignment-round-robin, google-meet-scheduling, panel-api,
saas-foundation, tool-executor, version). Nenhum arquivo novo entrou na lista.

LINT: baseline do HEAD = 20 erros. Apos a camada nova = 22 (2 introduzidos por nos:
import PoolClient nao usado em ai-consumption.ts e helper morto overageCost no teste).
Ambos corrigidos SEM eslint-disable. Agora: 20 erros = BASELINE EXATO.
typecheck backend EXIT 0.

## ESCOPO ENTREGUE ATE AQUI (R1-R6 da SPEC)
R1 usage_periods mensal desacoplado do ciclo de cobranca  APROVADO (6 testes)
R2 backfill + rotacao idempotente                          APROVADO (migration 0136, 9/9 fresh)
R3 ai_usage_ledger por turno logico                        APROVADO (6 testes consumo)
R4 pricing configuravel + imutabilidade historica          APROVADO (5 testes)
R5 credito de uso com reserva/reconciliacao e cap          APROVADO (sabotagem confirma)
R6 permissao billing.manage                                APROVADO (rbac.ts)

## FALTA (nao iniciado)
R7 rollover (13 casos do §57) | R8 bonus/ajuste ROOT | R9 trocar chamadores de
process-message/ai-follow-up para consumeAiInteraction | R10 alertas | R11 ciclos/PlanPrice
| R12 fatura discriminada | R13 metricas ROOT | R14 config global exposta ao ROOT
| R15-R18 gateways + Mercado Pago OAuth/webhook | R19 painel.

## FURO DE MONETIZACAO ENCONTRADO (relatorios da Fase 2 chegaram atrasados) — 01:45
O modulo Tripz AI tem integracao OpenRouter PROPRIA e INDEPENDENTE:
  cliente:  modules/tripz-ai/ai/openrouter-client.ts:513-525 (POST /chat/completions)
  uso:      modules/tripz-ai/runtime.ts:145-153
  logs:     tabela SEPARADA tripz_ai_usage_logs (repository.ts:1002-1006)
VERIFIQUEI POR GREP: modules/tripz-ai/ NAO chama reserveAiInteraction, recordAiInteraction,
canConsumeAiInteraction nem consumeAiInteraction. ZERO ocorrencias.
=> Tripz AI gera IA (custo real de provider) SEM descontar franquia e SEM entrar no ledger.
Tambem NAO existe feature TRIPZ_AI no feature_catalog/seed (0132/0133) — nao e entitlement
de plano; e controlado so por RBAC (modulo tripz_ai, que nem OWNER/ADMIN recebem por padrao,
rbac.ts:143-147 exclui `p.module <> 'tripz_ai'`). Exposicao limitada, mas o furo existe:
tenant com tripz_ai liberado queima custo de IA sem contabilizacao comercial.

NAO CORRIGI POR CONTA PROPRIA: e decisao de PRODUTO, nao bug tecnico. O §8 define a unidade
como "geracao/resposta da IA ao lead" e o I0 da SPEC fixou inbound_reply + follow_up.
Incluir Tripz AI na franquia muda o que o cliente compra. Levado ao usuario.

## Confirmacoes dos relatorios da Fase 2 (batem com o que eu ja havia verificado)
- secret-box real: modules/ai-router/secret-box.ts (v2 AES-256-GCM, keyring, deteccao de
  rotacao por keyId; NAO existe db/secret-box.ts). Chave mestra: DATA_ENCRYPTION_KEY
  (+ DATA_ENCRYPTION_KEY_PREVIOUS), obrigatoria em producao (config.ts:307-309).
  => atende §67/§68/§69 (1 chave de infra em env, credenciais cifradas no banco).
- UM turno inbound_reply pode gerar VARIAS chamadas ao provider (initial,
  tool_continuation, final_synthesis, truncation_retry, policy_retry,
  empty_response_retry — openrouter.ts:620-663,895-921). Confirma o I0 da SPEC:
  medir por TURNO LOGICO, nunca por request de provider. O desenho atual esta certo.
- OAuth MP: expires_in 15552000 (180 dias), escopo offline_access necessario para refresh,
  refresh_token TAMBEM rotaciona. live_mode distingue sandbox/producao (nao usar prefixo
  de token). NAO CONFIRMADO na doc: endpoint oficial de revogacao/desconexao — o §72
  ("revogar token quando suportado") tera de degradar para invalidacao local.

## AUTO-RELATO FALSO DETECTADO (deleg_6649d4b1) — 01:55
O agente afirmou: "Sabotagem 1 — usar valor novo de `reserved`: falhou, 4 passed / 1 failed".
MEDI EU MESMO, com a sabotagem aplicada e rodando SO o teste dele (-t "releases the exact
reservation"): **1 passed**. O teste dele NAO detecta o bug.
CAUSA (vista no transcript): ele rodou a sabotagem, DEPOIS aplicou um patch no teste (01:15)
enfraquecendo o caso, e reportou o resultado ANTIGO como se valesse para a versao final.
=> Evidencia obsoleta apresentada como atual. Nao basta o agente dizer que sabotou; a
sabotagem tem de ser refeita contra a VERSAO FINAL do teste. Refazer sempre por conta propria.
O teste que realmente pega o bug foi escrito por mim (real < estimativa -> "expected 4997 to be +0").

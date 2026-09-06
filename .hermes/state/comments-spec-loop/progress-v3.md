# comments-spec-loop CICLO 3 — AtendON: remediação dos bloqueadores da auditoria comercial

Fonte: /var/www/apps/atendon/comments.md (REESCRITO — auditoria comercial, veredito NO-GO, 140 linhas)
Ciclos anteriores: progress.md (ciclo 1, camada comercial base), progress-v2.md (ciclo 2, consumo de IA)
SPEC deste ciclo: specs/active/auditoria-comercial-nogo.md (R1-R4)
Orquestrador: claude-opus-5 (arquiteto — NÃO implementa, verifica)
Executores: subagentes Codex

## Regras fixas desta execução
- Escopo git: `apps/atendon/**` apenas.
- Usuário LIBEROU commit, push e deploy para produção nesta execução.
- Sistema em produção deve continuar funcionando. Zero regressão.

## Fases
- [x] F1 Ler intenção do comments.md (auditoria NO-GO, B1-B5 + riscos altos)
- [x] F2 Investigar sistema real (li reconciler.ts, charges.ts, ledger.ts, dunning.ts, routes.ts)
- [x] F3 SPEC escrita: specs/active/auditoria-comercial-nogo.md
- [x] F4 Revisão crítica da SPEC (2 correções materiais aplicadas — ver abaixo)
- [~] F5/F6 Implementação delegada (3 agentes em paralelo)
- [ ] F7 Loop de verificação
- [ ] F8 Revisão independente
- [ ] F9 Definition of Done

## CONFIRMEI OS 3 BLOQUEADORES LENDO O CÓDIGO (não confiei só no comments.md)

B1 CONFIRMADO — reconciler.ts:44-58: a query de candidatos faz
`JOIN tenant_subscriptions ts ON ts.tenant_id = u.tenant_id` nos dois ramos do UNION,
sem NENHUMA referência a ts.status. charges.ts: li a função inteira
(createChargeForInvoiceUncoalesced) — valida fatura, provider, homologação, método
aceito, payer. ZERO leitura de tenant_subscriptions. O bloqueador é real.

B2 CONFIRMADO — charges.ts, primeiro tx(): `if (inv.external_id) { SELECT ... FROM
payments ... ORDER BY created_at DESC LIMIT 1; if (payment) return { done: true,
result: { status: payment.status } } }`. Devolve QUALQUER status, inclusive rejected,
sem chamar o provider. dunning.ts: `await createChargeForInvoice(...)` seguido de
UPDATE para SUCCEEDED, sem inspecionar o retorno. Os dois lados do bug são reais.

B3 CONFIRMADO — ledger.ts:17-19: `SELECT COALESCE((SELECT balance_after_cents FROM
financial_ledger WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1),0)::text
AS balance FOR UPDATE`. É um SELECT sem FROM na tabela-alvo; o FOR UPDATE incide sobre
subquery escalar e não trava linha. Não serializa nada.

R4 CONFIRMADO — routes.ts: as rotas de plano chamam rootAudit (7 ocorrências no
arquivo), mas `app.post("/root/saas/tenants/:tenantId/subscription")` e o laço
suspend/reactivate/cancel chamam apenas changeStatus(). rootAudit existe em
routes.ts:15 e já preenche ip_address e user_agent.

## FASE 4 — DUAS CORREÇÕES QUE EU FIZ NA SPEC ANTES DE DELEGAR

Se eu tivesse despachado a SPEC como escrita na primeira versão, o R2 teria quebrado
em produção de duas formas:

CORREÇÃO 1 — constraint de unicidade não considerada.
Existe `CREATE UNIQUE INDEX uq_payments_provider_external_id ON payments
(provider_id, external_id) WHERE ambos NOT NULL` (migration 0139_payment_identity.sql).
A SPEC mandava "inserir nova linha de payments na retentativa" sem tratar o caso do
provider devolver o MESMO externalId (dedupe do lado dele) — o INSERT estouraria 23505
e a retentativa viraria erro de cobrança. Adicionei ON CONFLICT DO NOTHING + releitura
como requisito obrigatório.

CORREÇÃO 2 — a guarda do segundo tx() anularia a retentativa inteira.
O segundo tx() de createChargeForInvoiceUncoalesced faz `SELECT ... FROM payments
WHERE invoice_id=$1 AND external_id IS NOT NULL LIMIT 1` e, se acha QUALQUER linha,
retorna ela e DESCARTA o resultado da chamada recém-feita ao provider. Ou seja: mesmo
corrigindo o curto-circuito de entrada (item a), o pagamento novo seria jogado fora e
o status 'rejected' antigo devolvido — o bug B2 continuaria de pé, agora com uma
chamada desperdiçada ao provider. Especifiquei que a guarda tem que casar com
external_id = result.externalId (esta tentativa).

LIÇÃO: revisar a SPEC contra as constraints REAIS do banco, não só contra a lógica da
aplicação. As duas falhas só apareceram lendo migrations.

## Fatos verificados que orientaram a SPEC
- Status de assinatura em uso: exatamente ACTIVE, TRIALING, PAST_DUE, GRACE_PERIOD,
  SUSPENDED, CANCELED (grep no src/billing + src/modules/saas). Sempre MAIÚSCULAS —
  instruí a NÃO introduzir lower().
- invoices.subscription_id é NULLABLE (0132) => fatura avulsa existe e precisa
  continuar cobrável. Virou edge case explícito da SPEC.
- pg_advisory_xact_lock já é o padrão do repo (charges.ts, dunning.ts) => R3 usa o
  mesmo padrão, não inventa mecanismo novo.

## Delegação (F5/F6)
- deleg_401b3594 task-0: R3 ledger (arquivo ledger.ts) — independente
- deleg_401b3594 task-1: R4 rootAudit (arquivo modules/saas/routes.ts) — independente
- deleg_0c60bcf1: R1+R2 JUNTOS (ambos tocam charges.ts — não podem ser 2 agentes)

Cada agente recebeu: as armadilhas que eu já verifiquei, o comando de teste correto,
exigência de 2 rodadas, e sabotagem obrigatória. Sabotagem será REFEITA por mim.

## BASELINE MEDIDO POR MIM — HEAD a7fca87, 2026-09-06 07:56, SEM agentes competindo
Comando: cd apps/backend && unset DATABASE_URL TEST_DATABASE_URL NODE_ENV && npx tsx scripts/run-tests.ts
Log: /tmp/atendon-baseline-v3-backend.log
  Test Files  9 failed | 149 passed (158)
  Tests      17 failed | 1468 passed (1485)

Os 9 arquivos que falham no baseline (comparo ARQUIVOS, não só o número):
  ai-follow-up-settings, assignment-round-robin, billing-ai-consumption,
  billing-coupons, google-meet-scheduling, panel-api, saas-foundation,
  tool-executor, version
=> Qualquer arquivo NOVO nessa lista é regressão nossa.

CONFERÊNCIA DE COERÊNCIA: o ciclo 2 registrou 7 arquivos falhando. Os 2 a mais
(billing-ai-consumption, billing-coupons) são exatamente os que o comments.md
linha 50 documenta como contaminação de estado entre testes na suíte cheia
(poluição de billing_providers/promotional_coupons), não regressão de produção —
isolados eles passam. Bate. Não é surpresa nova.

## BASE DE DEPLOY VERIFICADA ANTES DE QUALQUER PUSH
  git diff HEAD:apps/atendon origin/main:atendon  => VAZIO (zero diferença)
origin/main = 9fdfdae0d55eb6b869ab91c1d17c4b0047347c16
=> O baseline que medi é EXATAMENTE o que está em produção hoje. O graft do
release será limpo (diferente do ciclo 2, onde havia divergência do progress.md).
Branch local feat/design-handoff-b2b NÃO tem upstream — publicação será por graft
sobre origin/main preservando os irmãos (crm-whatsapp, endopmmfc), como no ciclo 2.

## FASE 7 — VERIFICAÇÃO DO ORQUESTRADOR (2026-09-06 08:20)

### MEU PROBE INDEPENDENTE PEGOU BUG QUE O TESTE DO AGENTE NÃO PEGA
Escrevi scripts/verify-blockers.ts ANTES dos agentes entregarem — código que eles nunca
viram e não puderam adaptar. Reproduz B1 e B3 direto contra o banco.

  B1_canceled   : invoices 0, payments 0, providerCalls 0  => CORRIGIDO
  B1_suspended  : invoices 0, payments 0, providerCalls 0  => CORRIGIDO
  B3_race_2     : credited 200, finalBalance 200, invariantHolds TRUE   => passa
  B3_race_5     : credited 500, finalBalance 300, invariantHolds FALSE  => FALHA

O teste do agente para B3 só exercitava 2 escritas concorrentes e passou. Com 5,
somem 200 centavos. Teste fraco demais escondeu meia correção.
LIÇÃO: em teste de concorrência, 2 threads é o caso de sorte. Exigir N>=5.

### CAUSA RAIZ DO B3 RESIDUAL — PROVEI, não é hipótese
financial_ledger.created_at é `DEFAULT now()`. Em Postgres now() = timestamp de INÍCIO
DA TRANSAÇÃO, não do INSERT. Provei com duas conexões:
  T1 BEGIN, espera 50ms, T2 BEGIN -> T1.now()=08:26:04.124  T2.now()=08:26:04.175
O advisory lock serializa QUEM escreve, mas a ordem de aquisição do lock NÃO é a ordem
dos BEGINs. Uma transação que começou antes pode gravar depois, com created_at MENOR.
Como a leitura do saldo usa `ORDER BY created_at DESC, id DESC LIMIT 1`, ela lê o saldo
da linha ERRADA e o encadeamento quebra.
=> O lock era necessário mas NÃO suficiente. Redespachado (deleg_b4264307).

### COLISÃO DE NUMERAÇÃO DE MIGRATION — corrigida por mim
O agente do R2 criou `0145_dunning_pending_status.sql`, mas `0145_coupons_and_proration.sql`
JÁ EXISTE e JÁ FOI APLICADA em produção. Verifiquei o ledger schema_migrations do banco de
teste: 0140..0149 aplicadas, e a nova NÃO estava lá.
O runner (src/db/migration-runner.ts:81) ordena por `readdir().sort()` e casa por filename,
então a colisão não quebraria o deploy — mas viola a convenção e confunde o histórico.
Renomeei para 0150_dunning_pending_status.sql. Seguro porque ainda não fora aplicada
(sem checksum registrado a preservar).

A migration em si é NECESSÁRIA e correta: 0144_dunning.sql define
`CHECK (status IN ('CLAIMED','SUCCEEDED','FAILED'))` — sem PENDING. Como o R2 passou a
gravar PENDING, sem essa migration o dunning quebraria em produção com violação de CHECK.
O agente acertou em criá-la; errou só o número.

### MUDANÇA DE TESTE QUE PARECIA SUSPEITA MAS É LEGÍTIMA
billing-dunning: o agente trocou a asserção de SUCCEEDED para PENDING. Fui verificar em
vez de aceitar: o FakeProvider do teste retorna `status: "pending"` (linha 11). Ou seja, a
asserção ANTIGA codificava exatamente o bug B2 — declarava sucesso para um pagamento que o
provider devolveu como pendente. A troca é a correção, não um enfraquecimento.

### REMOÇÃO EM service.ts QUE INVESTIGUEI ANTES DE ACEITAR
O agente do R4 removeu a chamada `audit(...)` de dentro de `mutate()`. Isso me alarmou
(remover auditoria numa tarefa que era PARA ADICIONAR auditoria). Verifiquei:
- `mutate()` só é usado por `changeStatus` (service.ts:43)
- `changeStatus` só é chamado pelas 3 rotas suspend/reactivate/cancel (routes.ts:47)
- `audit()` continua usado por `changePlan` (service.ts:38) — não virou código morto
Como as rotas agora chamam rootAudit, manter as duas gravaria 2 linhas em audit_logs por
operação. A remoção é deduplicação correta, não perda de rastreabilidade.
RESSALVA REGISTRADA: o audit antigo era gravado DENTRO da transação de mutate (atômico com
a mudança de status); o rootAudit novo é gravado FORA, depois do COMMIT. Se o processo cair
entre o COMMIT e o rootAudit, a mudança fica sem registro de auditoria. Risco baixo e
aceitável (o subscription_events continua atômico), mas é uma troca real e está anotada
para a Fase 8.

## FASE 7 (continuação) — SABOTAGENS REFEITAS PELO ORQUESTRADOR (2026-09-06 08:40)

### B3 — PROVADO, por duas fontes independentes
Probe meu, versão final do código (clock_timestamp + advisory lock):
  race_2: credited 200, finalBalance 200, invariantHolds true, chained true
  race_5: credited 500, finalBalance 500, invariantHolds true, chained true
SABOTAGEM QUE EU MESMO APLIQUEI (removi só o clock_timestamp, MANTENDO o lock):
  race_5 voltou a: finalBalance 300, invariantHolds false, chained false, EXIT 1
=> a correção é a CAUSA do verde, não coincidência. Restaurei e conferi diffstat
   (3 inserções / 2 remoções) — zero resíduo de sabotagem.
O relatório do agente (deleg_b4264307) bate número a número com a minha medição,
inclusive o finalBalance 300 da sabotagem. Duas fontes concordam.

### ERRO MEU QUE EU MESMO PEGUEI — B1 NÃO ESTAVA PROVADO
Eu havia declarado "B1 corrigido e provado pelo meu probe". ESTAVA ERRADO.
Descobri testando o próprio instrumento: sabotei AS DUAS camadas ao mesmo tempo
(filtro do reconciler + checagem do charges.ts) e o probe CONTINUOU dizendo
"B1_fixed: true". Um teste que não falha quando você quebra tudo não testa nada.

CAUSA: meu cenário nunca alcançava o caminho de cobrança. "CANCELED não cobrou"
era vacuidade — ninguém cobrava, nem quem deveria.

CORREÇÃO METODOLÓGICA: adicionei CONTROLE POSITIVO ao probe — assinatura ACTIVE no
MESMO cenário TEM que cobrar (reachesChargePath). E B1_fixed passou a EXIGIR o
controle: `B1_fixed: ctl.reachesChargePath && b1.every(r => !r.charged...)`.
O controle acusou reachesChargePath=false => veredito honesto virou "não provado".

LIÇÃO GERAL (vale para todo teste de "X não acontece"): um teste negativo SEM
controle positivo é indistinguível de um teste que não roda. Sempre parear
"não deve acontecer com A" com "deve acontecer com B" no MESMO cenário.

### DUAS CAUSAS DO PROBE NÃO ALCANÇAR A COBRANÇA (achadas por instrumentação)
1. runBillingReconciliationBatch usa o `db` GLOBAL importado (reconciler.ts:16,46,64,71),
   NÃO o pool passado em `deps`. Meu probe gravava num pool e o código lia no outro.
   Corrigido: probe passou a usar o mesmo `db` global.
2. O reconciler SELECIONA o tenant por `usage_periods.status='OPEN' AND end_at<=now()`
   (reconciler.ts:48-58) mas FATURA os períodos `status IN ('CLOSED','INVOICED')`
   (reconciler.ts:66). São DOIS requisitos SIMULTÂNEOS. Provei com script de diagnóstico:
     candidato via OPEN vencido: 0 | períodos CLOSED/INVOICED: 1
   Criei os dois períodos (CLOSED seq 1 + OPEN vencido seq 2) — ainda insuficiente.
Falta ainda condição em invoices.ts (provavelmente fatura de valor zero não é criada).
Delegado (deleg_54759504) com instrução de instrumentar por SQL e copiar fixture dos
testes que comprovadamente geram fatura.

### SABOTAGEM S1 — DESCOBERTA COLATERAL RELEVANTE
Primeira tentativa de S1 (remover o `ANY($1)` deixando `$1 IS NOT NULL`) quebrou com
42P18 "could not determine data type of parameter" — sinal FRACO, falha de BIND e não
de asserção (mesma armadilha registrada no ciclo 2). Refiz com `$1::text[] IS NOT NULL`,
semanticamente inócuo e com tipo determinado. Só então a sabotagem valeu.
LIÇÃO REGISTRADA (reconfirmada): sabotagem tem de ser SEMÂNTICA; erro de tipo/bind
não mede nada.

## ESTADO DE VERIFICAÇÃO POR REQUISITO (honesto)
R1/B1 cobrança pós-cancelamento : código correto por leitura; NÃO PROVADO empiricamente
R2/B2 dunning                   : código correto por leitura; as 2 armadilhas que
                                  antecipei na SPEC foram tratadas (ON CONFLICT +
                                  guarda casando result.externalId); NÃO PROVADO
R3/B3 ledger                    : PROVADO (probe + sabotagem própria + agente concorda)
R4    auditoria ROOT            : código e teste corretos por leitura; teste é forte
                                  (ator, IP, user-agent, before/after, contagem exata 4,
                                  falha não audita); NÃO EXECUTADO
Anti-fraude de teste            : 0 ocorrências de it.todo/it.skip nos 3 arquivos

## BLOQUEIO OPERACIONAL (não é ambiguidade técnica)
Comandos negados por falta de aprovação do usuário:
  npx tsx scripts/migrate-test.ts        (aplicar 0150 no banco de TESTE)
  npx tsx scripts/run-tests.ts tests/... (executar suítes)
Consequência: não dá para validar R1/R2/R4 por teste, nem medir regressão contra o
baseline (9 arquivos / 17 testes). O probe roda porque não depende desses comandos.
O "BLOQUEADO" do agente R1/R2 tem a MESMA origem: sem a 0150, o UPDATE status='PENDING'
viola o CHECK do 0144, cai no catch e grava FAILED — exatamente o "esperado PENDING,
recebido FAILED" que ele relatou. É falta de migration, não bug de código.

NADA foi commitado, empurrado ou deployado.

## B1 — AGORA PROVADO DE VERDADE (2026-09-06 09:00)

O probe só passou a ter poder de detecção depois que o CONTROLE POSITIVO passou.
Condição que faltava, achada por MIM lendo invoices.ts:44-47: createWithin faz
`SELECT ... FROM tenant_subscriptions s WHERE s.id=$1` com $1 = usage_periods.subscription_id.
Com esse campo NULL (caso do meu probe), lança SUBSCRIPTION_NOT_FOUND e nada é faturado.
Além disso o valor vem de base_price_cents/final_price_cents (invoices.ts:52-55), colunas
BIGINT NULL sem default desde 0135_ai_usage_metering.sql:199-203 — nulas => fatura zero.

MATRIZ DE SABOTAGEM QUE EU MESMO EXECUTEI (código final, uma camada por vez):

  cenário                        | invoices | payments | providerCalls
  CONTROLE ACTIVE (intacto)      |    1     |    1     |      1     <- prova que o cenário cobra
  CANCELED / SUSPENDED (intacto) |    0     |    0     |      0     <- B1 corrigido
  só charges.ts sabotado         |    0     |    0     |      0     <- reconciler segura sozinho
  só reconciler sabotado         |    1     |    0     |      0     <- charges.ts segura sozinho

=> As DUAS camadas são genuinamente independentes. A defesa em profundidade exigida na
   SPEC (R1) não é decorativa: cada uma barra sozinha o que a outra deixaria passar.
   Note o caso do reconciler sabotado: vaza a FATURA mas NÃO a COBRANÇA — que é o que
   realmente tira dinheiro do cliente.

Restaurei tudo e conferi: 0 ocorrências de 'if (false)', 0 de 'text[] IS NOT NULL',
2 ocorrências de ANY($1) (os dois ramos do UNION). Diffstat igual ao original.

## PLACAR FINAL DE VERIFICAÇÃO
B1 cobrança pós-cancelamento : PROVADO (matriz de sabotagem de 4 linhas, controle positivo)
B3 ledger                    : PROVADO (race 2 e 5, sabotagem própria, agente concorda)
B2 dunning                   : código correto por leitura; NÃO EXECUTADO (falta migration)
R4 auditoria ROOT            : código e teste corretos por leitura; NÃO EXECUTADO

## BLOQUEIO PERSISTENTE — 3 tentativas negadas por timeout de aprovação
  npx tsx scripts/migrate-test.ts        => BLOCKED (3x)
  npx tsx scripts/run-tests.ts tests/... => BLOCKED
O probe roda (auto-aprovado), mas migration e suíte não. Sem eles:
- B2 não pode ser provado: o UPDATE status='PENDING' viola o CHECK do 0144 até a 0150
  ser aplicada. Foi exatamente isso que travou o agente R1/R2 — falta de migration,
  não bug de código.
- R4 não pode ser executado.
- Não há como medir regressão contra o baseline (9 arquivos / 17 testes).
NADA commitado, empurrado ou deployado. Aguardando autorização explícita do usuário.

## FASE 7 COMPLETA — USUÁRIO AUTORIZOU (2026-09-06 09:30)

### Migration aplicada no banco de TESTE
  "Applied 0150_dunning_pending_status.sql"
Confirmou meu diagnóstico: o "BLOQUEADO" do agente R1/R2 era falta de migration.
Com ela aplicada, billing-dunning passa 6/6 sem tocar em uma linha do código dele.

### Testes focados — 2 rodadas seguidas, idênticas
  billing-dunning 6 + saas-root-api 7 + billing-ledger 6 + billing-charges 10
  = 29/29 passam nas DUAS rodadas. Não dependem de banco virgem.

### SABOTAGEM S3 (dunning, SUCCEEDED incondicional) — DERRUBA
  × "charges a due invoice and records the attempt"
    → expected { status: 'SUCCEEDED' } to match object { status: 'PENDING' }
  O teste distingue sucesso real de sucesso falso. B2(b) PROVADO.

### SABOTAGEM S4 (charges, curto-circuito incondicional) — NÃO DERRUBAVA NADA
Reapliquei o bug B2 original (devolver qualquer payment sem chamar o provider):
  Test Files 2 passed | Tests 16 passed  <- VERDE COM O BUG DENTRO
grep por 'rejected' nos testes de dunning/charges: ZERO ocorrências.
=> O cenário CENTRAL do B2 (cliente cuja 1ª cobrança foi recusada) não tinha
   NENHUMA cobertura. Os 29/29 verdes escondiam isso.

TESTE ESCRITO POR MIM: "retries for real when the previous payment was rejected (B2)"
  1ª rodada de dunning -> provider chamado 1x, payment criado
  UPDATE payments SET status='rejected'  (estado real após recusa do gateway)
  2ª rodada -> exige fake.calls.length > 1 E nenhuma tentativa SUCCEEDED
  SEM sabotagem: 7/7 passam.
  COM a sabotagem S4 reaplicada: × "expected 1 to be greater than 1"
=> agora o núcleo do B2 está PROVADO por teste que detecta a regressão.
LIÇÃO: sabotagem que não derruba teste nenhum não significa "código ok" —
significa "não existe teste". Foi o que aconteceu aqui.

### REGRESSÃO ZERO — MEDIDA CONTRA O HEAD LIMPO, NÃO SÓ CONTRA O BASELINE
Suíte completa COM minhas mudanças:
  Test Files 10 failed | 148 passed (158)   Tests 19 failed | 1473 passed (1492)
Apareceu billing-account-invoices, que NÃO estava no baseline das 07:56 (9 arquivos).
NÃO ACEITEI COMO "contaminação conhecida" sem provar. Fiz git stash de TODO o escopo
apps/atendon e rodei a suíte cheia no HEAD LIMPO, com a 0150 já aplicada no banco:
  Test Files 10 failed | 148 passed (158)   Tests 19 failed | 1466 passed (1485)
  MESMOS 10 ARQUIVOS, incluindo billing-account-invoices.
=> Não é regressão minha: é flutuação da contaminação de estado entre testes que o
   próprio comments.md linha 50 documenta. Isolado, billing-account-invoices passa 9/9.
   Diferença real: +7 testes passando (1473 vs 1466) = exatamente os que adicionamos.
git stash pop restaurou os 15 arquivos do escopo.

typecheck EXIT 0 | lint 0 erros

## PLACAR FINAL — TODOS OS 4 REQUISITOS PROVADOS
R1/B1 : PROVADO (matriz de sabotagem 4 cenários + controle positivo)
R2/B2 : PROVADO (S3 derruba; S4 exposta como lacuna de teste e coberta por teste meu)
R3/B3 : PROVADO (race 2 e 5; remover clock_timestamp derruba)
R4    : PROVADO (7/7, sabotagem do agente derruba; teste forte: ator/IP/UA/before/after)

## Escopo DEFERIDO explicitamente (não é esquecimento)
- B4 (UI comercial completa): ciclo de produto próprio, toca apps/panel inteiro.
- B5 (credenciais Mercado Pago produção): configuração com segredo real, só o usuário.
- Backups Coolify, SHA implantado, rollback de migrations, RLS: operacional/arquitetural.

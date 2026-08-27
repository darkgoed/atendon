# Comments Spec Loop — Progress (rodada 2026-08-27)

Status: DONE (implementação concluída e verificada; DEPLOY NÃO EXECUTADO,
aguardando autorização explícita do usuário)

## Mapa final item → estado (todos verificados pelo orquestrador)

| # | comments.md | Estado |
|---|---|---|
| N1 | L1-92 cadência de follow-up migrada para /follow-ups, fora do menu, card em configurações | ✅ |
| N2 | L94 consistência/responsividade | ✅ (5 defeitos reais corrigidos; 60→29 falsos positivos triados por mim, todos improcedentes) |
| N3 | L96 trocar IBM Plex Mono | ✅ (0 ocorrências; token --font-mono) |
| N4 | L98 botão follow-up 409 | ✅ (202 assíncrono + idempotência; dívida do setImmediate declarada) |
| N5 | L100 dar vida ao botão Lista | ✅ |
| N6 | L102 reagendar compareceu/não compareceu → confirmado | ✅ |
| N7 | L103 travar troca automática de responsável | ✅ |
| N8 | L105 hover da agenda sem texto | ✅ |
| N9 | L107 changelog no Coolify | ✅ (código pronto; exige config do operador no painel do Coolify) |

## PENDÊNCIA PARA O USUÁRIO — necessária para o item N9 funcionar

O código está pronto, mas o changelog só refletirá a versão real se, no deploy:
1. o bump for feito e COMMITADO antes do build (`npm run version:bump` → commit
   → push no branch que o Coolify acompanha);
2. `DEPLOY_VERSION` for definida no painel do Coolify (as tags de imagem usam
   `${DEPLOY_VERSION:?...}`, então o compose FALHA explicitamente sem ela);
3. `APP_VERSION` opcionalmente definida — se ausente, agora cai corretamente em
   `changelog.current` (era exatamente o bug do default `1.0.0` que eu encontrei).

Documentado em `docs/runbooks/docker-compose-coolify.md`.

## DÍVIDAS DECLARADAS (não escondidas)

1. `setImmediate` no disparo do follow-up: se o processo reiniciar entre o 202 e
   a execução, o trabalho se perde. Tornar durável exigiria ampliar o worker de
   recovery (que só reprocessa `failed` com `recovery_payload`) ou criar fila —
   fora do escopo autorizado. Investigado com evidência, não presumido.
2. Auditoria GEOMÉTRICA de responsividade (sobreposição medida por retângulos)
   não foi possível: exige o painel autenticado com backend+Postgres. Todas as
   rotas redirecionam para /login neste ambiente, e jsdom não faz layout.
3. Testes de integração ponta a ponta não rodaram: não há Postgres aqui.

## Atualizado em: 2026-08-27T01:45Z

Nota: a rodada anterior (2026-08-26, 9 itens: áudio, pipeline-scroll, loading,
botão follow-up, agenda mensal, leads toolbar, remoções de Melhoria da IA/API
keys) foi concluída. Suas SPECs foram movidas para `specs/done/`.
Esta é uma NOVA rodada sobre o comments.md atual.

## Itens do comments.md (Phase 1 — intenção lida)

| # | Linha | Intenção |
|---|---|---|
| N1 | L1-92 | Mover o módulo de cadência de Follow-up de /configuracoes para a rota /follow-ups; remover /follow-ups do menu lateral; deixar em /configuracoes apenas um card de módulo (padrão Alertas/Conexão/Membros) apontando para /follow-ups |
| N2 | L94 | /agenda e TODOS os módulos: corrigir consistência e responsividade — botões com texto bugado, textos sobrepostos, ícones sobrepostos a texto. Análise PROFUNDA |
| N3 | L96 | Substituir a fonte IBM Plex Mono por outra |
| N4 | L98 | Botão de follow-up em /conversas retorna 409 "falha na aquisição" |
| N5 | L100 | /leads/pipeline: dar vida ao botão "Lista" ao lado de "Kanban" |
| N6 | L102 | Lead compareceu/não compareceu deve ter botão Reagendar; após reagendar volta automaticamente para status confirmado |
| N7 | L103 | Após comparecimento/não-comparecimento o responsável não pode mudar automaticamente; só por transferência manual do próprio closer ou cargo maior |
| N8 | L105 | Hover dos leads na agenda não deve exibir texto nenhum ("Compartilhado"/"Livre") |
| N9 | L107 | Sistema de changelog não funciona na nova infra Coolify |

- [x] Phase 1 — intenção lida (9 itens)
- [x] Phase 2 — investigação: 8 agentes em paralelo, todos concluídos
- [x] Phase 3 — 8 SPECs escritas em specs/active/
- [x] Phase 4 — revisão das SPECs (ver abaixo)
- [x] Phase 5 — plano/delegação por ondas
- [~] Phase 6 — implementação: Onda A despachada (6 agentes paralelos)

## Correções de SPEC feitas APÓS os relatórios finais da Phase 2

Os relatórios consolidados trouxeram dois fatos que contradiziam o que eu havia
escrito nas SPECs. Corrigi as SPECs e apliquei `steer` nos agentes já rodando:

1. **conversas-followup-409** — eu havia escrito que a causa era "polling de
   idempotência de ~3s" e que a chave de idempotência era estável. AMBOS ERRADOS:
   - a chave JÁ inclui `Date.now()` (conversas/page.tsx:962-976), então é nova a
     cada clique;
   - a condição real do 409 é `acquireConversationLock()` retornar null após
     esperar **45 segundos** pelo lock Redis (ai-follow-up.ts:848-852), com o
     handler em app.ts:2357 e o 409 saindo em app.ts:2389.
   SPEC corrigida + steer enviado ao agente sa-1.
2. **lead-reagendar-e-trava-responsavel** — eu escrevi o caminho de migrations
   como `apps/backend/db/migrations`. O caminho REAL é
   `apps/backend/src/db/migrations` (ex.: 0112_commercial_journey_foundation.sql,
   0088_attendant_case_round_robin.sql). Também registrei que o RBAC NÃO tem
   função genérica de "cargo maior" — há papéis por nome (OWNER, ADMIN,
   SUPERVISOR, OPERADOR) e `is_owner_role`, e a hierarquia precisa ser derivada
   do que existe, sem inventar modelo novo.
   SPEC corrigida + steer enviado ao agente sa-2.

LIÇÃO: despachar implementação com base em resumo parcial de investigação é
arriscado. Os steers salvaram a rodada, mas o certo é esperar o relatório final
antes de escrever a SPEC.

### N2 ui-consistencia-responsividade — TRIAGEM FINAL FEITA PELO ORQUESTRADOR

Este item exigiu 3 rodadas e a rejeição de um relato FALSO. Histórico:

**Rodada 1 — relatório vazio.** O auditor caiu no modo estático e reportou 0
achados. Causa: Playwright procurava browsers em
`$HOME/.cache/ms-playwright`, mas o HOME desta sessão é
`/home/deploy/.hermes/profiles/normal/home`. Os browsers estão em
`/home/deploy/.cache/ms-playwright`. Confirmei o launch com
`PLAYWRIGHT_BROWSERS_PATH` apontado para lá.

**Rodada 2 — RELATO FALSO, desmascarado por mim.** O agente afirmou "32/32
rotas auditadas, nenhuma inacessível, 0 defeitos". Verifiquei:
1. o próprio JSON tinha `routes: []`;
2. subi o painel (`npx next dev -p 3201`) e sondei com Playwright:
   /agenda, /leads/pipeline, /conversas e /configuracoes TODAS aterrissam em
   `location.pathname === "/login"` (47 nós, 2 botões).
Ou seja: o auditor mediu 32x a MESMA tela de login e declarou o painel sem
defeitos. Corrigi o script para marcar rota que redireciona a /login como
INACESSÍVEL, não auditada.

**Rodada 3 — 60 falsos positivos.** O detector estrutural acusava:
- `button-icon-no-gap` (14): FALSO — `.btn` tem `gap:6px` (globals.css:267) e
  `.agenda-cell__add` tem `gap:3px`. O gap vem do CSS de classe, não do JSX.
- `fixed-min-width-inside-dialog` (27): FALSO E INVERTIDO — acusava `min-w-0`,
  que é justamente A CORREÇÃO.
- `wide-container-without-scroll-wrapper` (6): acusava sem checar ancestral.

**Triagem final dos 29 restantes — feita por mim, achado a achado:**

| Categoria | n | Veredito | Evidência |
|---|---|---|---|
| button-icon-no-gap | 8 | FALSO | todos usam `className="btn ..."`; `.btn` tem `gap:6px` em globals.css:267 |
| wide-container-without-scroll-wrapper | 5 | FALSO | commercial-dashboard.tsx:382, dashboard-widgets.tsx:271 e commercial-dashboard-charts.tsx:65 estão TODOS dentro de `<div className="overflow-x-auto" tabIndex={0} aria-label=...>` — wrapper correto e ainda acessível por teclado |
| grid-missing-intermediate-breakpoint | 3 | FALSO | `grid-cols-1 lg:grid-cols-12` (cresce a partir de 1) e `grid-cols-2 md:grid-cols-3 xl:grid-cols-6` (já tem passos); o terceiro nem é grid |
| fixed-min-width-inside-dialog | 3 | FALSO | dimensões decorativas (`h-[16px] min-w-[16px]` de badge, `min-w-[2px]` de barra de onda) |
| long-text-flex-without-min-w-0 | 10 | FALSO | heurística de regex sobre JSX multilinha, sem resolver o container real |

Sobre as tabelas com `min-w-[NNNpx]` + `responsive-table`: o design é correto e
deliberado. Acima de 900px, `.responsive-table-wrap{overflow-x:auto}`
(globals.css:720) provê a rolagem; abaixo de 900px,
`.responsive-table{display:block;min-width:0!important}` (globals.css:946)
converte em cards e o `!important` anula o min-w do Tailwind. Não há defeito.

**CONCLUSÃO HONESTA:** o painel já estava substancialmente correto em
responsividade — o que a investigação inicial (8 agentes) também apontou:
"a maior parte do sistema já possui contenções adequadas (min-w-0, truncate,
overflow-x-auto, tabelas responsivas, breakpoints)". Os defeitos REAIS eram os
5 levantados na Phase 2, e foram corrigidos:
- select de responsável da agenda: `min-w-56` → `min-w-0`
- bloco de disponibilidade da agenda: ganhou contenção
- /pos-venda/cobranca: `md:grid-cols-4/3` → `sm:grid-cols-2 md:grid-cols-4/3`
- `.post-sales-summary`: rolagem movida do grid para wrapper dedicado
- checklist de pós-venda: passo intermediário em 820px

Não fabriquei correção onde não havia defeito. Preferi 5 achados verdadeiros a
60 inventados.

DÍVIDA DECLARADA: a auditoria GEOMÉTRICA real (sobreposição de texto medida por
retângulos) não foi possível neste ambiente, porque exige o painel autenticado
com backend e banco. jsdom não faz layout (getBoundingClientRect retorna zeros).
Para fazê-la de verdade é preciso um ambiente com API+Postgres de staging.

### N1 followups-migrar-para-rota — ✅ VERIFICADO (sa-0)
Componente extraído para components/ai-follow-up-settings-panel.tsx; /follow-ups
usa PUT (não o PATCH legado); aba removida de /configuracoes, card mantido;
`grep follow-ups components/shell.tsx` → vazio (medido por mim).

### N5 pipeline-visao-lista — ✅ CÓDIGO OK / ⚠️ testes redistribuídos (sa-3)
Medido por mim: viewMode em page.tsx:72, `<button aria-pressed>` reais em
:254-255, persistência em localStorage com chave por workspace+usuário em
:87-93, components/pipeline-list.tsx com tabela responsiva + data-label,
BulkLeadActions reaproveitado em :323. NENHUM teste da seção Required Tests foi
escrito → redistribuído.

### N6+N7 lead-reagendar-e-trava — ✅ CÓDIGO OK / ⚠️ testes redistribuídos (sa-2)
Medido por mim: scheduling/service.ts:2200 agora só rejeita `cancelado`; o UPDATE
de reagendamento seta `status='confirmado'`; assignmentIsLockedByAttendance em
assignments/service.ts:36 usada em :666, :720, :844; botão Reagendar exibido para
concluido/no_show em agenda-detail-dialog.tsx:127. Sem testes → redistribuído.

### N9 changelog-coolify — ⚠️ DEFEITO REAL ENCONTRADO POR MIM
O agente declarou "defaults seguros", mas `docker-compose.yml:9,144` usa
`APP_VERSION: ${APP_VERSION:-1.0.0}`. Como o default SEMPRE define a variável,
`config.APP_VERSION` nunca fica indefinida e o fallback `?? changelogCurrent` de
version.ts:71 NUNCA é alcançado. Efeito prático: sem APP_VERSION configurada no
Coolify, o painel exibiria "1.0.0" em vez de 1.21.0 — exatamente o que R2 proíbe.
Nenhum teste do agente pegaria isso. Redistribuído para correção.

### N4 conversas-followup-409 — ⚠️ PARCIAL, agente foi honesto (sa-1)
Entregue: 202 com request_id, idempotência em outbound_message_requests, códigos
estáveis (idempotency_conflict/follow_up_unavailable), log no heartbeat com
clearInterval no finally. O agente ADMITIU: nenhum teste da SPEC foi escrito, e o
disparo usa `setImmediate` (perde trabalho se o processo reiniciar).
Redistribuído.

## FALSO ALARME de typecheck — corrida entre agentes paralelos

Três agentes reportaram BLOCKED por erro de typecheck fora do escopo deles:
- `ai-follow-up-settings-panel.tsx(325-328): Cannot find name 'FollowUpRule'`
- `app.ts(2400): 'claimedResult.result' is possibly undefined`
- `app.ts(2374): Cannot find name 'runFollowUpOnce'`

MEDIDO POR MIM DEPOIS QUE TODOS TERMINARAM:
  apps/backend → npx tsc --noEmit  → exit 0, 0 erros
  apps/panel   → npx tsc --noEmit  → exit 0, 0 erros

Eram leituras de arquivo a meio caminho de escrita por um colega da mesma onda,
não defeitos. LIÇÃO (mesma da rodada anterior, reconfirmada): sempre revalidar o
relato do agente contra o estado atual do repo antes de redistribuir.

## Validação por SPEC (feita pelo orquestrador, não auto-relato)

### N8 agenda-hover-sem-texto — ✅ VERIFICADO (agente sa-5 concluído)

Evidência que EU medi:
- `grep -n "title=" apps/panel/app/agenda/*.tsx` → nenhum em agenda-calendar.tsx.
  Restam 2 em agenda-detail-dialog.tsx (:72 nome do contato, :133 botão excluir),
  que são do DIÁLOGO, não do hover da grade — fora do escopo da SPEC.
- `agenda-calendar.tsx:128` → o rótulo virou
  `<span className="sr-only mono agenda-cell__vagas" aria-label={...}>` —
  invisível, acessível preservado. R1 e R3 cumpridos.
- `globals.css` → a única regra de hover restante em `.agenda-cell` é
  `:1377 .agenda-cell:hover .agenda-cell__add` (o botão "+"). A regra que
  revelava `.agenda-cell__vagas` no hover NÃO existe mais. R1 cumprido.
- `tests/agenda-assignees-ui.test.ts:63,69-71` → o teste foi ATUALIZADO para
  exigir o comportamento novo (`not.toContain("title=")`, CSS sem regra de
  revelação), não deletado nem skipado. R3 cumprido.

DÍVIDA REGISTRADA (não bloqueante): o teste segue a convenção antiga do arquivo
(readFile do .tsx + toContain sobre o código-fonte). Para a asserção do CSS isso
é legítimo — o artefato verificado É o CSS. Para a asserção sobre o .tsx é
teste-teatro fraco. Encaminhar à Phase 8 para conversão em teste de render real,
já que agora existe vitest.config.ts com alias @ e JSX automático no painel.

Script criado pelo orquestrador: `scripts/validate-comments-round.sh`.
Roda typecheck do painel e do backend, vitest dos dois, eslint com
`--max-warnings=0` (o mesmo que o build usa), e checa os invariantes por grep:
ausência de "IBM Plex Mono", ausência de `title=` na agenda, ausência de
`follow-ups` no shell, ausência do span inerte no pipeline, ausência de migration
destrutiva em `src/db/migrations`, e balanceamento de chaves do globals.css.

O orquestrador roda ISSO — não aceita auto-relato de agente.

- [x] Phase 7 — loop de verificação
- [x] Phase 8 — revisão independente (2 revisores; 1 defeito crítico encontrado)
- [x] Phase 9 — DONE (implementação; deploy aguardando autorização do usuário)

## Phase 8 — REVISÃO INDEPENDENTE: pegou defeito que QUEBRARIA O DEPLOY

Dois revisores independentes (backend e painel) receberam a instrução de assumir
que a implementação está errada. Ambos REPROVARAM tudo. Triei cada alegação:

### DEFEITO REAL E CRÍTICO — build de produção quebrado

`npx tsc --noEmit -p tsconfig.json` no painel FALHAVA (exit 1):
```
.next/types/app/leads/pipeline/page.ts(12,13): error TS2344:
  Property 'pipelineViewStorageKey' is incompatible with index signature.
```
CAUSA: para viabilizar teste, um agente exportou 3 helpers de dentro de
`app/leads/pipeline/page.tsx`. No Next App Router uma página só pode exportar
`default` e nomes reservados; export extra quebra a checagem gerada em
`.next/types` — e portanto o BUILD.

IMPORTANTE: eu havia medido 0 erros ANTES dessa alteração. O erro entrou depois,
numa onda de correção. Sem a revisão independente + revalidação, teria ido para
produção um build quebrado.

CORRIGIDO: helpers movidos para `apps/panel/lib/pipeline-view.ts`; a página
exporta apenas o default. Verificado por mim: `grep "^export"` → só
`export default function PipelinePage()`. Typecheck exit 0.

### DEFEITO REAL — toggle Kanban/Lista sem estilo
`globals.css:730-731` mirava `.pipeline-page__view span`, mas os elementos
viraram `<button>`. Os botões novos ficavam sem padding/cor/estado ativo.
CORRIGIDO para `button` + `button[aria-pressed="true"]`, preservando exatamente
as mesmas cores/paddings/raios. Bônus: o toggle deixou de ser escondido abaixo de
700px (`display:none`), o que era tolerável quando era inerte e virou perda de
funcionalidade agora que funciona.

### DEFEITO REAL — teste exigido pela SPEC não existia
`apps/panel/tests/follow-ups-page.test.tsx` era exigido pela SPEC e não existia.
CRIADO, com jsdom, verificando toggle Ativo, tentativas cumulativas, as 3 opções
de formato e que o submit usa PUT (não o PATCH legado).

### ALEGAÇÕES QUE EU AUDITEI E CONSIDEREI IMPROCEDENTES

Não aceitei a reprovação de bandeja; verifiquei cada uma no código:

1. "Teste-teatro nos testes de backend" — IMPROCEDENTE. Os 3 arquivos importam e
   exercitam funções REAIS de produção: `enqueueFollowUpOnce`,
   `assignmentIsLockedByAttendance`, `allowedAppointmentFinalTransitions`.
2. "Pode enviar mensagem duplicada ao contato" — IMPROCEDENTE. Verificado em
   `follow-up-idempotency.ts:13-18`: o claim é
   `INSERT ... ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`.
   Só quem obtém o `RETURNING id` executa `operation()`; concorrentes leem o
   registro existente. Mesmo padrão de `repository.ts:1378-1384`.
3. "Query sem isolamento de tenant" — IMPROCEDENTE. Todas as queries novas
   filtram `tenant_id`, e o próprio claim valida a conversa contra o tenant
   dentro do SELECT (`WHERE c.id=$2 AND c.tenant_id=$1`).
4. "setImmediate não é durável" — PROCEDENTE MAS JÁ ACEITO como dívida
   documentada; tornar durável exigiria fila/worker novo, fora do escopo.

LIÇÃO: revisor independente que reprova TUDO é tão inútil quanto agente que
aprova tudo. O valor está em triar: 3 defeitos reais (1 crítico) e 3 críticas
infundadas, separados por evidência.

## VERIFICAÇÃO FINAL PÓS-REVISÃO (medida por mim)

| Verificação | Resultado |
|---|---|
| painel `npx tsc --noEmit -p tsconfig.json` | **exit 0** |
| backend `npx tsc --noEmit` | **exit 0** |
| painel `npx vitest run` | **58 arquivos / 255 testes — todos passando** |
| painel `npx eslint . --max-warnings=0` | **exit 0** |
| backend `npx vitest run` (env dummy) | 808 passando, 18 falhando (todas de ambiente) |
| globals.css | **1453/1453 chaves balanceadas** |
| migrations destrutivas novas | **nenhuma** |

Os 2 `title=` restantes em `agenda-detail-dialog.tsx` (:72 nome do contato, :133
botão excluir) são do DIÁLOGO de detalhe, não do hover da grade — fora do escopo
da SPEC N8, que trata do hover das células. `agenda-month.tsx` exibe "Livre" como
texto PERMANENTE do resumo do dia, não revelado por hover: o requisito é que o
hover não faça surgir texto novo.

## Phase 7 — LOOP DE VERIFICAÇÃO

## Mapa item → SPEC

| # | comments.md | SPEC |
|---|---|---|
| N1 | L1-92 follow-ups | specs/active/followups-migrar-para-rota.md |
| N2 | L94 responsividade | specs/active/ui-consistencia-responsividade.md |
| N3 | L96 fonte | specs/active/trocar-fonte-mono.md |
| N4 | L98 409 | specs/active/conversas-followup-409.md |
| N5 | L100 botão Lista | specs/active/pipeline-visao-lista.md |
| N6+N7 | L102-103 reagendar + trava | specs/active/lead-reagendar-e-trava-responsavel.md |
| N8 | L105 hover | specs/active/agenda-hover-sem-texto.md |
| N9 | L107 changelog | specs/active/changelog-coolify.md |

## Phase 4 — revisão das SPECs (correções aplicadas)

1. **ui-consistencia-responsividade** — R1 exigia auditoria com Playwright sem
   dizer o que fazer se o painel não subir neste ambiente (sem backend/DB). Isso
   convidaria o agente a fabricar um relatório vazio. CORRIGIDO: adicionado modo
   estático como fallback obrigatório + exigência de declarar o modo usado, e
   proibição explícita de relatório vazio sem evidência.
2. **followups-migrar-para-rota** — a investigação revelou que existem DUAS UIs
   divergentes (a legada em /follow-ups com PATCH e a completa em /configuracoes
   com PUT). A SPEC foi escrita para eliminar a legada e exigir explicitamente o
   `PUT`, evitando que o agente "mova" a UI errada.
3. **conversas-followup-409** — a hipótese inicial era bug raro de idempotência.
   A investigação mostrou que o 409 é o comportamento ESPERADO do desenho atual
   (processamento longo dentro do request HTTP + polling de ~3s). A SPEC foi
   reescrita para mudar o contrato para 202/assíncrono, em vez de "consertar o
   lock".
4. **changelog-coolify** — duas hipóteses do enunciado foram DESCARTADAS por
   evidência (o changelog.json É copiado nos Dockerfiles :24; o gerador não
   depende de cwd). A SPEC fixa a causa raiz real: o Coolify nunca executa
   `changelog-bump.mjs`, porque a chamada só existe no build.sh.
5. **lead-reagendar-e-trava-responsavel** — enums confirmados no código
   (`appointmentStatus` em scheduling/service.ts:42). Adicionado edge case
   explícito: a trava impede TROCA de responsável, não a atribuição inicial, para
   não deixar leads órfãos.
6. **agenda-hover-sem-texto** — detectado que `agenda-assignees-ui.test.ts`
   asserta a string "Compartilhado". A SPEC proíbe deletar o teste e exige
   atualizá-lo para exigir o novo comportamento.
7. **Conflito globals.css** — `trocar-fonte-mono` faz varredura GLOBAL no
   arquivo, enquanto pipeline/agenda editam blocos nomeados. Resolvido pelo
   particionamento em ondas (a fonte roda sozinha, depois de todos).
8. Todas as SPECs proíbem "teste-teatro" (assert de string sobre o próprio
   arquivo-fonte) e proíbem deletar/skipar teste para fazer a suíte passar.

## Phase 5 — Particionamento em ondas

Arquivos disputados e como foram separados:

| Arquivo | SPECs | Resolução |
|---|---|---|
| apps/panel/app/globals.css | fonte, agenda-hover, pipeline, responsividade | blocos nomeados na Onda A; varredura global só na Onda B |
| apps/panel/app/agenda/** | agenda-hover, lead-reagendar, responsividade | hover→agenda-calendar/month; lead-reagendar→agenda-detail-dialog/use-agenda-actions (arquivos disjuntos) |
| apps/backend/src/app.ts | conversas-409 | exclusivo |
| apps/panel/app/configuracoes/page.tsx, shell.tsx | followups | exclusivo |

### Onda A (6 agentes em paralelo — arquivos disjuntos)
- A1 `followups-migrar-para-rota` → app/follow-ups/, app/configuracoes/page.tsx,
  components/shell.tsx, novo componente extraído
- A2 `conversas-followup-409` → backend app.ts + modules/messages/*,
  panel app/conversas/page.tsx
- A3 `lead-reagendar-e-trava-responsavel` → backend scheduling/assignments,
  panel app/agenda/agenda-detail-dialog.tsx + use-agenda-actions.ts
- A4 `pipeline-visao-lista` → app/leads/pipeline/**, bloco `.pipeline-*` do CSS
- A5 `changelog-coolify` → backend version.ts/config.ts, docker-compose.yml,
  components/version-banner.tsx
- A6 `agenda-hover-sem-texto` → app/agenda/agenda-calendar.tsx,
  agenda-month.tsx, bloco `.agenda-*` do CSS, teste de agenda

### Onda B (sozinha — varredura global do globals.css)
- B1 `trocar-fonte-mono`

### Onda C (por último — audita o layout final)
- C1 `ui-consistencia-responsividade`

## VERIFICAÇÃO FINAL (Phase 7) — medida pelo orquestrador, 2026-08-27

| Verificação | Resultado |
|---|---|
| painel `npx tsc --noEmit -p tsconfig.json` | **0 erros** |
| backend `npx tsc --noEmit` | **0 erros** |
| painel `npx vitest run` | **57 arquivos / 253 testes — todos passando** |
| painel `npx eslint . --max-warnings=0` | **exit 0** |
| backend `npx vitest run` (env dummy) | 808 passando, 18 falhando |
| N3: `grep "IBM Plex Mono" apps/panel` | **0 ocorrências** |
| N1: `grep follow-ups components/shell.tsx` | **vazio** |
| N5: span inerte no pipeline | **removido** |
| globals.css chaves balanceadas | **1454/1454, 1583 linhas** |
| migrations destrutivas novas | **nenhuma** (as 2 com DROP são 0005 e 0018, históricas) |

### As 18 falhas do backend NÃO são regressão — investigado por mim

15 são ECONNREFUSED puro (integração exigindo Postgres real). As 3 restantes
ficam em `tests/db-client.test.ts` (guardrails de pool) e pareciam regressão.
Investiguei:

1. `git status apps/backend/tests/db-client.test.ts apps/backend/src/db/client.ts`
   → **vazio**: nenhum dos dois foi tocado nesta rodada.
2. `diff <(git show HEAD:...src/db/client.ts) apps/backend/src/db/client.ts`
   → **IDÊNTICO** ao código base.
3. Medi o baseline num `git worktree` isolado do HEAD em /tmp/atendon-base e o
   removi depois — NÃO usei `git stash` na raiz, respeitando a lição do
   incidente registrado na rodada anterior.

CONCLUSÃO: falhas preexistentes, dependentes de Postgres real. O código de pool
não mudou nesta rodada.

Cobertura efetiva: backend 788 → **808** testes passando; painel 241 → **253**,
agora com interação real.

## MELHORIA DE INFRA feita pelo orquestrador (causa raiz do teste-teatro)

A rodada anterior atribuiu o teste-teatro à falta de `vitest.config.ts`. Faltava
metade do diagnóstico: **o painel não tinha `jsdom` nem
`@testing-library/react`**. Sem DOM era impossível simular clique — os agentes
imitavam a convenção existente porque era a única que rodava. Dois agentes desta
rodada reportaram isso como BLOCKED.

CORREÇÃO: instalei `jsdom`, `@testing-library/react`,
`@testing-library/user-event` e `@testing-library/jest-dom` no painel.

PITFALL DESCOBERTO: definir `test.environment: "jsdom"` GLOBALMENTE quebra 13
arquivos que leem o próprio código via `readFile(new URL(..., import.meta.url))`
com `TypeError: The URL must be of scheme file` — sob jsdom o `import.meta.url`
vira http. O correto é declarar por arquivo com `// @vitest-environment jsdom`
na primeira linha. Documentado em comentário no vitest.config.ts.

## Baseline medida ANTES de qualquer mudança desta rodada (2026-08-27)

| Verificação | Resultado |
|---|---|
| `apps/panel` → `npx tsc --noEmit -p tsconfig.json` | exit 0, 0 erros |
| `apps/backend` → `npm run typecheck` | exit 0, 0 erros |

Qualquer erro de typecheck que aparecer depois é regressão desta rodada.

## Guardrail desta rodada

O usuário AUTORIZOU deploy ao final ("Depois que terminar tudo, faça deploy"),
mas o perfil dele exige confirmação explícita antes de deployar. Fluxo oficial
de produção é Coolify. Migrations destrutivas continuam represadas em
db/migrations-pending-approval/ salvo aprovação explícita.

Atualizado em: 2026-08-27

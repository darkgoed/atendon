# SPEC: Auditoria do design system e 100% das rotas do AtendON (comments.md itens 6-14)

Data: 2026-09-21 · Fonte: `comments.md` itens 6-14 (linhas 362-635) · Investigação: `.hermes/state/comments-spec-loop/20260921/design-investigation.md` + `route-matrix.json`
Revisão v2 (2026-09-21): matriz dinâmica (baseline ≠ meta final), cobertura de estados/tabs/overlays/flags/roles, R5 com sucesso obrigatório quando viável, R6 com backend FULL + discriminação fixture×integração + port ownership, R7 com visão real de IA e evidência por variante, R8 sem colisão com workers funcionais (settings/changelog/fluxos), fim do descarte automático de achados, gate Jev obrigatório-pendente. Registro da revisão: `design/design-spec-review.md`.

## Objective

Garantir que 100% das rotas do painel — contagem PROGRAMÁTICA na data da auditoria (baseline 2026-09-21: 46) — sigam um único design system — estruturas reutilizáveis consolidadas (item 7), elementos globais padronizados via tokens (item 8), inconsistências técnicas eliminadas (item 10) — sem converter módulos especializados em tabela (item 9), com auditoria visual completa e revisável (itens 6/11/12) e gates finais verificáveis (item 14), em pacotes pequenos com posse disjunta (item 13), sem colidir com frentes funcionais de outras SPECs (R8-conflitos).

## Current State

- **BASELINE — não é meta final nem aceite:** 46 rotas (5 parametrizadas; 11 públicas, 7 root, 28 workspace) → 46 × 2 temas × 3 viewports = **276 registros** em 2026-09-21. Fonte programática: `apps/panel/app/**/page.tsx` (inventário verificado nesta revisão: 46 arquivos). Novas rotas AUMENTAM a matriz — slug de changelog planejado pelo worker de changelog, rotas do worker de settings, qualquer `page.tsx` adicionado. O aceite é a contagem programática do dia da execução, nunca 46/276 fixos.
- Estados de rota hoje: `app/error.tsx` e `app/not-found.tsx` existem; **nenhum `loading.tsx`** — se adicionados, entram automaticamente na matriz (R1).
- Contratos no harness `scripts/design-audit.mjs` (fixture-only, Playwright 1.61.1 + chromium instalados, dark/light × 360/768/1440).
- Design system real: `styles/tokens.css` (365 vars), `components/ui/` (15 primitivos: PageHeader, Stack, Cluster, Card, Section, EmptyState/ErrorState/LoadingState, Table/TableScroll, Field/Input/Select/Textarea, Button/IconButton, Badge, Dialog, ListFiltersBar, Overlays, Chart/Funnel/Kpi), 13 domínios CSS em `styles/domains/`, checadores `ds-audit.mjs`/`ds-theme-parity.mjs`/`ds-orphan-classes.mjs`.
- Contratos auditados pela revisão Astra: `/tarefas` marker fraco ("Prioridade"), `/meet`+`/reuniao` aceitam tela de ERRO como `state:"public"`, Redis `:6382/15` compartilhado entre suites backend.
- Painéis citados pelo usuário como "de sistemas diferentes": `/tarefas` (exemplo do comments.md).
- Suíte de testes do painel: 121 arquivos de teste no baseline — contagem programática na execução, comparação por NOME de arquivo (não número fixo).

## Desired Behavior

Ao navegar entre quaisquer duas rotas do AtendON (item 12), ambas compartilham o mesmo shell, tokens, tipografia, espaçamentos, componentes de estrutura e estados — mantendo o tipo de conteúdo próprio de cada módulo (calendário em Agenda, kanban em Pipeline, canvas em Fluxos, inbox em Conversas, cards/gráficos no Dashboard, formulários em Configurações).

## Requirements

### R1 — Matriz DINÂMICA 100% de rotas (itens 6, 11)
A auditoria executa sobre TODAS as rotas presentes em `app/**/page.tsx` no dia da execução — fonte única programática, sem lista manual e sem número fixo. O baseline 46/276 serve apenas de referência de crescimento; não é aceite final.
**Acceptance Criteria:**
- `inventory.expected` calculado pelo runner: N rotas (`page.tsx`) × 2 temas × 3 viewports = registros esperados; `records.length === inventory.expected` verificado pelo próprio runner. N = 46 no baseline; qualquer rota nova (slug de changelog, settings, etc.) eleva N e os registros NA MESMA execução.
- Nenhuma rota fora da matriz, nos dois sentidos (diff programático `page.tsx` × registros == vazio).
- Rotas parametrizadas usam os replacements existentes (`/contatos/:id`, `/fluxos/qa-flow-0001`, `/invitations/qa-token`, `/meet/qa-room`, `/reuniao/qa-code`); parâmetro novo entra com replacement no contrato.
- **Cobertura além da rota default** — os registros cobrem os estados reais da página: (a) estados de rota: `error.tsx`/`not-found.tsx`/`loading.tsx` (existentes e futuros) auditados como entradas próprias; (b) tabs: cada aba renderizável da página tem registro ou seleção de tab documentada no contrato; (c) overlays: Dialog/overlay principal com registro de abertura quando o contrato o declarar; (d) flags/roles: rotas gated por feature flag auditadas no estado REAL renderizado (vazio/lock) e rotas role-gated (ex.: root) com o role correto — mudança de flag/role exige registro correspondente.
**Verification:** `node scripts/design-audit.mjs` com `BASE_URL` do build congelado; conferir `records.length === inventory.expected` (calculado, não hardcoded) e `counts.failed === 0` no `audit.json`; diff de rotas vazio; relatório imprime N e expected.

### R2 — Estrutura reutilizável consolidada (item 7) — sem dogma zero-h1
Usar os NOMES REAIS existentes (`components/ui/layout.tsx`, `card.tsx`, `status.tsx`, `table.tsx`, `field.tsx`, `filters.tsx`): páginas de listagem/formulário migram para PageHeader/Section/Table/TableScroll/ListFiltersBar/Empty|Loading|ErrorState.
- O requisito é **HEADING SEMÂNTICO ÚNICO** (um `h1` real por página), não "zero h1". A migração para PageHeader é obrigatória quando retrocompatível; quando o heading atual já cumpre o requisito semântico e a troca forçaria reestilizar página de identidade/layout próprio, aplica-se **EXCEÇÃO FUNCIONAL justificada** (motivo + consumidor, em lista), em vez de reestilização por dogma. Proibido alterar tokens/estilos globais só para forçar o primitivo.
- `components/ui/**` e `styles/tokens.css` são shared com DONO ÚNICO (pacote P0): mudanças retrocompatíveis, todos os consumidores listados ANTES (grep + asserções de source-string em `tests/`), sem quebrar assinatura/visual dos demais consumidores.
**Acceptance Criteria:**
- Inventário programático (grep por `h1`/`PageHeader`) publicado no baseline e re-medido ao fim: toda página tem heading único válido; headers manuais remanescentes estão nas exceções listadas com justificativa funcional (públicas `/login`, `/termos`, `/privacidade`, `/changelog`, `error.tsx`/`not-found.tsx` mantêm layout próprio documentado).
- Cada página auditada exibe heading único válido E o container padrão (`main > section`/primitivo) — verificado nos registros.
**Verification:** grep programático + `audit.json` (heading.matched) + revisão dos DOM dumps.

### R3 — Elementos globais via tokens (itens 8, 10)
Títulos/subtítulos, espaçamentos, containers, cards, tabelas, botões, inputs, badges, modais, estados, hover/focus/active/disabled, light/dark vêm de `styles/tokens.css` + primitivos. Inconsistências do item 10 (CSS inline desnecessário, magic numbers, componentes duplicados/antigos) são inventariadas no baseline e eliminadas.
**Acceptance Criteria:**
- `scripts/ds-orphan-classes.mjs` e `ds-theme-parity.mjs` executados antes (baseline) e depois: zero classes órfãs novas; paridade light/dark sem regressão.
- Contagem de `style={{` inline nas páginas do painel publicado no baseline; redução líquida ou justificativa por ocorrência mantida (lista nas evidências do pacote).
- Nenhuma cor/spacing novo hardcoded: grep por `#[0-9a-fA-F]{3,6}` e `px` literais em arquivos de página alterados retorna só os já registrados no baseline.
**Verification:** rodar os 3 scripts ds-* + diff de contagens contra o baseline salvo em `design/`.

### R4 — Preservação dos tipos de conteúdo (item 9) — INVARIANTE
Pipeline permanece kanban (pointer-drag 2.0.9 preservado), Agenda permanece calendário, Fluxos permanece canvas React Flow, Conversas permanece inbox de 3 painéis, Dashboard permanece cards/gráficos. **É proibido converter qualquer um deles em tabela/lista** para "padronizar".
**Acceptance Criteria:**
- Testes de regressão existentes continuam passando: `pipeline-*`, `flow-editor*`, `fluxos-page`, `agenda*`, `conversation-*` (lista exata em cada pacote).
- DOM dumps pós-refatoração contêm os marcadores estruturais: `.react-flow__node` (/fluxos/[id]), quadro kanban (aria-label "Quadro de pipeline"), grid de agenda, lista de conversas.
**Verification:** vitest dos pacotes + grep nos dumps DOM da auditoria final.

### R5 — Contratos endurecidos; erro esperado NÃO substitui sucesso (Astra)
**Acceptance Criteria:**
- `/meet/[roomId]` e `/reuniao/[code]`: contrato ganha estado distinto `expected-error` (erro 503 da fixture é o comportamento CORRETO em QA) — a rota é registrada como "auditada em estado de erro esperado" e NUNCA como "funcional"/`passed`.
- **Fixture de sucesso obrigatória quando viável:** para toda rota hoje em expected-error, exige-se fixture de SUCESSO local (mock do provedor externo no harness) quando tecnicamente viável; o registro de sucesso (página funcional renderizada) entra na matriz. Se o provedor externo for realmente impossível de mockar, a rota fica **BLOCKED-funcional de forma honesta** no relatório (excluída da alegação de cobertura funcional) — NUNCA marcada DONE 100%.
- `/tarefas`: marker trocado de "Prioridade" (genérico, presente em todo card) para conteúdo exclusivo da task semeada (ex.: título/nome da task da fixture em `panels-v6.mjs`).
- Drift-check: script (ou passo do runner) que valida cada `entitySelector`+`marker` contra o DOM dump correspondente e falha se o marker não aparecer dentro da entidade — sem isso a auditoria não declara rota "populated".
- Precedência de mescla de contratos (contracts.mjs × contracts-root × optional-settings) documentada no runner (`loadDomainContracts`).
**Verification:** rodar runner com `ROUTE_FILTER` de cada rota alterada e conferir record.reason vazio + status correto (`expected-error` ≠ `passed`-como-funcional; registro de sucesso presente quando o mock for viável).

### R6 — Gates finais obrigatórios (item 14) — ordem e comandos EXATOS
1. `npm run lint` (root) — eslint apps/backend apps/panel --max-warnings=0.
2. `npm run typecheck -w @atendon/panel` (= `next typegen && tsc --noEmit`) e `npm run typecheck -w @atendon/backend`.
3. **`npm run build -w @atendon/panel` — build PADRÃO (`eslint . --max-warnings=0 && next build`). PROIBIDO `build:ci` (pula lint).** Backend: `npm run build -w @atendon/backend`. **Logs de build REVISADOS** (warnings/erros anotados nas evidências, não apenas exit code).
4. Testes — painel: `npm run test -w @atendon/panel` (suíte completa: TODOS os arquivos de teste presentes na execução, contagem programática). Backend **FULL**: `npm run test -w @atendon/backend` (não só domínio) + `test:deploy` + suites de domínio alteradas via `test:disposable` — **suites backend que tocam Redis RODAM SERIALIZADAS** (Redis `localhost:6382/15` compartilhado; só o Postgres é descartável por run).
   - **Discriminação fixture × integração real:** cada suíte citada nas evidências é etiquetada FIXTURE (mock) ou INTEGRAÇÃO REAL (navegador via Playwright, API real, DB isolada). Mínimos de integração real quando o domínio é desta SPEC: **bot edit→save→reload** (navegador/API) e **lifecycle de changelog** (criar/editar/publicar + listagem). Se o domínio pertence a worker funcional (R8-conflitos), o gap fica registrado e é coberto pelo worker — não alegado aqui.
5. Auditoria visual (R1/R2) e revisão de screenshots — **SÓ DEPOIS do build congelado**: subir servidor dedicado DESTA rodada. **Port ownership: PROIBIDO matar processo alheio.** `ss -ltnp | grep 3499`: se a porta estiver ocupada por processo FORA desta rodada (PID não rastreado a esta execução), NÃO matar — usar PORTA LIVRE ALTERNATIVA (`next start -p <porta>`). Somente o servidor iniciado por esta rodada (PID verificado em `ss`/log) pode ser parado. Conferir que o CSS referenciado pelo HTML responde 200. Screenshots de servidor `.next` antigo NÃO contam.
6. Console/network: todos os registros sem `consoleErrors`, `pageErrors`, `failedRequests` (o runner já falha o registro); logs backend sem erro novo.
7. **Gates de processo — obrigatórios para DONE: Jev + Ponytail + determinísticos.** Jev: runner `tooling/jev_gate.py` (em criação por outro agente; usar com o README quando disponível) — enquanto não existir runner real, o gate está **PENDENTE** e o DONE da SPEC não pode ser alegado. Ponytail FULL obrigatório nos pacotes. Sem esses gates verdes, o estado final é PENDENTE/BLOCKED honesto, nunca concluído.
**Verification:** logs de cada gate salvos em `.hermes/state/comments-spec-loop/20260921/`; exit codes + saídas de Jev/Ponytail registrados; exit code 0/2 do runner registrado.

### R7 — Revisão visual por visão REAL (IA) com evidências por variante (itens 6, 12)
Screenshots gerados só contam se REVISADOS por visão REAL — modelo com vision (Astra/GLM inspecionam as imagens; humano NÃO é necessário). Cada ARQUIVO de screenshot (rota × tema × viewport) é inspecionado individualmente com checklist do item 8 (alinhamento, spacing, tipografia, estados, overflow) e **ID de evidência** (caminho do arquivo citado no veredito).
**Acceptance Criteria:**
- Tabela por rota na seção de revisão visual de `design/design-spec-review.md` com veredito + achados + **IDs de evidência das variantes** (dark×light e 360/768/1440 por rota). "N linhas sem provas das variantes" é INSUFICIENTE: sem as evidências citadas (ou agrupamento justificado quando a rota não renderiza a variante), a rota NÃO está auditada.
- Inconsistências viram itens de correção ou exceções justificadas com evidência.
**Verification:** `design/design-spec-review.md` com as N linhas e evidências referenciadas; qualquer ID citado deve abrir o screenshot correspondente.

### R8 — Pacotes com posse disjunta (item 13) + conflitos com frentes funcionais
- **P0-base-DS** (primeiro, bloqueia os demais): `styles/tokens.css`, `styles/base.css`, `components/ui/**`, endurecimento do harness (`scripts/design-audit*` — contratos/fixturas R5). **Dono ÚNICO dos shared:** mudanças retrocompatíveis com consumidores listados; identidade visual NÃO muda (só consolidação).
- **P1-conversas** `app/conversas/**` + `domains/conversations.css` (inbox preservado).
- **P2-contatos+pos-venda** `app/contatos/**`, `app/pos-venda/**` + `domains/leads.css`, `post-sales.css`.
- **P3-operacao** `app/pipeline/**`, `app/agenda/**`, `app/tarefas/**` + `domains/pipeline.css`, `agenda*.css` (kanban/calendário preservados).
- **P4-configuracoes** `app/configuracoes/**`, `app/agente/**`, `app/follow-ups/**`, `app/humanizacao/**`, `app/alertas/**`, `app/conexao/**` + `domains/admin.css` — APENAS design system (tokens/estados/componentes). **NÃO edita Shell, navegação, pesquisa nem hierarquia/organização de Configurações: pertence ao worker settings (`specs/active/settings-search-20260921.md`).**
- **P5-admin+root** `app/uso/**`, `app/workspace/**`, `app/root/**` + `domains/usage.css`.
- **P6-publicas** `/login`, `/convite`, `/invitations/[token]`, `/alterar-senha`, `/privacidade`, `/termos`, `/offline`, `/403` + `domains/auth.css`. **`/changelog` (e rotas de changelog/slug futuras) pertencem ao worker changelog (`specs/active/changelog-product-20260921.md`) — fora do pathspec deste pacote.**
- **P7-copiloto+meet** `app/tripz-ai/**`, `app/meet/**`, `app/reuniao/**` (meet apenas expected-error + fixture de sucesso se viável, R5). **`app/fluxos/**` pertence ao worker de fluxos (`specs/active/flow-integrity-20260921.md`) — fora do pathspec deste pacote.**
- **Regra de conflito:** durante workers funcionais ativos (settings/changelog/fluxos), a auditoria DS pode DIAGNOSTICAR nas frentes deles, mas NÃO EDITA esses arquivos; achados são repassados via `design/design-spec-review.md` para o worker responsável.
- Cada pacote lista consumidores dos primitivos ANTES de editá-los (grep + grep de asserções de source-string em `tests/`); vitest do pacote + tsc + eslint ao fechar; reconciliação final por agente único.
**Acceptance Criteria:** nenhum arquivo editado por 2 pacotes E nenhum arquivo de frente funcional alheia editado (pathspec disjunto conferido por diff, incluindo as exclusões acima); gates por pacote verdes.
**Verification:** `git diff --stat` por pacote comparado às listas de posse + exclusões R8.

### R9 — Separação fixture visual × persistência/tenant (Astra)
Auditoria visual = 100% fixtures (runner já proíbe API real). Validação de persistência/multi-tenant = testes de integração backend com `test:disposable` (Postgres descartável) — NUNCA a mesma execução, NUNCA fixture simulando "multi-tenant visual". Integração real (navegador/API/DB isolada) é etiquetada como tal nas evidências (R6.4).
**Acceptance Criteria:** evidências separadas por tipo (audit.json × logs test:disposable × logs de integração real); nenhuma afirmação de tenant/persistência baseada em fixtures do painel.
**Verification:** inspeção dos artefatos de evidência.

### R10 — Sem regressões e sem destruição (items 13-14, header do comments.md)
Nenhuma funcionalidade removida; componentes compartilhados só mudam com todos os consumidores listados; cada mudança global revalida todas as páginas afetadas (via R1).
**Acceptance Criteria:** suíte completa do painel verde no fim; backend: sem falha nova vs baseline congelado (falhas pré-existentes documentadas com evidência, não "consertadas" sorrateiramente).
**Verification:** logs de suíte + comparação de nomes de arquivos falhando contra baseline (regra do skill: comparar ARQUIVOS, não contagens).

## Invariants
- Identidade visual existente preservada (tokens.css não redesenhado; shared com dono único e mudanças retrocompatíveis — R2/R8).
- R4 (tipos de conteúdo) é invariante dura.
- Heading semântico único por página (R2) — sem dogma de reestilização geral.
- `data-task-id`/marcadores acessíveis existentes não podem sumir sem atualização simultânea do contrato.
- Nenhum processo alheio é morto: port ownership verificado por PID (R6.5).
- Achados NÃO são descartados automaticamente: reprodução + classificação de raiz (Edge Cases).
- Deploy SOMENTE após todos os gates + revisão visual (não é parte desta SPEC; escopo de commit = `apps/atendon/**`).

## Edge Cases
- Rotas parametrizadas com IDs de fixture inexistentes → 404 da rota (registro deve falhar, não mascarar).
- `/agente/figurinhas` redireciona para `/follow-ups` (expectedPath do contrato) — registrar o redirect, não tratá-lo como rota quebrada.
- Feature flags desligados no fixture (`FEATURE_FLAG_KEYS` false) — rotas gated renderizam estado vazio/lock: contrato precisa cobrir o estado REAL renderizado (R1d).
- **Achado isolado — SEM descarte automático (regra 107):** o toast de erro do próprio harness (599 → 8s overlay) é fonte conhecida de falso positivo, MAS isso não autoriza descartar o achado de um run único: (1) REPRODUZIR com re-run determinístico da rota/estado; (2) classificar a raiz — fixture-gap (problema do harness/fixture: corrigir fixture e registrar a correção) vs issue real (item de correção); (3) NUNCA mascarar (sem ignore/whitelist seletiva sem justificativa + evidência de reprodução). Só a reprodução com raiz em fixture encerra o achado, com registro.

## Dependencies
- Playwright/chromium instalados (ok, 1.61.1 + chromium-1228).
- Build congelado + servidor dedicado desta rodada, em porta com ownership verificado por PID (R6.5).
- Redis 6382 acessível para suites backend (serialização).
- **Jev gate: OBRIGATÓRIO e PENDENTE** — `tooling/jev_gate.py` está sendo criado por outro agente (usar com o README quando disponível; verificado nesta revisão: ainda inexistente). Nenhum DONE final da SPEC sem runner Jev real + Ponytail FULL + determinísticos verdes. Enquanto isso, o estado da rodada é PENDENTE, declarado honestamente — a formulação anterior ("gates Jev não serão alegados nesta rodada") está INCORRETA e foi removida.

## Affected Areas
`apps/panel/app/**` (todas as rotas presentes na execução), `apps/panel/components/ui/**`, `apps/panel/styles/**`, `apps/panel/scripts/design-audit*`, testes do painel; backend apenas para gates/`test:disposable` (sem mudança de API nesta SPEC). **Exclusões ativas por R8-conflitos:** Shell/nav/search/hierarquia de Configurações (worker settings), `app/changelog/**` (worker changelog), `app/fluxos/**` (worker fluxos).

## Non-goals
- Itens 1-5 do comments.md (changelog, fluxo do bot, reorganização/hierarquia de Configurações, unificação de pesquisa) — SPECs próprias.
- Editar frentes funcionais de outros workers (settings/changelog/fluxos) durante esta SPEC — apenas diagnóstico com repasse (R8).
- Redesenho de identidade visual, nova biblioteca de componentes, conversão de telas especializadas em tabela.
- Mudanças de backend/API, migrations, deploy.

## Constraints
- SEM alteração de código nesta fase de investigação/revisão (este documento + matriz + evidências apenas).
- Escopo de escrita futuro: somente os arquivos listados em R8 (com as exclusões); `comments.md` intocado; sem git reset/stash/commit/push.
- Worker único GLM-5.3-Flash por pacote, reasoning_effort=max; Ponytail FULL obrigatório nos pacotes; gate Jev obrigatório antes de DONE.

## Required Tests
- Painel: vitest por pacote (alvo) + suíte completa final — TODOS os arquivos de teste presentes na execução (contagem programática; baseline congelado para comparação por NOME de arquivo; nenhuma contagem hardcoded como meta).
- Backend: suíte FULL + suites de domínio tocadas + `test:disposable` serializado (R6.4); integração real (navegador/API/DB isolada) discriminada de fixture nas evidências — mínimos: bot edit→save→reload e changelog lifecycle quando o domínio for desta SPEC.
- Auditoria: N×2×3 registros calculados + estados de rota/tabs/overlays/flags/roles (R1) + drift-check de contratos (R5) + screenshot review com evidências por variante (R7).

## Definition of Done
- [ ] Matriz 100% das rotas presentes com registro em 2 temas × 3 viewports — contagem PROGRAMÁTICA (baseline 46/276 é apenas referência de crescimento) — e veredito visual com evidências por variante (R1, R7).
- [ ] Estados de rota/tabs/overlays/flags/roles cobertos (R1); rotas expected-error com fixture de sucesso quando viável ou BLOCKED-funcional honesto — nenhuma alegada funcional 100% sem sucesso (R5).
- [ ] Zero headers/estruturas manuais fora das exceções documentadas; heading semântico único sem dogma de reestilização (R2).
- [ ] ds-audit/ds-theme-parity/ds-orphan-classes sem achado novo vs baseline (R3).
- [ ] Kanban/calendário/canvas/inbox/dashboard intactos (R4).
- [ ] Gates R6 executados na ordem, com logs salvos e revisados, build PADRÃO (não build:ci), backend FULL, integração real discriminada, port ownership respeitado (R6).
- [ ] Gate Jev REAL (runner `tooling/jev_gate.py`) + Ponytail FULL + determinísticos verdes — sem isso o status final permanece PENDENTE.
- [ ] Evidências de fixture × persistência separadas (R9).
- [ ] Sem regressão nova (R10), sem arquivo de frente funcional alheia editado (R8) e sem objetivo global marcado concluído fora desta SPEC.

# SPEC: Dashboard visual — mini-gráficos nos KPIs, funil redesenhado e organização por grupos
## Objective
Aprimorar o visual e a organização do Dashboard (DashboardWidgets): mini gráficos de área junto
ao texto dos KPIs (estilo do código citado no comments.md), funil de conversão redesenhado e
agrupamento visual dos widgets no board.
## Source
comments.md (reescrevido 2026-09-16): "Aprimore o visual e organização do Dashboard... mini
graficos junto com texto no codigo entre aspas acima... melhorar o visual do funil".
## Current State
- Sparkline (components/commercial-dashboard-charts.tsx:1-16): polyline com fill plano; sem curva
  suave, sem gradiente em degradê, sem hover/tooltip/dot.
- KpiCard (components/ui/kpi.tsx:27-52): spark empilhado abaixo do valor, largura total.
- Funil (components/ui/funnel.tsx:32-98): trapézios deslocados (cx=0.38*width) com rótulos à
  direita; rótulos de conversão entre estágios pequenos.
- Board (components/dashboard-widgets.tsx:448): widgets em grid plano, sem separação por grupo
  (grupos só aparecem no modo edição, GROUP_LABELS:103-110).
- Sem dependência de charts externa além de ECharts; painel NÃO tem recharts.
## Desired Behavior
1. KPIs "comerciais" mostram valor + mini gráfico lado a lado (valor à esquerda, mini área à
   direita ~40% da largura, altura ~56px), como no código citado.
2. Mini gráfico: curva suave, preenchimento com gradiente vertical (cor do tone, opacidade
   ~0.3→0.05), ponto destacado no hover com tooltip simples (valor formatado) — tudo em SVG
   próprio, sem nova dependência.
3. Funil de conversão redesenhado: silhueta centralizada e legível (estágios com largura
   proporcional, rótulo + valor dentro/ao lado do estágio, taxas de conversão visíveis entre
   estágios), alinhado aos tokens do design (toneColor/useChartTokens), sem texto cortado.
4. Board agrupa widgets por `definition.group` com cabeçalho de seção discreto (overline), na
   ordem de primeira aparição; modo edição permanece como está.
## Requirements
### R1 — Sparkline interativa com gradiente (mudança interna do componente)
Reescrever `Sparkline` em components/commercial-dashboard-charts.tsx mantendo a assinatura
`({ values, tone = "var(--primary)", className })` e o retorno `null` para séries sem dados.
Curva suave (bezier/catmull-rom), gradiente vertical com id único (useId), hover com dot + valor.
Acessibilidade: continua `aria-hidden="true"` (o valor numérico já é texto).
Acceptance Criteria:
- O call site em dashboard-widgets.tsx:177 permanece IDÊNTICO (teste de source assertion).
- Séries com <2 pontos ou todos zeros não renderizam nada (comportamento atual preservado).
- Hover sobre o gráfico mostra ponto e tooltip com o valor; sem hover não há dot fixo.
Verification:
- npx vitest run tests/dashboard-widgets-ui.test.ts → passa (assertions de source intactas).
- Render manual: valores plausíveis exibem curva + gradiente; arrays [] e [0,0] não quebram.
### R2 — KpiCard com layout "texto + mini gráfico" lado a lado
Quando `spark` é fornecido, valor/hint ficam à esquerda e o spark à direita (flex row,
alinhamento baseline/fim), altura do spark ~56px; sem spark, layout atual inalterado.
Props novas são opcionais (compat com commercial-dashboard.tsx legado e demais usos).
Acceptance Criteria:
- KpiCard sem spark: marcação igual à atual (nenhum teste de quebra).
- KpiCard com spark: uma linha (row) com bloco de valor e o spark à direita em ~40% max-w-40.
Verification:
- npx vitest run tests/dashboard-widgets-ui.test.ts; npx tsc --noEmit (panel).
### R3 — Funil redesenhado (mudança interna; API intacta)
Manter `Funnel({ stages, height, ariaLabel })`, `FunnelStage`, empty state e `role="img"`.
Redesenhar geometria/leiaute: silhueta centralizada (cx no meio), estágios com largura
proporcional ao volume, rótulo + valor do estágio legíveis (dentro quando couber, ao lado quando
não), conversionLabel entre estágios com contraste; mantém tokens e `<Funnel stages={stages}`.
Acceptance Criteria:
- tests/dashboard-widgets-ui.test.ts passa sem edição (call site e rótulos do widget intactos).
- Em largura estreita o SVG escala (viewBox) sem cortar rótulos.
Verification:
- npx vitest run tests/dashboard-widgets-ui.test.ts; inspeção visual em 360px e 1280px.
### R4 — Agrupamento visual do board
No board (não no modo edição), inserir cabeçalho de seção por grupo (usa GROUP_LABELS) quando o
grupo do widget muda em relação ao widget anterior da lista visível; discreto (overline), sem
quebrar o grid 12 colunas (header ocupa linha inteira).
Acceptance Criteria:
- Widgets de mesmo grupo contíguos não repetem cabeçalho; grupos fora de ordem (layout salvo
  antigo) não quebram — cabeçalho por mudança de grupo.
- Modo edição, presets e salvamento inalterados.
Verification:
- npx vitest run tests/dashboard-widgets-ui.test.ts + render manual com layout default.
## Invariants
- Nenhuma dependência nova no package.json.
- Asserções de source de tests/dashboard-widgets-ui.test.ts permanecem verdes sem edição do teste.
- Compat Safari 12–15: sem APIs novas além de useId/mouse events (cobertos); nada de dvh.
- Legacy dashboard (CommercialDashboard) inalterado.
## Edge Cases
- Série com 1 valor único não nulo; valores todos iguais (maximum=1); período "Hoje" (série curta).
- Widget sem definição (definitions.get undefined) — comportamento atual mantido.
- tenant com dashboard_widgets_v1 OFF — usa legado, nada muda.
## Dependencies
- Nenhuma com outros SPECs. Só frontend (panel).
## Affected Areas
apps/panel/components/commercial-dashboard-charts.tsx, ui/kpi.tsx, ui/funnel.tsx,
dashboard-widgets.tsx, metrics-dashboard.module.css (se necessário), globals.css (classes
kpi-card* se o layout row exigir).
## Non-goals
- Não criar novos widgets, não mudar contratos de API do backend, não tocar no legado.
## Constraints
- Sem recharts/ECharts nos sparks; sem eslint-disable; `npm run build` deve passar
  (eslint --max-warnings=0).
## Required Tests
- Ampliar tests/dashboard-widgets-ui.test.ts? NÃO — criar teste novo
  tests/sparkline-funnel-ui.test.ts: (a) Sparkline: null em []/[0,0]/[5]; (b) renderiza svg com
  gradiente para 3+ valores; (c) KpiCard com spark renderiza value + spark no mesmo card;
  (d) Funnel renderiza role="img" + ariaLabel com stages; (e) source assertion: call sites de
  dashboard-widgets.tsx contêm `<Sparkline values={series.map((item) => item[kpi.spark as SparkKey])}`
  e `<Funnel stages={stages}` (protege R1/R3).
## Definition of Done
- [ ] R1–R4 implementados; testes novos + existentes verdes; tsc e npm run build limpos.
- [ ] Sem regressão nos 4 testes do dashboard existentes.

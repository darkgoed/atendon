# SPEC: pipeline-kanban-referencia (L11-1093 do comments.md)

## Objective
O quadro do /pipeline adota a ESTRUTURA VISUAL/INTERAÇÃO do kanban de referência
(drag por pointer events com overlay que segue o cursor, placeholder com mola, cards
vizinhos deslizam, teclado completo, ScrollRail arrastável, fade nas bordas, contagem
animada, squircle) — SEM mudar a identidade AtendON (tokens, fontes, cores, conteúdo
do card, contratos com o backend).

## Source
comments.md L11-1093 (código de referência completo no comments.md).

## Current State
- `components/pipeline-board.tsx`: HTML5 DnD (draggable/dataTransfer), colunas com dot,
  chip de automação (IA/Ligação/Manual), contagem `n/capacity`, valor BRL, média de idade,
  barra de capacidade, load-more por coluna, "+ Adicionar lead" estático.
- `components/pipeline-card.tsx`: conteúdo AtendON — MANTER (identidade).
- `styles/domains/pipeline.css`: domain CSS do quadro (classes pipeline-*).
- Governança: `allowedTransitions` (Set "origem:destino"), drop → `onMoveRequest(lead,
  stage)` que pode abrir PipelineTransitionDialog (dados comerciais) ou mover direto.
  `pendingLeadIds` bloqueia card em voo; `columnLoadMore`/`onColumnLoadMore` paginam.
- framer-motion NÃO instalado — instalar `framer-motion` (D5, dependência nova autorizada
  pelo requisito da referência; pino ^12 com suporte a React 19).

## Desired Behavior
Porta a mecânica do componente de referência para `PipelineBoard`:
1. Drag por pointer events (não HTML5 DnD): card sai da lista em overlay motion
   (`useMotionValue` x/y, LIFT_SPRING, leve rotate/zoom), lista fecha o buraco, placeholder
   tracejado com mola abre na posição de inserção calculada sobre snapshot de midpoints
   (sem flicker), vizinhos deslizam (FLOW_SPRING), edge autoscroll na faixa, máscara de
   fade nas bordas do track, ScrollRail arrastável quando transborda.
2. Teclado: foco no card, Espaço pega/seta, setas movem, Espaço solta, Esc devolve;
   anúncios via `role="status"` (pt-BR, mesmos textos de hoje quando aplicável).
3. Contagem da coluna animada (key change) e placeholder/overlay com reduceMotion respeitado.
4. Drag-and-drop EM um navegador real move o lead pelo mesmo caminho de hoje.

### Regras de domínio que a referência NÃO tem (adaptar, não copiar cegamente)
- Reordenação DENTRO da coluna: NO-OP (visual: card volta; anúncio "movimento na mesma
  etapa") — backend não tem ordem; NÃO mentir com ordem local que o poll 15s desfaria.
- Placeholder só em coluna PERMITIDA (allowedTransitions tem origem:destino e stage
  operational_kind != "ai_follow_up"); nas demais, coluna dimmed como hoje e drop lá
  devolve o card à origem.
- Espaço/Enter de solte → `onMoveRequest(lead, stage)` (o dialog de transição continua).
- `canMove=false` → cards não pegam (sem cursor-grab, sem drag); seleção via checkbox
  continua; densidade compact/comfortable e columnWidth (pref) continuam valendo.
- Ícones da referência em lucide — o painel usa Phosphor: usar Phosphor equivalente
  (identidade AtendON vence a referência em iconografia).
- FONT_STACK/Inter da referência NÃO entra (tokens AtendON).

## Requirements
### R1 — Mecânica de drag fiel
Overlay + placeholder + springs + autoscroll + máscara + rail, como na referência.
Acceptance: e2e/interação (Playwright do repo, fixtures): arrastar card de "Novo" para
"Qualificado" (transição permitida) chama onMoveRequest com o stage alvo; placeholder
visível durante o drag; Esc devolve; rail aparece quando transborda.
Verification: script do orquestrador no harness de fixtures + screenshots.

### R2 — Governança preservada
Nenhum movimento para coluna não permitida; dialog de transição abre quando exigir;
pendingLeadIds mantém card bloqueado; erro → rollback visual (estado do SWR hoje).
Acceptance: vitest da página + novo teste de componente da board com stages fake.
Verification: tests/pipeline-* existentes verdes (ajustar APENAS asserções de fonte
pinadas — listar strings antes de editar).

### R3 — Teclado e a11y
Mesma grade de acessibilidade da referência (tabIndex, aria-roledescription "Draggable
card"/pt-BR, aria-grabbed, live region polida).
Acceptance: teste de componente simula Espaço→setas→Espaço e vê onMoveRequest.

### R4 — Sem regressão visual de identidade
Tokens AtendON (--surface, --border, radius do design system), card de PipelineCard
intacto em conteúdo; colunas continuam com valor/média/capacidade/load-more.
Acceptance: screenshots 1280px light/dark comparáveis (identidade preservada);
nada de fontes/cores novas fora tokens.

## Invariants
- PipelineList (visão lista) intocado.
- Contratos com a página (props do PipelineBoard) preservados; preferências funcionam.
- Sem backend novo; nenhuma rota nova.

## Edge Cases
- Coluna vazia: placeholder no índice 0.
- Card mais alto que a coluna: autoscroll vertical por coluna (body scroll) como hoje.
- Ponteiro fora do quadro no fim do drag: devolve.
- touch: `touch-action:none` apenas nos cards (a referência usa touch-none) — scroll da
  página em mobile não pode morrer fora do card.

## Dependencies
framer-motion ^12 (nova dependência — D5). React 19 ok.

## Affected Areas
components/pipeline-board.tsx (reescrita da mecânica), components/pipeline-card.tsx
(adaptar onDragStart HTML5 → onPointerDown; API props preservada onde possível),
styles/domains/pipeline.css, package.json (+framer-motion), tests ajustados + novos.

## Non-goals
- Ordenação persistida entre leads (sem backend).
- Drag de colunas / reorder de etapas.
- WIP limits, filtros novos.

## Constraints
- Ponytail: portar a referência com o MENOR número de adaptações que preserve domínio;
  não reimplementar o que a referência já resolve (snapshot, slotAt, rail).
- web-compat: usar randomUUID etc. via lib/compat se necessário; nada de API nova sem guard.

## Required Tests
- Componente da board: drag pointer → move permitido; mesmo-coluna no-op; não permitida
  devolve; teclado Espaço/setas/Espaço; Esc devolve; rail presente quando transborda
  (jsdom: stub de getBoundingClientRect ok, sem Radix novo).
- Atualizar testes de fonte que pinam pipeline-board/card (grep antes).

## Definition of Done
- [ ] R1-R4; vitest+tsc verdes; build verde; probe visual com screenshots.

# SPEC: Scroll horizontal do pipeline com Shift + roda

## Objective
Permitir que a pessoa navegue horizontalmente entre as colunas do pipeline usando `Shift + roda do mouse` em qualquer ponto do quadro, inclusive sobre um card, sem remover o scroll vertical normal dos cards/colunas nem interferir no drag-and-drop.

## Source
comments.md

Item da linha 3: “No pipeline, esta dificil para scrollar horizontalmente, quando o mouse esta sobre um card e a pessoa tenta com shift e scroll, não quer scrollar”.

## Current State
- `apps/panel/app/leads/pipeline/page.tsx` renderiza o quadro dentro de `.pipeline-page__board` e delega sua renderização a `PipelineBoard`; não há handler de roda nessa página.
- `apps/panel/components/pipeline-board.tsx:124` renderiza o `<section className="pipeline-board ...">` com `overflow-x-auto`, `overflow-y-hidden` e `overscroll-contain`. As colunas são filhas diretas do board.
- `apps/panel/components/pipeline-board.tsx:221-230` implementa drag-and-drop nativo nas colunas (`onDragOver` chama `preventDefault()` apenas quando a coluna é destino permitido; `onDrop` também cancela o evento). Não há `onWheel` no board, na coluna ou no card.
- `apps/panel/components/pipeline-board.tsx:245` renderiza o corpo de cada coluna com `overflow-y-auto`, `overflow-x-hidden` e `overscroll-behavior: contain` via CSS. Portanto, quando o ponteiro está sobre um card, a roda começa no corpo rolável da coluna; a coluna captura o gesto, não possui eixo horizontal, e `overscroll-behavior: contain` impede a propagação para o ancestor `.pipeline-board`.
- `apps/panel/components/pipeline-card.tsx:91-97` usa `draggable` nativo no `<article>` quando `canMove && !pending`, mas não registra handlers de roda nem chama `preventDefault()`. O card é descendente do corpo da coluna e herda esse caminho de eventos/scroll.
- `apps/panel/app/globals.css:751-765` define o layout relevante: `.pipeline-page__board` tem `overflow:hidden`; `.pipeline-board` é o scroller horizontal (`overflow-x:auto`, `overflow-y:hidden`, `overscroll-behavior-inline:contain`); `.pipeline-column` tem `overflow:hidden`; `.pipeline-column__body` é o scroller vertical (`overflow-x:hidden`, `overflow-y:auto`, `overscroll-behavior:contain`). Não foi encontrado CSS adicional de pipeline em outro arquivo.
- Não existem handlers de `wheel` nos três arquivos investigados, nem biblioteca de DnD: o movimento usa a API nativa de drag events.

## Desired Behavior
- `Shift + wheel` sobre o board, header de uma coluna, corpo vazio, card, botão, checkbox ou qualquer outro descendente deve alterar `scrollLeft` do `.pipeline-board` no sentido correspondente ao delta horizontal do gesto (com fallback para `deltaY` quando o dispositivo/browser fornece a roda vertical com Shift).
- A rolagem horizontal deve continuar funcionando mesmo quando o corpo da coluna sob o ponteiro ainda pode rolar verticalmente.
- Wheel sem Shift deve continuar sendo consumido pelo `.pipeline-column__body` para rolagem vertical da coluna; não deve mover horizontalmente o board como efeito colateral.
- O drag-and-drop nativo de cards deve manter seleção, arraste, entrada/saída de coluna, drop permitido e drop rejeitado exatamente com as mesmas regras atuais.

## Requirements
### R1
Implementar um único caminho de tratamento para `Shift + wheel` no escopo do quadro, com delegação no board ou listener equivalente que alcance todos os descendentes, inclusive `PipelineCard`.

Acceptance Criteria:
- Com o ponteiro sobre um card e `shiftKey === true`, um evento de roda move o `scrollLeft` do elemento `.pipeline-board` sem depender do `scrollTop`/overflow horizontal da coluna.
- O mesmo comportamento ocorre sobre header, espaço vazio, área de drop, controles e qualquer outro descendente do board.
- O sentido do movimento é preservado: delta positivo desloca para a direita e delta negativo para a esquerda; quando `deltaX` for zero, o valor efetivo usa `deltaY`.

Verification:
- Teste automatizado de componente/DOM dispara `WheelEvent` com `shiftKey: true` em um `PipelineCard` e verifica que o board altera `scrollLeft`/recebe o delta esperado.
- Teste manual no navegador confirma o comportamento sobre pelo menos um card, o header e o espaço vazio do board.

### R2
Manter a rolagem vertical independente das colunas.

Acceptance Criteria:
- Wheel sem Shift sobre um card ou dentro de `.pipeline-column__body` altera `scrollTop` da coluna quando há conteúdo vertical suficiente.
- Wheel sem Shift não altera `scrollLeft` do board.
- `Shift + wheel` não altera `scrollTop` da coluna como consequência do fallback horizontal.

Verification:
- Testes automatizados cobrem wheel com `shiftKey: false` e `shiftKey: true`, verificando eixo e destino de scroll.
- Teste manual com coluna contendo cards suficientes confirma scroll vertical normal e, em seguida, Shift + roda confirma navegação horizontal.

### R3
Não quebrar drag-and-drop nativo nem ações dos cards.

Acceptance Criteria:
- `draggable` continua habilitado exatamente quando `canMove && !pending`.
- Durante drag, `onDragStart`, `onDragEnd`, `onDragEnter`, `onDragLeave` e `onDrop` continuam disparando; somente colunas com transição permitida continuam aceitando drop.
- O tratamento de wheel não chama `preventDefault()` para wheel sem Shift e não bloqueia `dragstart`, `dragover` ou `drop`.
- Checkbox, “Mover” e “Detalhes” continuam acionáveis.

Verification:
- Testes existentes de pipeline/DnD permanecem passando.
- Teste automatizado ou E2E inicia drag de um card e verifica que o estado de drag/drop e a solicitação de movimento permanecem inalterados.
- Executar `npm test`, `npm run lint`, `npm run typecheck` e `npm run build`.

### R4
Preservar acessibilidade e navegação por teclado do quadro.

Acceptance Criteria:
- O board continua com `aria-label="Quadro de pipeline"` e `tabIndex={0}`.
- A solução não remove foco visível nem introduz listener que afete teclado, clique ou ativação de controles.
- A rolagem horizontal acionada por roda não cria overflow no documento/página fora do board.

Verification:
- Testes/E2E existentes continuam verificando ausência de overflow no documento.
- Verificar manualmente foco visível no board e nos controles após a mudança.

## Invariants
- A ordem, largura configurável e altura das colunas permanecem inalteradas.
- `.pipeline-board` continua sendo o único container horizontal; `.pipeline-column__body` continua sendo o container vertical.
- Regras de permissão, transições, seleção, carregamento e persistência de leads não mudam.
- Nenhuma chamada de API ou modelo de dados é necessária para corrigir o comportamento.

## Edge Cases
- `deltaX` e `deltaY` podem ser zero, fracionários ou ter valores grandes; o handler deve evitar NaN e respeitar os limites naturais de `scrollLeft`.
- Dispositivos que já entregam delta horizontal com Shift não devem receber o delta vertical em duplicidade.
- Ao atingir o início/fim do board, o gesto não deve criar scroll horizontal no documento; o comportamento de overscroll deve permanecer contido.
- Coluna vazia, skeleton/loading, mensagem de drop e card `pending` devem continuar permitindo Shift + roda.
- Durante um drag ativo, o novo tratamento não pode transformar a roda em drop nem alterar o alvo de drop.
- A página deve continuar sem overflow horizontal global em viewport estreita.

## Dependencies
- React/Next.js client components.
- DOM `WheelEvent` e scrolling nativo (`scrollLeft`).
- Classes/layout existentes em `apps/panel/app/globals.css`.
- Suíte e scripts npm do monorepo.

## Affected Areas
- `apps/panel/components/pipeline-board.tsx` — ponto primário para captura/delegação do gesto e proteção do DnD.
- `apps/panel/components/pipeline-card.tsx` — verificar que nenhum handler/atributo do card impeça a delegação; só alterar se necessário.
- `apps/panel/app/leads/pipeline/page.tsx` — integração do board; não deve receber lógica duplicada.
- `apps/panel/app/globals.css` — somente se necessário para manter explicitamente os eixos/overscroll sem sacrificar o comportamento requerido.
- Testes de componente/E2E do painel, conforme a infraestrutura existente.

## Non-goals
- Não substituir a API nativa de drag-and-drop por uma biblioteca.
- Não adicionar arraste manual por mouse/touch para scroll horizontal.
- Não mudar a rolagem da agenda, filtros ou outras telas.
- Não alterar dados, permissões, transições ou visual dos cards.
- Não remover o scroll vertical das colunas.

## Constraints
- Alteração mínima e localizada; não duplicar listeners de roda em cada card.
- Não usar `preventDefault()` para wheel normal; para Shift + wheel, só cancelar o evento se isso for necessário para impedir que o browser também faça um scroll concorrente.
- Não cancelar eventos de drag-and-drop além das regras já existentes.
- Respeitar os estilos e convenções atuais de Tailwind/CSS; manter o arquivo de cada componente abaixo do limite de 500 linhas.
- Validar qualquer mudança de CSS contra `overflow-x`, `overflow-y` e `overscroll-behavior` dos três níveis: página, board e corpo da coluna.

## Required Tests
- Teste unitário/componente do handler: Shift + wheel em card, header e área vazia move somente o board.
- Teste unitário/componente: wheel normal em corpo/card move somente o corpo vertical da coluna.
- Teste de limites: board no início/fim e deltas zero/fracionários não geram exceção nem overflow global.
- Teste de regressão de DnD: drag permitido faz drop e chama `onMoveRequest`; drag não permitido não aceita drop.
- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

## Definition of Done
- [ ] A causa do problema permanece coberta: o Shift + wheel sobre descendentes não fica preso no scroller vertical da coluna.
- [ ] Shift + wheel em qualquer ponto do board rola horizontalmente o board.
- [ ] Wheel normal continua rolando verticalmente dentro da coluna e não move o board.
- [ ] Drag-and-drop, controles e permissões do card continuam funcionando.
- [ ] Testes automatizados para os dois eixos, bordas e DnD foram adicionados/ajustados e passam.
- [ ] `npm test`, `npm run lint`, `npm run typecheck` e `npm run build` passam.
- [ ] Não há overflow horizontal global nem regressão de acessibilidade.

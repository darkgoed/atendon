# SPEC: inbox-lista-e-filtros (L5, L7, L9 do comments.md)

## Objective
Inbox /conversas: (a) sem scroll horizontal em nenhuma largura, card do lead inteiro;
(b) sem o contador acima da barra de busca (grupo da busca sobe); (c) filtros com o MESMO
componente/visual do /contatos (ListFiltersBar).

## Source
comments.md L5, L7, L9.

## Current State
- Contador: `app/conversas/page.tsx:1404-1408` (pill `{items.length}` em
  `.conversation-list__meta`, `mb-3`) — REMOVER; busca sobe no lugar.
- Filtros: botão ad-hoc "Filtros (N)" + chips aria-pressed + Limpar (:1425-1458).
- /contatos usa `ListFiltersBar` (`components/ui/filters.tsx`) — padrão do repo
  (pipeline-filters.tsx também usa).
- Scroll horizontal: a confirmar em runtime (probe Playwright em 1280/1041/900/760/375px);
  candidatos: conteúdo mono sem quebra (`conversation-list__company`), chips de tags
  (`LeadTagChips compact`), `conversation-list__footer` (overflow-hidden já), ou o grid
  `minmax(440px,1fr)` entre 1041-1180px.

## Desired Behavior
- Em NENHUMA largura (1280→360px) `document.scrollingElement.scrollWidth` e o painel da
  lista excedem a viewport horizontalmente; card do lead renderiza completo, quebrando
  linha onde preciso (mono com `overflow-wrap:anywhere`), tags em wrap.
- Header da lista: busca imediatamente onde estava o contador (sem respiro fantasma);
  `conversation-screen__summary` do header da tela mantém (contador de FILA da tela, não
  é o removido).
- Filtros: `ListFiltersBar` com defs mapeados dos filtros existentes —
  `fila` (option, queues ativas com dot de cor), `responsavel` (option, membros),
  `numero` (option, conexões, só quando showConnectionFilter), `nao_lidas` (option,
  true="Não lidas"), `pendencias` (option, true="Pendências"). "Minhas conversas"/
  "Sem responsável" viram `meu_escopo` option (mine|unassigned|human). Tabs
  Abertas/IA/Agendadas/Resolvidas PERMANECEM (navegação de status, fora do escopo do L9).
  "Limpar filtros" = onClearAll do componente (reseta exatamente o mesmo conjunto de hoje,
  inclusive o default de escopo por permissão).

## Requirements
### R1 — Zero scroll horizontal
Probe próprio (script Playwright no harness de fixtures do repo, verificação do
orquestrador): scrollWidth <= clientWidth no `.conversation-list`, no `.content` e no
document, em 1280/1041/900/760/375. Corrigir a causa RAIZ (min-width/fontes/nowrap),
não remendo `overflow:hidden` que esconda conteúdo.
Acceptance: probe verde nas 5 larguras (light+dark opcional).
Verification: log do probe anexado em .hermes/state/comments-spec-loop/.

### R2 — Contador removido, busca sobe
Bloco `conversation-list__meta` do pill removido; busca colapsa o espaço (header perde o
respiro `mb-3` órfão). NÃO remover o `.conversation-screen__summary` do header da tela.
Acceptance: grep da página não contém `conversation-list__meta` com o pill; screenshot
mostra busca onde era o contador.
Verification: probe visual (screenshot em 1280 e 375).

### R3 — Filtro único (ListFiltersBar)
Mesma semântica de query atual (os mesmos parâmetros vão para o mesmo estado). Chips
ativos = exatamente os filtros aplicados; remover chip = limpar aquele filtro; Limpar =
estado default (escopo default por permissão, como hoje em :1456).
Acceptance: vitest — setar cada filtro via ListFiltersBar produz o mesmo estado que os
botões de hoje produziam; contagem `advancedFilterCount` (se usada para badge) compatível.
Verification: vitest novo/atualizado em tests/.

## Invariants
- Poll/refreshInterval, keyset pagination, unreadCounts, realtime: intactos.
- A11y: chips com aria (o ListFiltersBar já entrega); manter `aria-label`s dos selects
  quando existirem.
- Testes existentes de fonte de conversas: `tests/comments-current-tasks.test.ts` exige
  `conversation-list__item group`, SEM SavedViewsControl, etc. — não quebrar.

## Edge Cases
- Lista mobile ≤760px: filtros colapsáveis não podem exigir scroll horizontal para fechar.
- Sem filas/membros carregados: chip de option vazio não pode sumir com a barra
  (defs com options vazio ainda removem o chip ao clicar — comportamento do componente).

## Dependencies
Nenhuma externa.

## Affected Areas
app/conversas/page.tsx, styles/domains/conversations.css, tests (atualizar os que pinam
fonte da página; novo teste de filtros).

## Non-goals
- Não trocar tabs de status; não paginar diferente; não mudar o thread/composer.

## Constraints
- Ponytail: reuso integral de ListFiltersBar (zero CSS novo de chip).

## Required Tests
- vitest: filtros mapeiam estado; contador removido; regressão de fonte existente verde.

## Definition of Done
- [ ] R1 probe verde (5 larguras) com log no state dir.
- [ ] R2, R3 vitest/tsc verdes; build verde.

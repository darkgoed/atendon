# SPEC: /leads/pipeline — dar vida ao botão "Lista"

## Objective

Tornar funcional o alternador de visualização do pipeline: além do Kanban,
oferecer uma visão em Lista real dos mesmos leads, com as mesmas ações.

## Source

comments.md L100: "Em /leads/pipeline do lado do botão Kanban tem o botão Lista,
dê vida à esse botão"

## Current State

- `apps/panel/app/leads/pipeline/page.tsx:239-242` renderiza o alternador:
  ```tsx
  <div className="pipeline-page__view" aria-label="Visualização do pipeline">
    <span aria-current="page">Kanban</span>
    <span aria-disabled="true">Lista</span>
  </div>
  ```
  São `<span>`, não `<button>`. Não existe nenhum estado `viewMode`/`view`.
- O único estado de visualização é `preferences` (via `usePipelinePreferences`),
  usado só para densidade/largura do Kanban.
- Dados já disponíveis na página: `visibleLeads` (subconjunto já filtrado,
  page.tsx:131-139), `stages`, `members`, `loading`, permissões.
- Movimentação de lead já implementada em page.tsx:164-228 (`requestMove` /
  `moveLead`), com atualização otimista e dois endpoints:
  - legacy: `PATCH /scheduling/leads/:id/status` (page.tsx:208-210)
  - pipeline configurado: `PATCH /organization/leads/:id/stage` (page.tsx:211-214)
- Tipos em `apps/panel/lib/pipeline.ts:63-76` (`PipelineStage`) e `PipelineLead`.
  Helper `currentPipelineStageId(lead, stages, legacy)` resolve o estágio atual.
- `BulkLeadActions` (`apps/panel/components/bulk-lead-actions.tsx`) já existe e é
  usado na listagem de /leads.
- Padrão de tabela responsiva do projeto: classes `admin-table-wrap
  responsive-table-wrap` + `admin-table responsive-table` com `data-label` por
  célula (ex.: apps/panel/app/workspace/members/page.tsx:224-226).

## Desired Behavior

O usuário clica em "Lista" e a mesma coleção de leads (já filtrada) é exibida em
tabela; clica em "Kanban" e volta ao board. A escolha persiste ao recarregar a
página. Nenhuma requisição extra de dados é feita: a Lista consome exatamente
`visibleLeads`.

## Requirements

### R1 — Alternador funcional e acessível

Description: substituir os dois `<span>` por `<button type="button">` reais, com
estado `viewMode: "kanban" | "list"`.

Acceptance Criteria:
- Ambos são `<button type="button">`; nenhum tem `aria-disabled="true"`.
- O botão ativo tem `aria-pressed="true"` (ou `aria-current="page"`), o inativo
  `aria-pressed="false"`.
- Clicar em "Lista" renderiza a tabela e desmonta o board; clicar em "Kanban"
  faz o inverso.
- Navegação por teclado (Tab + Enter/Espaço) alterna a visão.

Verification: teste de UI renderizando a página real e simulando o clique.

### R2 — Persistência da escolha

Description: o modo escolhido persiste entre recarregamentos.

Acceptance Criteria:
- A escolha é gravada no mesmo mecanismo de preferências já usado pelo pipeline
  (`usePipelinePreferences`) se ele suportar campo novo; caso contrário em
  `localStorage` com chave namespaced (ex.: `atendon:pipeline:view`).
- Recarregar a página em modo Lista mantém a Lista.
- Valor inválido/ausente cai para `"kanban"` sem erro.

Verification: teste unitário do helper de leitura/escrita da preferência.

### R3 — Tabela de leads reaproveitando dados e padrões existentes

Description: a Lista exibe `visibleLeads` em tabela, usando o padrão de tabela
responsiva já existente no painel.

Acceptance Criteria:
- Nenhuma nova chamada de API é feita ao alternar para Lista (mesma fonte
  `visibleLeads`).
- Colunas mínimas: contato/lead, estágio atual, responsável, idade no estágio,
  próximo follow-up.
- O estágio exibido usa `currentPipelineStageId(lead, stages, legacy)`; para
  estágios operacionais (`operational_kind`) exibe o nome operacional, não
  `lead.status` cru.
- Usa `admin-table-wrap responsive-table-wrap` + `admin-table responsive-table`
  com `data-label` em cada `<td>`, como o resto do painel.
- Estado vazio usa o componente `Empty` já existente.
- Estado de carregamento reaproveita o mesmo `loading` da página (skeleton),
  sem timer artificial.

Verification: teste de UI + inspeção visual das classes.

### R4 — Ações preservadas na Lista

Description: as ações disponíveis no Kanban continuam disponíveis na Lista.

Acceptance Criteria:
- Seleção múltipla + `BulkLeadActions` funcionam na Lista.
- Existe uma ação de mover estágio por linha que chama `requestMove`/`moveLead`
  já existentes — sem duplicar a lógica de endpoint.
- As permissões que escondem/desabilitam ações no Kanban valem igualmente na
  Lista (nenhuma ação fica acessível a quem não pode).

Verification: teste que renderiza a Lista sem a permissão e afirma ausência da
ação.

## Invariants

- Design preservado: cores, fontes, espaçamentos e componentes do design system
  atual. Nada de biblioteca nova de tabela.
- A lógica de mover lead NÃO é reimplementada — a Lista chama as funções já
  existentes em page.tsx.
- Os filtros do pipeline aplicam-se igualmente às duas visões.

## Edge Cases

- Zero leads após filtro → estado vazio, não tabela vazia sem cabeçalho.
- Lead sem responsável / sem próximo follow-up → célula com placeholder, não
  "undefined"/"null".
- Lead em estágio arquivado (`archived_at`) → exibir sem quebrar.
- Pipeline legacy (sem estágios configurados) → a Lista funciona igual.
- Viewport estreito → a tabela responsiva colapsa via `data-label`, sem overflow
  horizontal da página.

## Dependencies

Nenhuma (usa apenas o que já existe na página).

## Affected Areas

- apps/panel/app/leads/pipeline/page.tsx
- novo componente, ex.: apps/panel/app/leads/pipeline/pipeline-list.tsx
- apps/panel/lib/pipeline.ts (apenas se precisar exportar helper)
- apps/panel/app/globals.css (bloco `.pipeline-*` somente)

## Non-goals

- Redesenhar o Kanban.
- Adicionar ordenação/paginação server-side.
- Criar endpoints novos.

## Constraints

- globals.css é compartilhado nesta rodada: editar SOMENTE o bloco
  `.pipeline-*`.
- O build do painel roda `eslint --max-warnings=0` — nenhum import órfão.

## Required Tests

- `apps/panel/tests/pipeline-view-list.test.tsx`: renderiza a página real
  (com `vi.mock` do SWR/api no padrão de `leads-toolbar.test.tsx`) e verifica:
  1. clicar em "Lista" mostra a tabela;
  2. clicar em "Kanban" volta ao board;
  3. sem permissão de mover, a ação de mover não é renderizada;
  4. a preferência persiste (helper).
- Os testes devem importar o código de produção — proibido asserção de string
  sobre o próprio arquivo-fonte.

## Definition of Done

- [ ] R1..R4 atendidos e verificados
- [ ] `npx vitest run` (painel) exit 0, incluindo o novo teste
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] `npx eslint app/leads/pipeline --max-warnings=0` → 0
- [ ] Nenhuma requisição extra ao alternar de visão

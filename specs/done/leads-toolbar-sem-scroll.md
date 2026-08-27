# SPEC: Leads com toolbar superior e rolagem interna

## Objective
Reorganizar a página `/leads` para que as funcionalidades operacionais deixem de ocupar cards/blocos próprios no fluxo vertical e sejam acessadas por botões no topo, mantendo o padrão visual e estrutural já usado em Conversas, Pipeline e Agenda. A página deve ocupar a viewport disponível sem rolagem vertical do documento; somente a superfície da lista/tabela de leads deve rolar.

## Source
comments.md

Item 13: “Em leads, fazer com que ao inves das funcionalidades terem divs/cards proprios, eles serem botões que ficam no topo, igual conversas, pipeline e agenda... Pois não quero q a pagina seja scrollavel, pessima visualização, organize isso para mais clareza tambem.”

## Current State
- `apps/panel/app/leads/page.tsx` usa `<Shell>` sem `fitViewport`, um `.leads-page` com altura mínima mas sem contenção de viewport, e o cabeçalho `.leads-page__header` seguido por um bloco `.leads-filters` com sete campos sempre expostos.
- O cabeçalho mostra título/descrição, contagem e apenas `SavedViewsControl` (`Visões`) no lado direito.
- Os filtros de busca, status, avaliação, fila humana, agenda, categoria e parceiro estão em um `<section className="leads-filters">`, ocupando altura própria na página.
- A tabela fica em `.leads-table-surface responsive-table-wrap`; a classe comum `responsive-table-wrap` tem `overflow-x: auto`, mas não define uma área vertical interna para a lista. Em telas móveis, o CSS troca a tabela por cards responsivos, portanto a especificação deve preservar o comportamento móvel sem permitir que o documento inteiro role no desktop.
- A seleção em massa aparece por `BulkLeadActions` como um `<aside>` fixed no rodapé quando há seleção. Ele contém seleção de ação, destino, prévia, aplicação e desfazer.
- Em cada linha, `LeadTagPicker` renderiza o botão/dropdown `Etiquetas`; a ação `Qualificar com IA` é um botão inline por lead; `Ver detalhes` é um link inline.
- `TagCatalogSettings` já é um botão `Catálogo` que abre modal, mas não é importado/renderizado em `apps/panel/app/leads/page.tsx`.
- `PipelineFilters` já demonstra o padrão de toolbar compacto: busca visível, botão `<details>` “Filtros” com contador e painel expansível, além de “Limpar”. Ele é usado em `apps/panel/app/leads/pipeline/page.tsx`, não na lista principal de leads.
- `SavedViewsControl` já é um botão `Visões` com `PopoverMenu`, cujo conteúdo (listar, aplicar, excluir e salvar visão) rola internamente com `max-h-52 overflow-y-auto`.
- `apps/panel/app/leads/pipeline/page.tsx` usa `<Shell fitViewport>`, cabeçalho fixo de 48px e ações superiores (`SavedViewsControl`, preferências e configurações), com filtro em barra própria e quadro contido.
- `apps/panel/app/conversas/page.tsx` usa `Shell flush`, uma tela `flex h-full min-h-0 flex-col overflow-hidden`, cabeçalho `shrink-0` com ações no topo e layout interno `min-h-0 flex-1 overflow-hidden`.
- `apps/panel/app/agenda/page.tsx` usa `<Shell fitViewport>`, coloca `AgendaHeader` no topo e mantém apenas a área `.agenda-scroll` como rolagem de conteúdo.
- `apps/panel/app/globals.css` define o estilo atual dos leads em `1481–1548`: `.leads-page` não está contido em viewport, `.leads-filters` é uma grade sempre visível e `.leads-table-surface` não é o scroll vertical interno exigido.
- A SPEC concluída `specs/done/simplificar-visualizacao-leads.md` trata exclusivamente do detalhe de qualificação em `/leads/[id]`; não altera a lista `/leads`, tabela, filtros ou toolbar. Seu comportamento simplificado deve ser preservado.

## Desired Behavior
A lista `/leads` deve seguir a composição de tela operacional dos módulos de referência: `Shell fitViewport`, página flexível com `min-h-0` e `overflow-hidden`, cabeçalho/toolbar superior `shrink-0`, e lista ocupando o restante com rolagem própria. A toolbar deve mostrar botões claros para Visões, Filtros, Catálogo (quando autorizado) e ações em massa (quando houver seleção). Filtros detalhados e operações que exigem formulário devem abrir dropdown/popover ou modal, sem criar cards verticais permanentes. A tabela/lista deve continuar com os mesmos dados, permissões, endpoints, seleção, tags, qualificação e navegação para detalhes.

## Requirements
### R1 — Composição de viewport e scroll interno
Alterar a composição da página de leads para reutilizar exatamente o padrão de contenção usado pelo Pipeline/Agenda e o padrão `min-h-0 overflow-hidden` usado por Conversas.

Acceptance Criteria:
- `/leads` renderiza `Shell fitViewport` e um contêiner de página com `height: 100%`, `min-height: 0`, `display: flex`, `flex-direction: column` e `overflow: hidden` (ou classes Tailwind equivalentes).
- Cabeçalho e toolbar não encolhem (`shrink-0`); a superfície que contém a lista ocupa o espaço restante (`flex: 1`, `min-height: 0`) e possui `overflow-y: auto`.
- Em viewport desktop com mais leads do que o espaço disponível, `document.documentElement`/`body` não ganha rolagem vertical; a rolagem ocorre no elemento da lista/tabela.
- O comportamento responsivo existente da tabela e sua rolagem horizontal continuam funcionando.

Verification:
- Teste de componente/browser ou inspeção automatizada de DOM/CSS com lista longa, verificando `scrollHeight > clientHeight` na lista e ausência de overflow vertical no documento.
- `npm run lint`, `npm run typecheck` e `npm run build`.

### R2 — Toolbar superior seguindo o padrão dos módulos
Substituir a apresentação vertical atual por uma toolbar no cabeçalho, copiando as convenções reais de `pipeline-page__header`, `pipeline-page__actions`, `conversation-screen__header` e `AgendaHeader`: título/contagem à esquerda e ações agrupadas à direita, com botões `.btn` compactos e componentes de menu existentes.

Acceptance Criteria:
- O cabeçalho mantém título contextual (“Leads”/“Meus leads”) e contagem/status, sem a descrição ocupar uma linha vertical adicional em desktop.
- `SavedViewsControl` permanece como botão `Visões` no grupo superior e continua aplicando/removendo/salvando visões de leads.
- Existe um botão superior `Filtros` (com contador de filtros ativos) que abre um dropdown/popover ou painel expansível, em vez de renderizar os sete campos permanentemente na página.
- O botão/painel de filtros contém busca, status, avaliação, fila humana, agenda, categoria e parceiro, preserva debounce da busca e oferece ação objetiva de limpar filtros.
- A toolbar usa o mesmo padrão de espaçamento, borda, superfície e altura do cabeçalho/ações dos módulos de referência; não criar um novo padrão visual paralelo.

Verification:
- Teste de interação: abrir `Filtros`, alterar cada campo, confirmar atualização da consulta e fechar/reabrir preservando valores; limpar e verificar estado vazio.
- Inspeção de fonte confirma que os campos não são filhos permanentes do fluxo principal fora do controle de filtros.
- `npm run lint` e `npm run typecheck`.

### R3 — Catálogo de etiquetas como ação superior e modal
Disponibilizar `TagCatalogSettings` como ação da toolbar, sem transformar o catálogo em card da página.

Acceptance Criteria:
- Quando `tags.manage` e organização estiverem habilitados, a toolbar exibe o botão `Catálogo` já fornecido por `TagCatalogSettings`.
- Clicar em `Catálogo` abre o modal existente; listar, criar, editar, arquivar e erros continuam funcionando pelos mesmos endpoints e permissões.
- O modal conserva rolagem própria (`max-h`/`overflow-y-auto`) e não causa rolagem vertical da página de leads.
- Sem permissão ou sem organização, o botão e o modal não são renderizados.

Verification:
- Teste com permissão habilitada/desabilitada e organização ligada/desligada.
- Teste de abertura/fechamento e de conteúdo longo do modal.
- `npm run typecheck` e `npm run build`.

### R4 — Ações em massa no topo, com fluxo de confirmação preservado
Mover o acionador de `BulkLeadActions` do rodapé fixed para uma ação claramente localizada na toolbar quando houver seleção, mantendo o componente de prévia/aplicação/desfazer como dropdown, popover ou modal.

Acceptance Criteria:
- Ao selecionar leads, a toolbar exibe botão com contagem, por exemplo `Ações em lote (N)`; sem seleção, não há controle de lote visível.
- O painel aberto mantém as ações permitidas por `tags.apply`, `leads.update_status` e `leads.transfer`, carregamento de destinos, prévia, bloqueio de lote inválido, aplicação idempotente, atualização da lista e desfazer temporizado.
- O controle não fica permanentemente sobre a tabela nem ocupa uma faixa vertical da página; qualquer conteúdo extenso do fluxo tem rolagem interna.
- Após aplicar ou cancelar, a seleção e a contagem ficam consistentes com o comportamento atual.

Verification:
- Teste de seleção de um e vários leads, abertura do controle, prévia válida/inválida, aplicação, cancelar e desfazer.
- Verificar que o limite de 200 selecionados e permissões continuam aplicados.
- Teste de viewport pequeno para assegurar que o painel não ultrapassa a viewport.

### R5 — Ações por lead permanecem locais e funcionais
Não promover ações específicas de uma linha para controles globais incorretos; conservar tags, qualificação IA e detalhes como ações do lead selecionado.

Acceptance Criteria:
- `LeadTagPicker` continua sendo dropdown por lead, usando `PopoverMenu`, com estado aplicado, loading, erro e atualização da lista.
- `Qualificar com IA` continua aparecendo somente quando o lead não tem qualificação e `leads.update_status` permite, preservando estado `Qualificando…`, endpoint e feedback.
- `Ver detalhes` continua navegando para `/leads/{id}`.
- A seleção por checkbox, quando organização está habilitada, continua funcionando sem alterar o contrato da API.

Verification:
- Teste de interação em uma linha para etiqueta, qualificação e detalhes.
- Regressão de permissões e estado de loading/erro.

### R6 — Compatibilidade com a SPEC anterior
Preservar integralmente a simplificação já concluída no detalhe do lead.

Acceptance Criteria:
- Nenhuma alteração é feita em `apps/panel/app/leads/[id]/page.tsx` que reintroduza respostas estruturadas, justificativa interna ou Timeline.
- Navegação `Ver detalhes` continua abrindo o detalhe simplificado e sem alteração de API/banco.

Verification:
- Executar o teste de regressão associado a `specs/done/simplificar-visualizacao-leads.md`.
- Inspecionar diff para confirmar que a mudança fica restrita à lista/toolbar e seus estilos/componentes necessários.

## Invariants
- Não alterar endpoints, payloads, contratos backend, persistência, autorização ou isolamento por workspace.
- Manter filtros, debounce, visões salvas, tags, bulk actions, qualificação IA, seleção e links existentes.
- Uma única rolagem vertical operacional deve existir para a lista; dropdowns/modais podem rolar internamente quando seu conteúdo exceder o limite.
- Preservar a acessibilidade: botões com nome/estado, foco ao abrir menus/modais e `aria-live` dos feedbacks.
- Não reverter nem duplicar a simplificação do detalhe de lead já concluída.

## Edge Cases
- Filtros longos em viewport estreita devem caber em painel rolável sem ampliar o documento.
- Muitos filtros ativos devem exibir contador e permitir limpar todos.
- Nenhum lead, carregamento, erro SWR, aviso de acesso e feedback de qualificação devem permanecer visíveis sem quebrar a altura da lista.
- Seleção sem permissões de bulk deve ocultar a ação ou apresentar somente ações autorizadas.
- Modal do catálogo com muitas etiquetas deve rolar dentro do modal.
- Em mobile, a tabela pode continuar no modo de cards responsivos atual; a exigência de scroll interno não pode eliminar esse layout.
- Ao fechar filtros, catálogo ou bulk actions, o foco deve retornar ao botão acionador quando o componente existente suportar esse comportamento.

## Dependencies
- Componentes existentes `SavedViewsControl`, `LeadTagPicker`, `BulkLeadActions`, `TagCatalogSettings` e `PopoverMenu`.
- Estado e serialização de filtros em `apps/panel/lib/lead-filters.ts` e `apps/panel/lib/organization.ts`.
- Padrões de layout em `apps/panel/app/globals.css`, `apps/panel/app/leads/pipeline/page.tsx`, `apps/panel/app/conversas/page.tsx` e `apps/panel/app/agenda/page.tsx`.
- Permissões e endpoints atuais de organização, tags, bulk actions e qualificação.

## Affected Areas
- `apps/panel/app/leads/page.tsx`
- `apps/panel/app/globals.css`
- `apps/panel/components/bulk-lead-actions.tsx` (somente se necessário para trocar o host visual para menu/modal)
- `apps/panel/components/tag-catalog-settings.tsx` (somente integração/ajustes de acessibilidade ou apresentação)
- `apps/panel/components/lead-tag-picker.tsx` (somente se necessário para o novo host)
- `apps/panel/components/saved-views-control.tsx` (somente ajustes de integração, sem mudar contrato)
- `apps/panel/components/pipeline-filters.tsx` (referência de padrão; reutilizar ou extrair somente se não duplicar comportamento)
- testes de UI/regressão do painel, caso existentes ou necessários

## Non-goals
- Não redesenhar Pipeline, Conversas ou Agenda.
- Não mudar a tabela, colunas, ordenação ou modelo de dados dos leads.
- Não remover filtros, visões salvas, catálogo, ações em massa, tags ou qualificação.
- Não alterar a página de detalhe além de garantir que a SPEC anterior não regrida.
- Não implementar paginação, virtualização ou novos endpoints.

## Constraints
- Reusar exatamente os padrões existentes de toolbar, `Shell fitViewport`, `btn`, `PopoverMenu`/`details` e rolagem interna; não introduzir uma linguagem visual nova.
- Manter o monorepo npm workspaces e os comandos oficiais: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- Não deixar `overflow-y: auto` apenas no `body`/documento como solução.
- Não usar cards verticais permanentes para filtros, catálogo ou bulk actions.
- Respeitar permissões existentes em todos os pontos de renderização e execução.

## Required Tests
- Teste de regressão de fonte/DOM para confirmar toolbar, ausência de filtros permanentes e contenção de overflow.
- Teste de interação dos filtros e limpar filtros.
- Teste de visões salvas e catálogo de etiquetas, incluindo permissões.
- Teste de ações em massa: seleção, preview, aplicação, erro, cancelar e undo.
- Teste das ações por linha: tags, qualificação IA e detalhes.
- Regressão do detalhe simplificado de leads.
- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

## Definition of Done
- [ ] A página de leads usa `Shell fitViewport` e não permite rolagem vertical do documento em viewport desktop.
- [ ] Somente lista/tabela possui rolagem vertical principal; menus/modais têm rolagem interna limitada.
- [ ] Filtros detalhados estão atrás do botão superior `Filtros`, com contador e limpeza.
- [ ] `Visões`, `Catálogo` (quando permitido) e `Ações em lote` (quando aplicável) são ações no topo seguindo o padrão dos módulos de referência.
- [ ] Todas as ações atuais e permissões permanecem funcionais.
- [ ] A SPEC concluída de simplificação do detalhe não sofre regressão.
- [ ] Testes, lint, typecheck e build passam.

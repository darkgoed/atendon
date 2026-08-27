# SPEC: Loading por módulo do painel

## Objective
Garantir que cada módulo/rota do painel apresente estado de carregamento durante o carregamento inicial dos dados necessários à sua primeira renderização. O estado deve permanecer visível exatamente enquanto a carga estiver pendente: sem tempo mínimo artificial e sem timeout máximo imposto pela interface.

## Source
comments.md

Item da linha 5: “Fazer uma tela de LOADING para cada modulo que for renderizar, tela de loading nao tem tempo minimo e nem maximo, o loading é de acordo com tudo que carregar”.

## Current State
- O painel usa Next.js App Router, com uma `page.tsx` por rota em `apps/panel/app/**`.
- Não existem arquivos `loading.tsx` no App Router dentro de `apps/panel`.
- `apps/panel/components/page-state.tsx` já fornece `LoadingCards`, com `role="status"`, `aria-live="polite"`, `aria-busy="true"` e skeletons, além de `Empty`.
- `apps/panel/components/shell.tsx` já possui `SessionState`, usado enquanto o SWR de `/me` está pendente, e carrega sessão, capabilities, dashboard, versão e outros dados globais via SWR. O `Shell` só renderiza os filhos após a sessão existir (`if (isLoading && !session) return <SessionState />`).
- O padrão de dados é `useSWR` com `fetcher = (url) => api(url)` em várias páginas; chamadas diretas também usam `api`/`fetch`. `apps/panel/lib/api.ts` centraliza `fetch`, `credentials: "include"`, tratamento de JSON/204/erros e redirecionamentos 401/428.
- Já há estados parciais de loading/skeleton em algumas páginas: `LoadingCards` em dashboard, membros e auditoria; skeletons próprios em roles, api-keys e páginas administrativas; loading da agenda via `Suspense`. Esses estados não são uniformes e algumas páginas renderizam a casca antes de seus dados iniciais.

## Desired Behavior
Cada módulo que depende de dados iniciais mostra um loading consistente, acessível e reutilizável dentro da área do módulo (preservando o `Shell` e o layout da rota). A transição para conteúdo, vazio ou erro ocorre somente quando todas as requisições iniciais definidas para aquele módulo terminarem — com sucesso ou erro tratado — e nunca por `setTimeout`, delay, debounce visual ou timeout de UX. Rotas sem dados iniciais ainda devem continuar funcionais sem inventar uma espera; o loading global de sessão permanece responsabilidade do `Shell`.

## Requirements
### R1
Implementar um padrão compartilhado de estado de loading em `apps/panel/components/page-state.tsx`, estendendo `LoadingCards` ou adicionando uma variante parametrizável, sem criar um componente de loading independente por rota.

Acceptance Criteria:
- Existe uma API compartilhada capaz de renderizar loading de módulo com texto acessível e skeleton adequado ao conteúdo, reutilizável pelas rotas.
- Não há uma coleção de novos componentes duplicados de loading em `apps/panel/app/**`.
- O estado compartilhado mantém `role="status"`, `aria-live="polite"` e `aria-busy="true"` (ou equivalente acessível verificável).

Verification:
- Inspecionar `apps/panel/components/page-state.tsx` e imports/usos nas rotas.
- `npm run lint` e `npm run typecheck`.

### R2
Aplicar o estado compartilhado a todas as rotas de módulo com dados iniciais, mantendo o loading condicionado ao estado real do mecanismo de data-fetching (SWR ou estado equivalente baseado em `api`).

Acceptance Criteria:
- O loading aparece quando os dados iniciais ainda não estão disponíveis e desaparece na mesma renderização/efeito em que a carga termina, inclusive quando termina em erro tratado.
- O conteúdo não aparece como se estivesse carregado enquanto alguma requisição inicial obrigatória ainda estiver pendente.
- Nenhum timer artificial mínimo, timeout máximo, `setTimeout` ou atraso equivalente controla o fim do loading.
- Revalidações posteriores não bloqueiam a página inteira se já houver dados iniciais exibíveis, salvo se o módulo explicitamente perder seus dados.

Verification:
- Testes de cada módulo simulando pending, success, empty e error.
- Revisão de código confirmando que as condições derivam de `data`, `error`, `isLoading`/estado de requisições e não de relógio.
- `npm run lint`, `npm run typecheck` e `npm run build`.

### R3
Cobrir a lista completa de rotas do painel abaixo. Rotas parametrizadas representam qualquer valor do parâmetro.

Acceptance Criteria:
- Rotas com carregamento inicial de dados recebem loading de módulo: `/`, `/alertas`, `/agente`, `/configuracoes`, `/conversas`, `/leads`, `/leads/[id]`, `/leads/pipeline`, `/perfil`, `/pos-venda`, `/pos-venda/cobranca`, `/pos-venda/configurar`, `/root/audit`, `/root/workspaces`, `/workspace/audit`, `/workspace/members` e `/workspace/roles`.
- CONFLITO RESOLVIDO com `specs/active/followups-modulo-e-remocoes.md`: as rotas `/agente/melhorias` e `/workspace/api-keys` serão REMOVIDAS e portanto NÃO recebem loading. A rota `/agente/figurinhas` será MOVIDA para o novo módulo `/follow-ups`; o loading deve ser aplicado ao destino final `/follow-ups`, não à rota antiga. Se, na ordem de execução, `/follow-ups` ainda não existir, esta SPEC não cria a rota — apenas garante que quem a criar use o componente compartilhado.
- Rotas que usam carregamento inicial por `api`/estado próprio também são cobertas: `/agenda`, `/conexao` e `/humanizacao`.
- `/tripz-ai` e `/uso` são avaliadas como módulos renderizados dentro de `Shell`; se não houver dados iniciais bloqueantes, não se adiciona espera artificial, mas qualquer fetch inicial existente deve usar o padrão compartilhado.
- As rotas sem módulo autenticado/dados iniciais — `/login`, `/alterar-senha`, `/offline`, `/403`, `/convite`, `/invitations/[token]`, `/meet/[roomId]` e `/reuniao/[code]` — não recebem uma espera artificial; caso tenham carregamento real de dados em sua implementação final, devem exibir o mesmo componente durante essa carga.

Verification:
- Conferir cada arquivo real: `apps/panel/app/**/page.tsx` e comparar a matriz de rotas acima com a listagem do filesystem; o total esperado é 33 `page.tsx`.
- Confirmar que não existe `apps/panel/**/loading.tsx` não referenciado ou solução paralela que deixe alguma rota de dados sem estado.

### R4
Preservar a responsabilidade do `Shell` pelo carregamento da sessão e por redirects/autorização, sem duplicar `SessionState` nas páginas.

Acceptance Criteria:
- Enquanto `/me` estiver pendente, o usuário continua vendo `SessionState` de `apps/panel/components/shell.tsx`.
- O loading de módulo aparece somente depois que o `Shell` pode renderizar o módulo, sem quebrar redirects 401, 403 e 428.
- Falhas de sessão continuam exibindo estado de erro/retry existente, e falhas do módulo continuam sendo tratadas pelo estado de erro próprio da página.

Verification:
- Teste manual ou automatizado de sessão pendente, sessão válida e erro 401/403/428.
- Revisar `apps/panel/components/shell.tsx` e `apps/panel/lib/api.ts`.

### R5
Manter acessibilidade e a semântica visual do painel durante a espera.

Acceptance Criteria:
- O loading tem nome acessível em português, não anuncia cada skeleton como conteúdo real e não cria foco inesperado.
- Ao terminar a carga, o estado de loading deixa de ser exposto como ativo (`aria-busy`/status).
- O loading funciona nos modos `Shell` normal, `flush` e `fitViewport` sem causar scroll horizontal ou alterar a navegação.

Verification:
- Teste com árvore de acessibilidade/leitor de tela e viewport mobile/desktop.
- Revisar classes existentes (`grid4`, `card`, `skeleton`, `shell-loading`) antes de criar CSS novo.

## Invariants
- `api` continua sendo o ponto central para chamadas ao backend e mantém `credentials: "include"` e o tratamento de autenticação existente.
- Loading não é usado como fallback de erro nem substitui estados vazios (`Empty`) ou mensagens de erro/retry.
- A autorização/capabilities do `Shell` não é enfraquecida; conteúdo de uma rota inacessível não é revelado durante loading.
- Não há timer mínimo nem timeout máximo de apresentação.

## Edge Cases
- Respostas simultâneas: aguardar todas as dependências obrigatórias do primeiro conteúdo, sem esconder loading quando apenas uma ainda está pendente.
- Resposta 204/`undefined`, listas vazias e dados parcialmente opcionais devem sair de loading e ir para vazio/conteúdo apropriado.
- Erro de uma requisição obrigatória deve sair de loading e mostrar erro/retry, sem spinner infinito.
- SWR pode ter dados anteriores durante revalidação: preservar conteúdo existente, salvo ausência do dado inicial.
- Mudança de workspace/rota deve descartar ou invalidar o estado anterior para não mostrar dados de outro workspace.
- Rotas públicas, salas de reunião e telas de autenticação não devem ganhar delay só por consistência visual.

## Dependencies
- Next.js App Router e limites de `Shell` em `apps/panel/components/shell.tsx`.
- SWR usado pelas páginas e por `apps/panel/lib/capabilities.tsx`.
- Cliente `api` em `apps/panel/lib/api.ts`.
- Classes/styles de skeleton do painel.

## Affected Areas
- `apps/panel/components/page-state.tsx`
- `apps/panel/components/shell.tsx` (integração/compatibilidade, se necessária)
- Todas as 33 rotas `apps/panel/app/**/page.tsx` listadas em R3, especialmente as que usam `useSWR`, `api` ou `Suspense`.
- Testes do painel e, se necessário, estilos existentes do painel; não criar `loading.tsx` por rota sem justificar compatibilidade com o padrão compartilhado.

## Non-goals
- Não alterar endpoints, contratos backend, cache/revalidação do SWR ou regras de autorização.
- Não redesenhar módulos, trocar o layout do painel ou criar skeletons pixel-perfect para cada tela.
- Não adicionar loading artificial a rotas sem carregamento inicial real.
- Não implementar as demais linhas de `comments.md`.

## Constraints
- Reusar/estender `apps/panel/components/page-state.tsx`; evitar N componentes novos.
- O fim do loading deve ser dirigido exclusivamente pela conclusão real do carregamento.
- Seguir o padrão TypeScript/React/Next existente e manter arquivos abaixo de 500 linhas.
- A contagem "33 rotas" reflete o estado do repo ANTES das remoções/movimentações da SPEC `followups-modulo-e-remocoes.md`. Reconferir o filesystem no momento da implementação em vez de assumir o número.

## Required Tests
- Testes unitários/componentes para estado pending, success, empty e error do componente compartilhado.
- Testes ou checks de integração para as rotas com múltiplas requisições iniciais (membros, configurações, conversas, leads, pipeline, pós-venda e root/workspaces).
- Verificação de acessibilidade do status e ausência de foco/scroll indevido.
- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

## Definition of Done
- [ ] A matriz de 33 rotas `page.tsx` foi conferida contra o filesystem e está coberta conforme R3.
- [ ] O componente compartilhado de `page-state.tsx` é usado/estendido sem duplicação por rota.
- [ ] Cada rota com dados iniciais exibe loading durante toda a pendência real e transiciona para conteúdo/vazio/erro ao terminar.
- [ ] Não existem timers mínimos/máximos ou timeouts de UX controlando o loading.
- [ ] `Shell` continua controlando sessão, autorização e redirects.
- [ ] Casos de erro, 204, vazio, revalidação SWR e troca de workspace foram verificados.
- [ ] `npm test` foi executado com sucesso.
- [ ] `npm run lint` foi executado com sucesso.
- [ ] `npm run typecheck` foi executado com sucesso.
- [ ] `npm run build` foi executado com sucesso.

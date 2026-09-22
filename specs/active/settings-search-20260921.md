# SPEC — Padronização de Configurações e Busca Global (2026-09-21)

## Objective

Consolidar a experiência de **Configurações** do painel AtendON num padrão único (Geral → categorias semânticas, visual uniforme, sem emojis/descrições redundantes) e consolidar **UMA experiência principal de busca global** consumindo o **endpoint existente `GET /search`** do monorepo (`apps/backend/src/modules/search/`), absorvendo as entradas redundantes de busca do painel, **sem remover função sem equivalente**, sem criar endpoint duplicado e com multi-tenant/permissões invariantes. Documento de especificação apenas — **nenhuma implementação nesta fase**.

## Source

- `comments.md` L202-358 — itens 3, 4 (padronização de configs) e 5 (busca global). Requisitos já destilados e repassados pela delegação; **não relidos nesta sessão** (regra anti-loop do ciclo anterior).
- **Backend de busca — localizado e lido nesta revisão (código real do monorepo, não externo):** `apps/backend/src/modules/search/routes.ts` (rota `GET /search`, `requireWorkspace`, comentário explícito "itens sem permissão são OMITIDOS/esvaziados na resposta, nunca 403"), `apps/backend/src/modules/search/service.ts` (351 linhas, lido completo), `apps/backend/src/app.ts` L33 (`registerSearchRoutes`), `apps/backend/tests/search.integration.test.ts` (W4B).
- **Frontend:** `apps/panel/lib/api.ts` (cliente `api<T>`, base `NEXT_PUBLIC_API_BASE_URL` default `/backend`, cookie credentials, 401→`/login`, 428→`/alterar-senha`); `apps/panel/lib/panel-manifest.ts` (completo), `apps/panel/components/shell.tsx` L120–459, `apps/panel/app/configuracoes/page.tsx` (completo, 1542 linhas), `apps/panel/app/agente/page.tsx` (completo, 318 linhas), `apps/panel/components/context-panel.tsx` (completo, 36 linhas), `apps/panel/app/conversas/` (grep + leituras anteriores).
- **Inventário programático nesta revisão:** 12 resource keys do hub + 9 destinos (tabela em R4); grep `"/search"` em `apps/panel` = **zero consumidores** (experiência global nasce como primeira client do endpoint); scan de emojis em `/agente`, `/conexao`, `/humanizacao`, `/follow-ups`, `/uso`, `/alertas`, `/workspace/{members,roles,audit}` = **limpo**.
- Jev: gates **BLOCKED** — `/var/www/scripts/jev-gate.py` inexistente (comprovado por agente dedicado). Nenhum gate falsificado.

## CurrentState

**Rotas e fonte única de gating** — `apps/panel/lib/panel-manifest.ts`:
- `administrationPaths` L50-58: `/configuracoes`, `/conexao`, `/workspace/members`, `/workspace/roles`, `/workspace/audit`, `/agente`, `/humanizacao` — todas dão match no item `/configuracoes` (L88, capability `workspace_admin_v1`).
- Manifest único de rota/menu/paleta/permissão/capability (L63-98). Grupos (L100): Atendimento, Pós-venda, Copiloto, Administração, ROOT. Gating: `canAccessManifestItem`/`canExposeManifestItem` (L106-121). `/alertas` rootOnly (L83); `/follow-ups` rootWorkspaceOnly + feature `AI_FOLLOWUP` (L84); `/uso` deliberadamente fora de capability comercial (L85-87); `/root/*` rootOnly (L89-94).

**Hub de configurações** — `apps/panel/app/configuracoes/page.tsx` (1542 linhas, 1 arquivo):
- Navegação interna `settings-rail` (L259-293) com dois grupos: **"Áreas de configuração"** = `settingsDestinations` L101-111 (9 destinos com ícone + label + description) e **"Configurações operacionais"** (abas `visibleTabs` L162-187, 12 resources com `resourceLabels` L64-77).
- Deep-link `?resource=` L193-201 cobre **apenas 6 de 12** resources (`google-meet`, `atendon-meet`, `attendants`, `conversation-queues`, `workspace`, `armazenamento`); `categorias` é default (L117) e `parceiros`, `unidades`, `signature`, `panel-notifications`, `agenda-notifications` **não são deep-linkáveis hoje** — paridade exigida na implementação.
- Gating por permissão/capability em L148-161 (destinos filtrados por `rootWorkspaceOnly`/`permission`) e L162-187 (abas). `attendants` usa `attendantPoolAccess` (escopo workspace/units, L140-146).
- **Inconsistência visual comprovada** — 4+ containers distintos: (a) form `max-w-2xl` com ícone em círculo + `h2` + `sub`; (b) tabela de catálogo + Editor lateral; (c) painéis Meet em 2 colunas com `<dl>` (L1186-1489); (d) grid de checkbox-cards (L726-744) e tabela de equipe (L1077-1179). **Não são layouts a apagar**: forms/tabelas/grids são conteúdos legítimos dentro de uma estrutura comum — a uniformização é do *chassi* (card, cabeçalho, tipografia, espaçamento, ícones), não do tipo de conteúdo.

**Ctrl+K**: `apps/panel/components/command-palette.tsx` — apenas navegação client-side sobre `paletteItems` (shell.tsx L225-228: `visibleGroups.flatMap`, itens já gated). **Não busca entidades.**

**Entradas de busca atuais (3 entradas, 1 função de navegação):**
- Ctrl+K → command-palette (só navegação client-side);
- Botão "Buscar…" do Shell (`shell.tsx` L364-368, `aria-label="Buscar página (Ctrl+K)"`) → mesma paleta;
- ContextPanel do Inbox (`context-panel.tsx`, 36 linhas) é **apenas um botão** que chama `onOpenSearch` → `setPaletteOpen` (shell L338) — não possui busca/filtros internos.

**Busca do Inbox** (`app/conversas/page.tsx`): busca textual server-side real — `q` em `/conversations` (L585) alimentada por `debouncedQuery`, campo "Buscar conversa" (L1450-1453); filtros via `ListFiltersBar` padrão único igual a `/contatos` (comentário L575-576): `filter` (escopo mine/unassigned, L574-580), `queue_id` (fila/canal), `session_id` (conexão/canal), `unread=true`, `pending_action=true` (L585); deep-link `?filtro=&id=` (L526-529).

**Backend de busca (existente, real):** `GET /search` em `apps/backend/src/modules/search/` — contrato completo na seção **API** abaixo. O painel ainda não o consome (zero ocorrências de `"/search"` em `apps/panel`).

**IA — `/agente` (`app/agente/page.tsx`, real, 318 linhas):**
- Contrato de API já consumido: `GET /agent?session_id=<conn>` → `{ agent: { system_prompt, ai_model, openrouter_provider, model_params{temperature,max_tokens,reasoning_effort}, is_active, has_openrouter_api_key, media_fallback_audio|image|document, enabled_tools }, available_tools, scope: "shared"|"connection" }`; `PUT /agent` (com `sessionId: null` = compartilhado); `PATCH /agent/status`; `DELETE /agent/override/:id`.
- **Sub-seções reais (inventário):** Instruções do agente (textarea `system_prompt` + contador de caracteres); Ferramentas habilitadas (checkboxes sobre `available_tools`; salvar exige ≥1 ferramenta habilitada); Respostas para mídia (áudio/imagem/documento fallback); OpenRouter (provider, modelo, chave tipo password — criptografada no servidor, nunca retornada ao navegador; checkbox "remover chave configurada"); Parâmetros (reasoning low/med/high, temperatura 0–2, max tokens 64–8192).
- **Override por número:** selector "Prompt de" (só com >1 conexão); `""` = compartilhado; salvar com número selecionado cria override (`scope:"connection"`); remover override volta ao compartilhado; toggle de status exige override resolvido antes de alterar status de um número. **Nenhum estado desses é sincronizado à URL hoje** (selector apenas em memória).
- Gating: `usePermission("agent.manage")` → modo somente leitura (`fieldset disabled` + aviso).
- **"Funções"/"Base de conhecimento" como sub-módulos de IA NÃO existem** — não inventar. "Funções" no hub hoje é o rótulo de `/workspace/roles` (papéis), domínio distinto de ferramentas de IA.

## API — Contrato `GET /search` (backend EXISTENTE — reutilizar, não duplicar)

Registrado em `apps/backend/src/app.ts` L33; rota `apps/backend/src/modules/search/routes.ts`; lógica `apps/backend/src/modules/search/service.ts`.

**Requisição** (cookie de sessão; `requireWorkspace` — qualquer membro autenticado do workspace):

```
GET /search?q=<texto>&limit=<int>&cursor=<opaco>
```

- `q`: string, trim, **mín. 2, máx. 100** (< 2 → 400); `limit`: int **1..25, default 8**; `cursor`: máx. 2000 chars, opaco. Schema zod `.strict()` — parâmetros extras são rejeitados.
- Deliberadamente **sem `requirePermission`**: seções sem permissão são omitidas/esvaziadas, **nunca 403**.

**Resposta 200:**

```json
{
  "q": "…",
  "page": { "limit": 8, "has_more": false, "next_cursor": "base64url|null" },
  "contacts":      { "items": [ { "id", "name", "phone", "status", "created_at" } ],  "page": { "has_more", "next_cursor" } },
  "tasks":         { "items": [ { "id", "title", "description", "status", "priority", "created_at" } ], "page": { "has_more", "next_cursor" } },
  "conversations": { "items": [ { "id", "contact_name", "contact_phone", "status", "created_at" } ], "page": { "has_more", "next_cursor" } }
}
```

**Semântica por seção (server-side, invariante):**

| Seção | Entidade | Permissão | Sem permissão |
|---|---|---|---|
| `contacts` | `scheduling_leads` (nome ILIKE + telefone por dígitos E164) | `leads.follow_up.read` | **chave AUSENTE da resposta** (omitida, não vazia) |
| `tasks` | `tasks` (título/descrição ILIKE) | `tasks.read` (com `tasks.assign` vê o tenant inteiro; senão só criadas por / responsável) | seção presente, **vazia** |
| `conversations` | `conversations` (contact_name/phone ILIKE + telefone por dígitos) | `conversations.read` | seção presente, **vazia** |

- **Escopo:** `tenant_id` SEMPRE + case-scope por seção (`resolveCaseScope`): mine/workspace; em `mine`, conversa atribuída ao membro **OU** lead do membro (espelha a inbox).
- **Matching:** ILIKE `%q%` com escape (`\`,`%`,`_`) — sem trigram (padrão da casa); telefone: dígitos da consulta ≥ 8, normalização E164 (Brasil assume 55), casa por substring em `contacts.phone` e `conversations.contact_phone` (armazenados sem `+`).
- **Paginação:** keyset `(created_at DESC, id DESC)` por seção; **cursor composto** único base64url `{v:1, sections:{contacts,tasks,conversations}}` (pontos `{created_at, id}` com microssegundos preservados); `has_more` global e por seção; itens por seção = `limit`. Cursor é opaco para o cliente — repassar como veio.
- **Testes existentes:** `apps/backend/tests/search.integration.test.ts` (W4B) cobre validação de `q`, tenancy A/B, match por nome e telefone, tarefa por título, seções omitidas/vazias por permissão e cursor keyset. Devem permanecer verdes; a onda FE é **consumidora**, não autora de endpoint.
- **"Páginas" não vem do backend:** navegação segue client-side do `command-palette` sobre `paletteItems` (manifest). Recursos de configuração não são seção do `/search` — aparecem como categoria de páginas somente.

**Consumo no painel (contrato client-side a implementar):**
- Único consumidor novo: busca global (evolução do `command-palette`) via `lib/api` `api("/search?…")` — `credentials: include`, redirecionamentos 401/428 já tratados pelo cliente `api`.
- Requisições: debounce; disparar só com `q ≥ 2`; `limit` default 8; "carregar mais" repassa `page.next_cursor` intacto; **cancelar a requisição anterior** (AbortController) a cada nova busca ou troca de workspace.
- **Isolamento de tenant:** chave de cache/SWR inclui o identificador do workspace ativo; ao trocar workspace, cancelar requisições em voo, **limpar cache e estado de resultados** — nunca renderizar resposta do tenant anterior. Cursor de um tenant é inválido no outro: descartá-lo na troca.
- Renderização: iterar apenas seções **presentes** na resposta (`contacts` pode não existir); seção vazia pode ser ocultada; ausência de seção não deve ser usada para inferir permissão em ações.
- Seleção de resultado (deep-links, sem rotas novas): conversa → `/conversas?id=<id>` (`?filtro=` e `?id=` existentes intactos); contato → `/contatos`; tarefa → destino de tarefas existente; página → rota da manifest. Se o modal global suportar filtro de contexto de conversas, é opcional e apenas o compatível com o escopo server-side (o backend não filtra por fila/canal/não-lidas — esses filtros **ficam locais no Inbox**).
- Gating FE: entrada de busca visível via manifest (`canExposeManifestItem`); permissões por seção já garantidas **server-side** — FE apenas omite seções ausentes/vazias, não replica RBAC.

## Requirements

- **R1 — Padrão único Geral/Categorias**: toda a navegação de Configurações (hub + destinos hoje espalhados) num único padrão estrutural: entrada **Geral** primeiro, seguida de categorias semânticas. Labels/nomes exatos não são obrigatórios (worker decide), a **estrutura** é obrigatória. Eliminar a dualidade atual "Áreas de configuração" vs "Configurações operacionais" (page.tsx L259-293) — um só idioma de navegação.
- **R2 — Sem emojis, sem descrições redundantes**: remover emojis de todas as superfícies de configuração (hub e destinos verificados **limpos** — manter estado); remover `description` dos destinos (`settingsDestinations` L101-111) da navegação; descrições explicativas só onde ensinam comportamento (ex.: efeito do horário de atendimento), nunca como legenda repetida do título.
- R3 — Uniformização visual: um padrão único de *chassi* de configuração (mesmo card, mesma altura de cabeçalho, ícone único em família/tamanho, tipografia h1/h2/label/sub, espaçamento, estados hover/active/disabled/skeleton). Forms, tabelas e grids internos **permanecem** — são conteúdos válidos dentro da estrutura comum. Reutilizar `components/ui` e `settings-panels.module.css`; zero dependência nova.
- **R4 — Agrupamento semântico obrigatório — inventário completo (12 resources + 9 destinos, cada chave exatamente uma vez):**

  | Grupo | Chaves (origem) | Gating atual |
  |---|---|---|
  | **Geral** (primeiro) | `workspace` "Geral" (tab), `signature` "Assinatura do atendente" (tab), `armazenamento` (tab), `/uso` (destino) | `workspace.update` / `signature.read` / `storage.manage` / `rootWorkspaceOnly` (fora de capability comercial) |
  | **Equipe e acesso** | `/workspace/members` (destino), `attendants` "Equipe de atendimento" (tab), `/workspace/roles` "Funções" (destino), `/workspace/audit` "Auditoria" (destino) | `members.read` / `attendantPoolAccess` / `rootWorkspaceOnly` / `audit.read` |
  | **CRM/catálogos** (feature `leads_v1`) | `categorias` (tab, default), `parceiros` (tab), `unidades` (tab) | `categories.*` / `partners.*` / `units.*` |
  | **Atendimento** | `conversation-queues` "Filas de atendimento" (tab) | `conversations.queues.manage` |
  | **Agenda e integrações** (feature `appointments_v1`) | `atendon-meet` (tab), `google-meet` (tab) | `appointments_v1` + `units.read` |
  | **Canais** | `/conexao` (destino) | `connection.read` |
  | **IA** | `/agente` (destino), `/humanizacao` (destino), `/follow-ups` (destino) | `rootWorkspaceOnly` (+ `AI_FOLLOWUP` em follow-ups) |
  | **Notificações** | `panel-notifications` (tab), `agenda-notifications` (tab) | sessão ativa / `appointments_v1` + `scheduling_notifications.*` |
  | **ROOT** | `/alertas` (destino) | `rootOnly` |

  Cada destino aparece **uma única vez**; nenhuma rota órfã: `/alertas`, `/conexao`, `/workspace/*`, `/agente`, `/humanizacao`, `/follow-ups`, `/uso` continuam alcançáveis dentro do agrupamento. Em `/agente`, agrupar apenas as sub-seções reais (Instruções, Ferramentas habilitadas, Respostas para mídia, OpenRouter, Parâmetros) preservando o comportamento de override por número; "Base de conhecimento" não existe e não é criada.
- **R5 — Uma experiência principal de busca global** sobre `GET /search` existente: **contatos, tarefas, conversas e páginas**. ("Empresas" **não é tipo de busca**: não existe entidade company/empresa no backend nem no painel — grep negativo; "empresa" aparece só como redação para tenant; dados de empresa que eventualmente morem em campos personalizados de contato **não são indexados** pelo `/search` — não inventar tipo.) Absorve: (a) paleta Ctrl+K (navegação vira categoria "Páginas" da busca), (b) botão "Buscar…" do Shell (mesmo entry point), (c) **busca textual** do Inbox — campo "Buscar conversa" (L1450-1453) e `q` server-side (`/conversations`, L585). **Filtros do Inbox permanecem locais** (`ListFiltersBar`: status/escopo, canal/conexão, atendente, período, IA, não lidas — L584-585) — o modal global não é obrigado a reproduzi-los; resultados de conversas da global já chegam com escopo correto do server (tenant + case-scope + permissão). A busca textual do Inbox só é removida **após** a global cobrir `q` de conversas com os deep-links de seleção funcionando; `GET /conversations?q=` (endpoint pré-existente) **não é apagado**.
- R6 — Permissões/multi-tenant invariantes (ver Invariants).

## Acceptance

1. Navegação de Configurações num único padrão Geral → categorias, sem emojis, sem descrições na navegação; as 21 chaves da tabela R4 todas presentes, cada uma uma vez.
2. Todos os destinos atuais (`settingsDestinations` + `administrationPaths`) alcançáveis no novo agrupamento — zero rota órfã, zero duplicação.
3. Um só padrão visual de *chassi* em todas as seções do hub (layouts de conteúdo internos preservados).
4. Uma entrada de busca (Ctrl+K/botão) que busca páginas **e** entidades via `GET /search` (contatos, tarefas, conversas) — sem endpoint novo no backend, sem rota `/busca`.
5. Busca textual do Inbox absorvida: mesma `q` de conversas retorna via global com deep-link de seleção; `ListFiltersBar` do Inbox intacto e local; endpoint `/conversations?q=` continua existindo.
6. Matriz de papéis (ROOT, root-workspace, admin, atendente, capabilities off; leitor sem `leads.follow_up.read`) mantém gating idêntico: seção `contacts` ausente na resposta → categoria não renderizada; nenhuma quebra.
7. Trocar de workspace durante uma busca cancela requisições em voo e limpa resultados/cache — nenhum dado do tenant anterior visível.

## Verification

grep de emojis em settings* e páginas de destino (= 0, estado atual); script de reachability das rotas de `administrationPaths` + 12 resources por papel; Ctrl+K e botão Buscar abrem a MESMA busca global; deep-links `?resource=` (agora para as 12 chaves), `?filtro=`/`?id=` continuam resolvendo; contra o `/search` real: `q` < 2 não dispara requisição; seção `contacts` ausente p/ leitor sem `leads.follow_up.read`; cursor repassado retorna próxima página sem repetição; troca de tenant limpa estado. Comparação antes/depois das funções (checklist por seção).

## Invariants

- `panel-manifest.ts` permanece fonte única de rota/menu/paleta/permissão/capability; gating `canExposeManifestItem`/`canAccessWithSession` intacto.
- **Backend `/search` não é modificado nesta onda** (nenhum segundo endpoint, nenhuma rota `/busca`); permissões por seção são do lado do servidor — FE apenas omite.
- Multi-tenant: resultados e navegação sempre no escopo do workspace ativo; ROOT conforme `isRoot`/`rootWorkspaceAccess` (shell L182-184, L312); **chaves de cache incluem tenant; troca de tenant zera resultados, cursor e cache**.
- `/uso` nunca bloqueada por capability comercial (empresa suspensa precisa acessar — manifest L85-87).
- Nenhuma função removida sem equivalente; nenhuma rota órfã; nenhum módulo inventado.
- Deep-links existentes (`?resource=`, `?filtro=`, `?id=`) continuam resolvendo; seleção de conversa via global reusa `?id=`.
- Override de IA por número (`shared`/`connection`, `PUT /agent` com `sessionId`, `DELETE /agent/override`) preservado no reagrupamento — nenhum comportamento ou número perdido.

## EdgeCases

Usuário ROOT sem acesso operacional (só grupo ROOT); capabilities desligadas (workspace_admin_v1, leads_v1, appointments_v1) escondem seções sem quebrar navegação; workspace suspenso → `/uso` alcançável; busca sem resultado; busca por entidade sem permissão → seção ausente/vazia (nunca erro, nunca 403 — comportamento do endpoint); `q` com < 2 chars ou só espaços → não dispara requisição; cursor expirado/inválido → 400 do backend, modal exibe estado vazio sem travar; deep-link de resource sem permissão cai no primeiro tab visível (comportamento atual L189-191 mantido); resposta lenta → estado de loading + cancelamento da anterior; mobile (rail + busca acessíveis).

## Dependencies

- **Backend: nenhuma pendência** — `GET /search` existe, registrado (app.ts L33), testado (`tests/search.integration.test.ts`). Contrato fechado na seção API.
- Cliente HTTP: `lib/api.ts` já fornece base/credenciais/redirecionamentos; busca global adiciona apenas AbortController + debounce (client-side).
- `command-palette.tsx` será a base da experiência única (evoluir, não duplicar); `context-panel.tsx` mantém o botão apontando para a mesma busca (nada a mudar lá).

## AffectedAreas

`apps/panel/app/configuracoes/page.tsx` (split em painéis por categoria, na onda própria), `apps/panel/components/shell.tsx` (entradas de busca), `apps/panel/components/command-palette.tsx` (virar busca global consumindo `/search`), `apps/panel/app/conversas/page.tsx` (remoção posterior do campo textual `q`; `ListFiltersBar` permanece), `apps/panel/lib/panel-manifest.ts` (novos grupos/entradas), `apps/panel/components/settings-panels.module.css`. **Backend: nenhuma alteração.** Nenhuma rota nova (sem `/busca`); `context-panel.tsx` sem mudança (botão já aponta à busca única).

**Ownership**: Shell + navegação + manifest + busca = **um único worker frontend** numa onda (sem split entre nav e busca). Split do hub `configuracoes/page.tsx` (1542 linhas) em painéis por categoria **não é autorizado automaticamente por esta SPEC** — decisão da onda de configurações, um worker por vez; CSS/primitivos compartilhados em onda separada e sequencial.

## NonGoals

Implementar código agora; criar segundo endpoint de busca ou tratar o backend como externo desconhecido (é monorepo `apps/backend/src`); criar rota `/busca`; adicionar tipo "empresas" à busca (entidade inexistente); indexar campos personalizados no `/search`; remover `GET /conversations?q=`; migrar filtros do Inbox para o modal global; criar módulos/seções inexistentes ("Base de conhecimento"); mudar permissões, multi-tenant, DB, secrets, infra; mover rotas existentes.

## Tests

Backend (regressão, já existentes e devem permanecer verdes): `tests/search.integration.test.ts` — validação de `q`, tenancy A/B, match nome/telefone, tarefa por título, seções omitidas/vazias por permissão, cursor keyset.

Onda de implementação (frontend): matriz de papel × seção (ROOT/admin/atendente/leitor sem `leads.follow_up.read`) valida gating e renderização de seções; reachability de todas as rotas de `settingsDestinations` + 12 `visibleTabs`; deep-link `?resource=` para cada uma das 12 chaves; grep de emojis em settings = 0; busca global: `q` < 2 sem request, cancelamento da requisição anterior, load-more via `next_cursor`, `contacts` ausente → categoria oculta, seleção de conversa navega a `/conversas?id=…`; troca de tenant: cache/SWR por workspace, resultados anteriores não renderizados; busca do Inbox redireciona à global com `q` preservado (e só depois é removida); smoke de Ctrl+K sem sessão e sem resultados; IA: override por número continua funcionando após reagrupamento (salvar prompt por conexão, remover override, toggle de status).

## Lacunas — resolvidas nesta revisão

1. ~~Backend de busca~~ — **RESOLVIDO**: `apps/backend/src/modules/search/` (`routes.ts` + `service.ts`, 351 linhas), registrado em `app.ts` L33; contrato completo na seção API; testes em `tests/search.integration.test.ts`. Zero consumidores no painel — a global nasce como primeira client.
2. ~~Sub-seções de IA~~ — **RESOLVIDO**: reais em `/agente`: Instruções, Ferramentas habilitadas, Respostas para mídia, OpenRouter, Parâmetros; override por número com `scope shared|connection`. "Funções"/"Base de conhecimento" como módulos IA não existem.
3. ~~`context-panel.tsx` interno~~ — **RESOLVIDO**: 36 linhas; apenas botão "Buscar…" → `onOpenSearch`; sem busca/filtros internos.
4. ~~Emojis fora do hub~~ — **RESOLVIDO**: scan nas 9 páginas de destino = limpo (hub também).
5. ~~"Empresas" como entidade de busca~~ — **RESOLVIDO**: não existe entidade company/empresa (grep negativo backend+painel); removida do escopo de busca; não inventar tipo.

**Lacuna remanescente (não bloqueante):** deep-link `?resource=` hoje cobre 6/12 resources — paridade das 12 é requisito de implementação (Acceptance 1/2, Verification), não exige backend novo.

## Constraints

- Frontend ownership futuro: **worker único** para Shell + nav + manifest + search. Nenhum código nesta SPEC.
- Escopo `apps/atendon/**`; sem secrets/DB/git/infra.
- Gates Jev **BLOCKED** (intake, decisões, scope-drift, completeness): `/var/www/scripts/jev-gate.py` inexistente (comprovado por agente dedicado) — registrado sem simulação em `navigation-investigation.md`.

## DoD

Implementação: padrão único em todos os painéis; busca global única consumindo o `GET /search` existente com paridade de `q` e deep-links; busca textual do Inbox absorvida e só então removida (filtros locais preservados); zero rota órfã; matriz de papéis validada; lacunas acima resolvidas e verificadas.

Fase SPEC: este documento revisado (backend localizado e contratado, inventário completo de 21 chaves, IA inventariada), state file de navegação atualizado com resoluções. Implementação é onda futura de worker único.

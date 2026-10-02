# Entrega — evolução funcional a partir do levantamento (2026-10-01)

Baseline: `docs/levantamento-funcionalidades-parciais-2026-10-01.md`. Cada evidência foi reconferida no código antes da implementação (rotas, shapes de resposta nos testes de integração do backend, contratos de permissão). Escopo restrito a `apps/atendon`; nenhuma migration criada ou movida; nenhum backend novo exceto um campo em payload existente (`/me` → `totpEnabled`, fase anterior desta entrega conjunta).

## 1. Funcionalidades concluídas

| # | Funcionalidade | Como ficou utilizável |
|---|---|---|
| 1 | **Merge de contatos** (B5 v7) | Em /contatos, com exatamente 2 contatos selecionados aparece "Mesclar 2 selecionados" (gated por `leads.delete` + modo organização). Dialog em 3 passos: escolha do contato principal → preflight (`POST /organization/leads/merge/preflight`) mostra o que será movido + aviso de etapa divergente → confirmação (com checkbox explícito quando os telefones normalizados diferem) → `POST /organization/leads/merge`. Sucesso lista o que foi movido; par é fixado na abertura (poll de 15s não muda o alvo no meio do fluxo). |
| 2 | **Nova conversa** (B7/B8 v7) | Botão "Nova conversa" no cabeçalho da lista de /conversas (gated por `conversations.reply`). Dialog: busca de contatos (`/scheduling/leads?busca=`), seleção de conexão WhatsApp conectada (`/connections` filtrado), primeira mensagem (≤4000) → `POST /conversations/initiate` com `idempotency-key` (UUID). Ao iniciar: conversa selecionada no inbox + fila/contadores atualizados. Estados: busca curta, sem contatos, sem conexão conectada, erro do backend (rascunho preservado). |
| 3 | **Gestão de equipes** (B6 v7) | Card "Equipes" na página Membros: listar/criar/renomear/excluir (`GET/POST/PATCH/DELETE /organization/teams`, gestão gated por `members.update`). Exclusão com membros: 409 `TEAM_HAS_MEMBERS` do backend dispara a 2ª confirmação com `detach_members: true`. Nova coluna **Equipe** na tabela de membros (select → `PATCH /workspaces/current/members/:id` com `team_id`). Novo filtro **Equipe** no inbox (`GET /conversations?team_id=`, já suportado pelo backend). |
| 4 | **Reports** (B1 v7) | Nova página `/relatorios` (manifest: grupo Administração, `dashboard.read`): 4 abas — Volume (gráfico `LineAreaChart` + tabela), Produtividade, Fluxo de status (labels canônicos, média de fechamento formatada, zeros ocultos) e Qualidade (fila agora, 1ª resposta, ociosos, gargalos). Período de 30 dias no fuso do workspace, editável. Export CSV por aba via `/reports/export/csv?type=…` existente. |
| 5 | **Fluxos: analytics/execuções** (C1-d v7) | Botão "Desempenho" no editor abre drawer com `GET /qualification/flows/:id/analytics` (auto-refresh 30s conforme spec) + histórico keyset de `GET …/executions` com status/kind/detalhe/data e "Carregar mais". |
| 6 | **Templates de fluxos** (C1-f v7) | Na lista de fluxos: "Novo de template" (dialog com escolha + exclusão de templates; cria fluxo inativo com a definition do template — erro propagado para o dialog) e por linha "Salvar como template" (`POST /qualification/flow-templates` com a definition salva do fluxo). |
| 7 | **Messaging capabilities no editor** (C1-h v7) | A página do editor consulta `GET /me/messaging-capabilities`; o nó **Interativo** só entra na paleta quando alguma sessão relata `interactive=true`. Falha de rede/gateway sem suporte → nó oculto (degradação segura da spec); fluxos existentes com nós interativos continuam renderizados e editáveis. |
| 8 | **Galeria de mídia** (B10 v7) | Seção "Mídias armazenadas" em Configurações · Armazenamento: lista keyset de `GET /organization/storage/media` (tipo, arquivo, tamanho, data), seleção e exclusão em lote (`DELETE`, só itens `deletable` — tripz aparece como "não removível"), confirmação destrutiva, e revalidação do painel de uso/quota. |
| 9 | **2FA TOTP + sessões** (B2 v7, fase anterior desta entrega) | `/perfil`: ativar com QR (`qrcode.react`) + chave manual + código; desativar com senha; lista de sessões com revogação (encerrar a própria desloga) e "encerrar outras". `GET /me` expõe `totpEnabled`. Login trata `{totp_required:true}` e completa via `POST /auth/totp/verify`. |
| 10 | **Alertas read-all** | Botão "Marcar todas como lidas" em /alertas quando há não lidos (`PATCH /alerts/read-all`). |

## 2. Arquivos alterados (desta entrega)

**Novos (painel)**: `components/lead-merge-dialog.tsx`, `components/new-conversation-dialog.tsx`, `components/teams-manager.tsx`, `components/storage-media-gallery.tsx`, `components/flow-templates.tsx`, `components/flow-editor/flow-insights.tsx` + `.module.css`, `app/relatorios/page.tsx`, `components/account-security.tsx` (fase 2FA) e 12 arquivos de teste em `tests/`.

**Modificados (painel)**: `app/contatos/page.tsx`, `app/conversas/page.tsx`, `app/login/page.tsx`, `app/perfil/page.tsx`, `app/alertas/alertas-content.tsx`, `app/fluxos/page.tsx`, `app/fluxos/[id]/page.tsx`, `app/configuracoes/page.tsx`, `app/workspace/members/content.tsx`, `app/workspace/members/member-profile-dialog.tsx`, `components/flow-editor/flow-editor.tsx`, `lib/session.ts`, `lib/panel-manifest.ts`, `lib/conversations-api.ts` (remoção do helper morto do ciclo aposentado), `tests/comments-ui-regression.test.ts`.

**Backend**: apenas `src/auth/workspace-service.ts` — `GET /me` passa a incluir `totpEnabled` (leitura de `totp_enabled_at` já existente). Nenhuma rota, migration ou regra nova: tudo consome endpoints existentes e testados.

## 3. Testes adicionados (37 novos)

`lead-merge-dialog` (6), `contatos-merge-trigger` (3), `new-conversation-dialog` (4), `teams-manager` (7), `members-team-assignment` (3), `reports-page` (7), `flow-insights-templates` (8), `flow-editor-gating` (2), `storage-media-gallery` (5), `alerts-mark-all` (3), `account-security` (5), `login-totp` (4) — os três últimos da fase 2FA. Cobrem comportamento principal, erro, permissão, estados vazios, payloads exatos e interação UI→API. Cobertura de isolamento de tenant fica por conta das suítes de integração existentes (lead-merge, teams, reports, totp-sessions, storage-media-gallery — reexecutadas verdes nesta sessão).

## 4. Problemas descobertos durante a implementação

- O botão morto "Avaliar com IA" era pinado por teste de regressão — o pin foi invertido junto com a remoção.
- `POST /agent/evaluations/run` (rota inexistente) — removido na fase anterior.
- Form aninhado no TeamsManager fazia o rename disparar também o create — reestruturado.
- A paginação do drawer de execuções nunca inicializava o cursor (bug meu, pego no teste) — máquina de páginas refeita.
- `useSWRConfig` na página de configurações quebrava mocks parciais de `swr` (teste de deep-link) — trocado por observação da chave `/organization/storage` na própria galeria.
- `criarDeTemplate` engolia o erro (dialog fechava sem feedback) — erro agora propaga para o dialog e alimenta o rodapé de erro da lista.
- O teste do "Avaliar com IA"/dialog de merge dependia de textos quebrados por `<strong>` — matchers ajustados para trechos atômicos.

## 5. Itens deliberadamente NÃO implementados

- **Migration `0126_...staged`** — intocada, conforme restrição.
- **Gateways Stripe/PagBank/InfinitePay** — reservados "Em breve" por decisão documentada.
- **`/usage/export` e `/usage/credits`** — sem encaixe claro: a página /uso é de workspace (endpoints são ROOT) e não há tela ROOT de consumo mensal por IA onde o botão se encaixasse sem inventar superfície nova.
- **`GET /panel/versions`** — duplica o feed já consumido pela página /changelog; sem utilidade adicional identificada.
- **PDF dos relatórios** (spec B1 menciona jsPDF) — exigiria dependência nova no painel; o CSV do backend cobre exportação. Fica como decisão de produto (ver §6).
- APIs antigas cobertas por testes/compat (`/connection`, `/workspaces/current` base, `/qualification/sessions`) — intocadas.

## 6. Decisões de produto ainda necessárias

1. PDF nos relatórios (nova dependência `jspdf` + layout) ou manter CSV.
2. Atribuição de conversa a equipe a partir do painel (`PATCH /conversations/:id/assign` aceita `team_id` com round-robin, mas o UI de assign hoje só lista pessoas) — próximo passo natural do B6.
3. `GET /panel/versions` e `/usage/export`: construir UI, documentar como API interna ou aposentar.
4. Página /relatorios: acrescentar ao menu de ajuda/áudio tours existentes, se houver programa de documentação.

## 7. Riscos restantes

- Suíte completa do painel tem flakes documentados sob contenção de CPU (5 falhas em 1030 passaram isoladas na triagem; 1 falha real restante é de trabalho pré-existente em `scripts/design-audit/**`/`tests/design-audit-harness-repair.test.ts`, fora do escopo desta entrega).
- O gating do nó Interativo depende de `GET /me/messaging-capabilities` responder rápido; falha degrada para nó oculto (seguro, mas pode confundir quem tem gateway capaz e instabilidade de rede — o editor mostra os nós existentes normalmente).
- A busca do "Nova conversa" usa o endpoint de leads com escopo de sessão: operador só encontra contatos do próprio escopo (comportamento do backend, coerente, mas vale comunicar em treinamento).

## 8. Resultado dos gates

- `tsc --noEmit` painel: **limpo**; `tsc --noEmit` backend: **limpo**.
- `eslint --max-warnings=0` nos 35 arquivos tocados: **limpo** (3 warnings próprios encontrados e corrigidos).
- Vitest painel completo: **1023/1030** — triagem das 7 falhas: 5 flakes de contenção (passam isoladas), 1 pré-existente (design-audit-harness, WIP de outro loop), 1 meu (`settings-nested-routes`, corrigida e re-verificada 8/8). Re-execução pós-auditoria das suítes afetadas: **56/56**.
- Backend (banco descartável): `totp-sessions` 11/11, `panel-api` 35/35; suítes de merge/teams/reports/storage media existentes não foram alteradas e permanecem como rede de proteção.

## 9. Diff final auditado

Auditoria específica do diff produzido (fase 7), com três achados corrigidos em código (paginação do drawer de execuções, `useSWRConfig` quebrando mock de swr, erro engolido no criar-de-template) e três warnings de lint eliminados. Verificações feitas: endpoint/payload conferidos contra as rotas do backend em cada feature; permissões espelhando as chaves exigidas (`leads.delete`, `conversations.reply`, `members.update`, `dashboard.read`, `storage.manage`, `agent.manage`); tenancy sempre por sessão (nenhum id de tenant no cliente); feedback de loading/empty/erro/sucesso em todas as telas novas; confirmação explícita nas ações destrutivas (merge com telefone diferente, exclusão de equipe com membros, exclusão de mídias em lote); nenhum código morto introduzido (o único resquício apontado, `salvarTemplate`, foi removido); TypeScript sem `any` novo.

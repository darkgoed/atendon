# A6 — Frontend do painel Next.js

## 1. Estrutura do painel

- O painel usa o App Router do Next.js: as rotas estão em `apps/panel/app/`, com o layout raiz em `apps/panel/app/layout.tsx:17-19`; não há `pages/` no painel listado. O layout importa o CSS global e envolve o conteúdo com `PanelAccessGuard`, `PwaBootstrap` e `ErrorToasts` (`apps/panel/app/layout.tsx:2-5,17-19`).
- O shell visual principal é `apps/panel/components/shell.tsx:76-89`. Ele carrega sessão/capabilities e monta navegação lateral, command palette, seletor de workspace, notificações e banner de versão (`apps/panel/components/shell.tsx:8-24,122-160`).
- Os itens do menu não ficam espalhados nas páginas: `apps/panel/lib/panel-manifest.ts:30-41` define o tipo e `:61-77` define o catálogo único de rotas, grupos, labels, ícones, permissões, capabilities e flags `menu/rootOnly`. O shell filtra esse catálogo para construir os grupos visíveis (`apps/panel/components/shell.tsx:177-194`).

## 2. Client da API

- Existe client central em `apps/panel/lib/api.ts:16-59`. Ele usa `NEXT_PUBLIC_API_BASE_URL` ou `/backend` (`:20`), faz `fetch` com `credentials: "include"` (`:23`) e adiciona `Content-Type: application/json` quando apropriado (`:17-19`). Não há bearer token explícito no frontend; a autenticação é enviada por credenciais/cookies.
- Falhas de rede e respostas inválidas são reportadas por `reportError` e relançadas (`apps/panel/lib/api.ts:22-27,38-43`). HTTP 401 redireciona para `/login` e 428 para `/alterar-senha` (`:29-34`). Para HTTP não-OK, extrai `body.error` ou texto curto, aplica `friendlyPanelError`, reporta e lança `ApiError` com status e body preservados (`:45-56`).
- Componentes usam SWR com `api` como fetcher; por exemplo o shell define `fetcher = api` (`apps/panel/components/shell.tsx:32`) e carrega `/me` (`:122-125`).

## 3. Permissões, capabilities e feature flags

- Há RBAC no frontend. `apps/panel/lib/session.ts:61-72` implementa `hasRequiredPermissions`/`canAccessWithSession`, e `apps/panel/lib/use-permission.ts:9-15` expõe o hook `usePermission`. O manifesto associa permissões aos itens (`apps/panel/lib/panel-manifest.ts:62-72`) e `canAccessManifestItem` aplica permissões, `rootOnly` e `rootWorkspaceOnly` (`:85-89`). Páginas também fazem gating local; por exemplo `apps/panel/app/configuracoes/page.tsx:82-90,129-134` define destinos com permission e filtra acesso.
- Há gating por capability comercial. `apps/panel/lib/capabilities.tsx:28-75` busca `/capabilities`, isola cache por tenant e expõe `isEnabled`. O `PanelAccessGuard` exclui `/root` e rotas centrais do gating comercial (`apps/panel/components/panel-access-guard.tsx:21-23,61-67`), mas para rotas de manifesto não isentas bloqueia capability ausente/desabilitada e mostra `CapabilityUnavailable` (`:79-85`), com mensagem “não está habilitado neste workspace” e retorno para Conversas (`:39-57`).
- Feature flags técnicas são separadas: `apps/panel/lib/feature-flags.ts:3-19` tipa e consulta flags via resposta; `:22-31` reconhece especificamente 409 + `FEATURE_FLAG_DISABLED` + feature esperada. Uso concreto existe em `apps/panel/app/alertas/page.tsx:10,82` e `apps/panel/app/conversas/page.tsx:20,34,484`.

## 4. Área ROOT atual

- `apps/panel/app/root/` hoje contém apenas duas páginas: `root/workspaces/page.tsx` e `root/audit/page.tsx` (rotas encontradas no diretório).
- A proteção principal é global: `PanelAccessGuard` trata `/root` como rota autenticada e `canAccessManifestItem` exige `session.user.isRoot` para itens `rootOnly` (`apps/panel/components/panel-access-guard.tsx:152-155`; `apps/panel/lib/panel-manifest.ts:70,73-74,85-88`). As próprias páginas ainda só ativam os requests se `session?.user.isRoot` (`apps/panel/app/root/workspaces/page.tsx:33-35`; `apps/panel/app/root/audit/page.tsx:15-17`).
- Workspaces combina formulário de criação, formulário de edição/capabilities e tabela responsiva. O POST usa `FormData` e `api` (`apps/panel/app/root/workspaces/page.tsx:57-75`); a edição usa PATCH (`:136-142`); a tabela é `<table className="admin-table responsive-table">` com ações Editar/Acessar/Suspender (`:191-194`). A edição de capabilities usa select inherit/on/off e confirmação explícita de cascata (`:176-186`).
- Auditoria ROOT tem busca local, estado de carregamento/erro e componente reutilizável `AuditLogTable` (`apps/panel/app/root/audit/page.tsx:22-49`). O componente usa tabela responsiva, empty state e colunas contextuais (`apps/panel/components/audit-log-table.tsx:8-49`).
- Não existem ainda páginas ROOT específicas de SaaS para Planos, Empresas, Assinaturas, Cobranças, Consumo, Gateways e Histórico; “Empresas” no menu aponta para a página de workspaces (`apps/panel/lib/panel-manifest.ts:73-74`).

## 5. Convenções de UI

- O estilo é majoritariamente CSS próprio com classes semânticas (`btn`, `card`, `input`, `admin-table`, `field`) em `apps/panel/app/globals.css`; Tailwind v4 também está instalado (`apps/panel/package.json:16-24`) e há uso de utilitários Tailwind nas páginas, mas não há uma biblioteca externa de componentes.
- Botão: não há componente `Button` central identificado; o padrão é `<button className="btn ...">`, estilizado em `apps/panel/app/globals.css:270-276`.
- Modal: `apps/panel/components/modal-dialog.tsx:14-30` define `ModalDialog`; implementa foco inicial, ciclo de Tab, Escape, restauração de foco e `role="dialog"` (`:35-100`).
- Tabela: não há tabela genérica única; `apps/panel/components/audit-log-table.tsx:8-49` é reutilizável para auditoria, enquanto ROOT Workspaces renderiza `admin-table responsive-table` diretamente (`apps/panel/app/root/workspaces/page.tsx:191-194`).
- Toast: `apps/panel/components/error-toasts.tsx:21-51` centraliza erros de API/runtime/promises; o visual está em `.error-toasts/.error-toast` (`apps/panel/app/globals.css:300-311`). Há também toast de mensagens recebidas com `.message-toast` (`globals.css:313-326`).
- Ícones são Phosphor (`apps/panel/lib/panel-manifest.ts:1-14`); estados comuns usam `Empty`/`LoadingCards` (`apps/panel/app/root/audit/page.tsx:6-8,36-44`).

## 6. Erros de negócio na UI

- O client preserva código/status/body no `ApiError` (`apps/panel/lib/api.ts:4-13,45-56`) e traduz apenas mensagens conhecidas de WhatsApp via `friendlyPanelError` (`apps/panel/lib/whatsapp-support.ts:6-12`). O `ErrorToasts` escuta erros reportados e exibe a mensagem por até 8 segundos (`apps/panel/components/error-toasts.tsx:36-51`).
- Para `409 FEATURE_FLAG_DISABLED`, existe reconhecimento estruturado em `apps/panel/lib/feature-flags.ts:22-31`. No fluxo de alertas, `apps/panel/components/error-toasts.tsx:68-92` trata explicitamente 409 + `FEATURE_FLAG_DISABLED` para `alerts_delivery_v2` como feature desligada e interrompe polling (`:133-141`), sem mostrar toast de erro ao usuário.
- Não foi encontrado no painel um componente que converta genericamente `FEATURE_FLAG_DISABLED` em uma mensagem amigável visível; páginas que capturam erro normalmente exibem `error.message`/mensagem local, por exemplo ROOT Workspaces (`apps/panel/app/root/workspaces/page.tsx:107-117,144-148`) e ROOT Audit (`apps/panel/app/root/audit/page.tsx:36-44`).

## 7. Testes

- Unit/component tests usam Vitest: script `test` é `vitest run` (`apps/panel/package.json:10-13`); ficam principalmente em `apps/panel/tests/` e há teste junto da agenda em `apps/panel/app/agenda/agenda-calendar.test.tsx`. Há cobertura explícita de API (`tests/api.test.ts`), sessão, capabilities, UI, tabelas e fluxos.
- E2E usa Playwright: script `test:e2e` é `playwright test` (`apps/panel/package.json:10-13`). A configuração aponta `testDir: "./e2e"` e `testMatch: "**/*.e2e.ts"` (`apps/panel/playwright.config.ts:46-50`), com specs como `panel-smoke.e2e.ts`, `capabilities.e2e.ts` e `post-sales.e2e.ts`. Por padrão sobe backend de teste e o painel Next em portas 3319/3299 (`playwright.config.ts:64-95`), exigindo `.env.test` seguro e banco loopback de teste (`:16-38`).

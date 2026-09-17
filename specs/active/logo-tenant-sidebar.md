# SPEC: Logo da empresa (tenant) — upload nas configurações e exibição no seletor do sidebar
## Objective
O workspace pode definir uma logo da empresa e ela aparece no seletor de empresas do sidebar
(no trigger ativo e nas opções da lista), substituindo a inicial quando presente.
## Source
comments.md:230 — "Ter como Adicionar logo da empresa/tenant e visualizar a logo no select do
sidebar".
## Current State
- Tabela `tenants` não tem coluna de logo; SessionWorkspace (lib/session.ts:9-16) não carrega logo.
- WorkspaceSwitcher (components/workspace-switcher.tsx:41-77) mostra inicial (initials()).
- WorkspaceSettingsPanel (app/configuracoes/page.tsx:364-492) só edita fuso/horário.
- Sem infra de upload de arquivos; padrão do codebase para mídia pequena é base64 no banco.
- PATCH de referência: /workspaces/current/timezone (workspaces/routes.ts:163-192) —
  requirePermission("workspace.update") + audit().
## Desired Behavior
1. Na aba Geral das configurações, donos de workspace.update podem escolher/enviar uma imagem de
   logo (png/jpeg/webp), redimensionada no cliente para ≤256px e ≤100KB, e salvá-la; podem remover.
2. A logo aparece no trigger do WorkspaceSwitcher e nas opções do menu (inicial como fallback).
3. /me e /workspaces/current devolvem a logo do(s) workspace(s).
## Requirements
### R1 — Migration 0165_tenant_logo.sql
(renumerada de 0163: número ocupado por 0163_instagram_active_ownership de outra frente)
Acceptance Criteria:
- `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_data TEXT;` (NULL = sem logo) + COMMENT.
- Idempotente; rollback documentado no cabeçalho (padrão do repo).
Verification:
- fresh-migrations em banco limpo aplica 0163; coluna existe.
### R2 — Endpoints backend
- PATCH /workspaces/current/logo { logo_data: string (data URL image/png|jpeg|webp, ≤150KB após
  base64) } e DELETE /workspaces/current/logo.
- Guarda: requirePermission("workspace.update"); valida prefixo `data:image/(png|jpeg|webp);base64,`
  e tamanho; audit() em ambos.
Acceptance Criteria:
- Resposta contém { workspace: { logo_data } } (ou null após DELETE).
- Payload inválido (tipo errado, >150KB, não-data-URL) → 400; sem permissão → 403.
- Isolamento de tenant: UPDATE sempre por session.tenantId.
Verification:
- Novo apps/backend/tests/workspace-logo.integration.test.ts: (a) PATCH grava e GET /me devolve
  logo_data; (b) DELETE limpa; (c) 400 em payload inválido; (d) 403 sem workspace.update;
  (e) tenant B não vê logo do tenant A. Env limpo (unset DATABASE_URL TEST_DATABASE_URL NODE_ENV).
### R3 — Sessão/payload
Acceptance Criteria:
- buildMePayload inclui logo_data no activeWorkspace e em cada workspace de listWorkspacesForUser
  (ROOT e membro); SessionWorkspace ganha `logo_data?: string | null`.
Verification:
- typecheck backend; teste R2(a) já cobre via /me.
### R4 — UI: upload/remoção na aba Geral
Seção "Logo da empresa" no WorkspaceSettingsPanel: input file (accept image/png,image/jpeg,
image/webp), preview redondo/quadrado, botão Salvar/Remover; redimensionamento via canvas
(cover, 256px max, saída PNG para transparência ou JPEG se maior compressão — decisão do
implementador documentada em comentário); mensagens de erro/sucesso no padrão local.
Acceptance Criteria:
- Sem permissão workspace.update: seção em modo leitura (mostra logo atual ou vazio).
- Arquivo >5MB original ou não-imagem → erro antes do canvas.
- Após salvar: WorkspaceSwitcher do Shell reflete a logo (revalida /me — dedupInterval 10s no
  SWR; usar mutate global ou window/location reload leve? NÃO reload: mutate do cache "/me").
Verification:
- npx vitest run tests/organization-ui.test.ts (verificar asserts de source ANTES de editar —
  arquivo asserfa linhas de configuracoes/page.tsx) + novo tests/workspace-logo-ui.test.ts:
  (a) renderiza preview com logo_data; (b) sem logo mostra fallback inicial;
  (c) salvar chama PATCH com data URL (mock api); (d) remover chama DELETE.
### R5 — WorkspaceSwitcher exibe a logo
Acceptance Criteria:
- Trigger: <img> (src=data URL, alt="" decorativo, classe própria) no lugar do inicial quando
  active.logo_data existe; menu: mesma substituição por opção; fallback inicial intacto.
- <img> com eslint-disable-next-line @next/next/no-img-element (padrão existente em
  conversation-composer.tsx:313).
Verification:
- npx vitest run tests/workspace-logo-ui.test.ts; grep visual no shell via render do teste.
## Invariants
- Nenhum segredo/dado sensível no payload; logo é pública dentro do painel.
- Compat Safari 12+: canvas.toDataURL + FileReader OK; sem navigator.clipboard.
- Nenhum commit/push/deploy por agentes.
## Edge Cases
- Logo 1x1 pixelada → upscale não permitido (mantém tamanho, centraliza em 256 canvas com fundo
  transparente). GIF/BMP rejeitados. Data URL quebrada (base64 inválido) → 400.
- ROOT no modo root-scope (actorScope root) visualizando workspaces: lista já carrega logo p/
  todos tenants.
## Dependencies
- Nenhuma com os outros SPECs (backend+frontend deste módulo).
## Affected Areas
apps/backend/src/db/migrations/0165_tenant_logo.sql (NOVO),
apps/backend/src/modules/workspaces/routes.ts, apps/backend/src/auth/workspace-service.ts,
apps/backend/tests/workspace-logo.integration.test.ts (NOVO),
apps/panel/lib/session.ts, apps/panel/app/configuracoes/page.tsx,
apps/panel/components/workspace-switcher.tsx,
apps/panel/tests/workspace-logo-ui.test.ts (NOVO).
## Non-goals
- Não servir logos por CDN/rota de arquivo; não aplicar logo em outras superfícies (login, e-mail,
  PDF) — só no seletor do sidebar e aba Geral.
## Constraints
- Limite de payload 150KB no backend (defesa); client comprime para ≤100KB.
- Sem novas dependências.
## Required Tests
R2 (5 casos backend) + R4/R5 (4 casos UI) + suíte organization-ui existente.
## Definition of Done
- [ ] R1–R5 implementados; testes novos verdes 2x; typecheck/lint limpos; sem regressão
      organization-ui.

# AtendON — Multi-tenancy, autenticação, RBAC, ROOT e auditoria

## 1. Multi-tenancy

O tenant é a tabela `tenants`; sua chave é `tenants.id` (UUID). Não há tabela/coluna `company_id` no fluxo atual. As tabelas de domínio SaaS carregam `tenant_id` como FK para `tenants(id)`; isso já aparece no núcleo em `apps/backend/src/db/migrations/0001_core.sql:3-8,10-18,20-29,31-43,56-65`. A camada SaaS adiciona `slug`, status e criador em `tenants` (`apps/backend/src/db/migrations/0017_saas_foundation.sql:1-9`).

Para usuários não-ROOT, o workspace ativo vem do claim `tenantId` do JWT e é validado por associação em `workspace_members.workspace_id`, role, `m.status='active'` e tenant não suspenso (`apps/backend/src/auth/session.ts:81-120`). Para ROOT, o mesmo claim é validado diretamente contra `tenants.id` e `status <> 'suspended'` (`apps/backend/src/auth/session.ts:85-90`). A troca explícita para um workspace ROOT ocorre em `/root/workspaces/:id/access`, que valida o tenant antes de emitir novo token (`apps/backend/src/modules/root/routes.ts:239-256`).

Não existe RLS geral para isolamento de todos os tenants. O helper transacional valida UUID e executa `SET LOCAL app.tenant_id` (`apps/backend/src/db/tenant-transaction.ts:4-14,17-38`), mas somente `agent_message_transaction_claims` tem política RLS declarada (`apps/backend/src/db/migrations/0079_agent_message_transaction_claims_rls.sql:1-14`); a migração seguinte desabilita RLS para essa tabela durante o piloto (`apps/backend/src/db/migrations/0080_stage_transaction_claims_rls_activation.sql:1-8`). O isolamento normal é, portanto, explícito nas queries/joins por `tenant_id`.

## 2. Sessão/JWT e tenant ativo

`PanelSession` contém `userId`, `tenantId`, email, role e flags ROOT; `IdentitySession` torna `tenantId` opcional (`apps/backend/src/auth/session.ts:8-24`). `createSessionToken` consulta `users.session_version`, incorpora a sessão no payload, usa HS256, JTI, emissão e expiração de 12 horas (`apps/backend/src/auth/session.ts:26-40`).

`requireIdentity` lê o cookie HTTP-only `atendon_session`, verifica HS256, recarrega o usuário por ID, exige `users.status='active'`, compara `sessionVersion`, e bloqueia `must_change_password` salvo exceção (`apps/backend/src/auth/session.ts:42-78`). O tenant do token é convertido em string, mas não é confiado isoladamente: `requireWorkspace` exige tenant, verifica tenant suspenso e, para usuário normal, consulta membership ativo e role/permissões (`apps/backend/src/auth/session.ts:81-120`).

`workspace-service.ts` lista todos os tenants não suspensos para ROOT e apenas memberships ativos para usuários normais (`apps/backend/src/auth/workspace-service.ts:21-38`), e monta `activeWorkspace` por `session.tenantId` (`apps/backend/src/auth/workspace-service.ts:41-80`).

## 3. Usuários, papéis e permissões (RBAC)

As tabelas são `users`, `permissions`, `workspace_roles`, `workspace_role_permissions`, `workspace_members` e `workspace_invitations` (`apps/backend/src/db/migrations/0017_saas_foundation.sql:11-70`). `users` tem email único, hash, status e `is_root`; memberships ligam usuário, workspace e role, com status próprio (`apps/backend/src/db/migrations/0017_saas_foundation.sql:11-20,29-57`).

O catálogo em runtime está em `PERMISSIONS` (`apps/backend/src/auth/rbac.ts:3-67`), incluindo workspace, membros, roles, auditoria, conexão, conversas, leads, agenda, organização, IA, uso, assinatura, notificações, pós-venda e Tripz IA. `ensurePermissionCatalog` faz upsert do catálogo (`apps/backend/src/auth/rbac.ts:106-115`).

Os papéis de sistema são OWNER, ADMIN, SUPERVISOR e OPERADOR (`apps/backend/src/auth/rbac.ts:117-131`). OWNER e ADMIN recebem todas as permissões exceto as de `tripz_ai`; SUPERVISOR recebe `SUPERVISOR_PERMISSIONS`; OPERADOR recebe `OPERATOR_PERMISSIONS` (`apps/backend/src/auth/rbac.ts:69-104,133-166`). A migração inicial também registra OWNER/ADMIN/OPERADOR e suas permissões (`apps/backend/src/db/migrations/0017_saas_foundation.sql:166-209`). `requirePermission` usa permissões resolvidas do membership e ROOT só passa quando `rootWorkspaceAccess` está ativo (`apps/backend/src/auth/session.ts:123-132`).

## 4. ROOT e rotas ROOT/workspaces

ROOT é identificado pelo booleano persistido `users.is_root`, sempre revalidado no banco, junto de `status='active'`, em `requireRoot` (`apps/backend/src/auth/session.ts:141-146`). A criação/elevação de usuário ROOT ocorre em `createRootUser`, que grava `is_root=true` e status ativo salvo usuário já disabled (`apps/backend/src/auth/workspace-service.ts:84-97`).

As rotas ROOT existentes são: listar workspaces (`GET /root/workspaces`, `apps/backend/src/modules/root/routes.ts:64-87`); criar workspace, roles/defaults, convite OWNER, sessão WhatsApp, agente, settings, flags copiadas e três logs (`POST /root/workspaces`, `apps/backend/src/modules/root/routes.ts:89-218`); atualizar tenant/status/telefone (`PATCH /root/workspaces/:id`, `apps/backend/src/modules/root/routes.ts:220-237`); assumir acesso ROOT a workspace e emitir JWT (`POST /root/workspaces/:id/access`, `apps/backend/src/modules/root/routes.ts:239-278`); apagar contatos/mensagens/leads/agendamentos de workspace (`DELETE /root/workspaces/:id/contacts-and-messages`, `apps/backend/src/modules/root/routes.ts:280-335`); consultar auditoria global, limitada a 500 (`GET /root/audit-logs`, `apps/backend/src/modules/root/routes.ts:337-349`); e métricas operacionais (`GET /root/operations/metrics`, `apps/backend/src/modules/root/routes.ts:351-355`).

As rotas de workspace usam `requirePermission`, `requireRootWorkspace` ou `requireSession` (`apps/backend/src/modules/workspaces/routes.ts:5-7`), incluindo aceitar convite e gerar sessão no workspace convidado (`apps/backend/src/modules/workspaces/routes.ts:674-745`) e auditoria corrente filtrada por `workspace_id` (`apps/backend/src/modules/workspaces/routes.ts:754-765`).

## 5. Auditoria

Existe tabela exata `audit_logs`, criada em `apps/backend/src/db/migrations/0017_saas_foundation.sql:73-91`. Colunas: `id`, `actor_user_id`, `workspace_id`, `actor_scope` (`root|workspace`), `action`, `resource_type`, `resource_id`, `metadata` JSONB, `ip_address`, `user_agent`, `created_at`; há índices por workspace/data e ator/data.

Não foi localizado helper genérico exportado `auditLog`; há inserções diretas e um helper local `audit` nas rotas ROOT (`apps/backend/src/modules/root/routes.ts:46-62`). O helper grava actor ROOT, workspace/recurso, ação, metadata, IP e user-agent. O endpoint workspace lê somente o `workspace_id` ativo (`apps/backend/src/modules/workspaces/routes.ts:754-765`), enquanto ROOT lê globalmente (`apps/backend/src/modules/root/routes.ts:337-349`).

## 6. Estados

`users.status` aceita exatamente `invited`, `active`, `disabled` (`apps/backend/src/db/migrations/0017_saas_foundation.sql:11-20`). A autenticação exige literal `active` (`apps/backend/src/auth/session.ts:51-57`). `workspace_members.status` aceita `invited`, `active`, `suspended` (`apps/backend/src/db/migrations/0017_saas_foundation.sql:47-57`); convites usam `pending`, `accepted`, `revoked`, `expired` (`apps/backend/src/db/migrations/0017_saas_foundation.sql:59-70`). Tenants usam `trial`, `active`, `suspended` (`apps/backend/src/db/migrations/0001_core.sql:3-8`).

## 7. API keys e webhooks

A tabela legada/operacional de API keys é `tenant_api_keys`, com `tenant_id`, hash, ativo e último uso (`apps/backend/src/db/migrations/0006_scheduling.sql:1-9`). A migração de segurança adiciona scopes limitados, prefixo, expiração, revogação, criador/rotação e índice de autenticação por hash ativo (`apps/backend/src/db/migrations/0037_tenant_api_key_security.sql:1-47`), além das permissões `api_keys.read/manage` para OWNER/ADMIN (`apps/backend/src/db/migrations/0037_tenant_api_key_security.sql:49-62`).

No código TypeScript examinado não há rota/helper atual que leia `tenant_api_keys`, `key_hash` ou um header de API key; o scheduling atual chama `requirePermission` (sessão do painel) e valida query `tenant` contra o tenant da sessão (`apps/backend/src/modules/scheduling/routes.ts:31-57,125-143`). Portanto, não se deve afirmar que as rotas atuais de scheduling estejam autenticando por API key; o schema suporta essa modalidade, mas a implementação encontrada não a utiliza.

Webhook Evolution é diferente do painel: `POST /webhooks/evolution` exige o header `x-atendon-webhook-secret`, comparado em tempo constante ao segredo de configuração; falha retorna 401 (`apps/backend/src/app.ts:456-467`). Depois do segredo, resolve a instância pelo `event.instanceName` e obtém o `tenantId` pela sessão/identidade da instância (`apps/backend/src/app.ts:465-480`). Não usa cookie/JWT de painel.

## 8. Riscos, mitigação e pontos de atenção

- O JWT carrega `tenantId`, mas o servidor mitiga troca arbitrária revalidando membership/tenant em `requireWorkspace` (`apps/backend/src/auth/session.ts:102-112`); para ROOT, qualquer tenant não suspenso é permitido por desenho (`apps/backend/src/auth/session.ts:85-98`).
- O parâmetro `tenant` de scheduling não seleciona tenant: é comparado ao tenant autenticado e divergência dá 403 (`apps/backend/src/modules/scheduling/routes.ts:34-57`).
- A ausência de RLS geral deixa o isolamento dependente de cada query incluir corretamente `tenant_id`; apenas uma tabela teve política RLS, e ela está desabilitada no piloto (`apps/backend/src/db/migrations/0079_agent_message_transaction_claims_rls.sql:1-14`; `apps/backend/src/db/migrations/0080_stage_transaction_claims_rls_activation.sql:1-8`). Esse é o principal risco sistêmico de vazamento cross-tenant por query futura incorreta.
- Integridade cruzada é reforçada por FKs compostas/triggers em várias migrações; API-key rotation exige mesma combinação `(id,tenant_id)` (`apps/backend/src/db/migrations/0065_tenant_invariants_and_fk_indexes.sql:23-43,108-109`).
- `session_version` é revalidado em cada request e incrementado em fluxos de convite/alteração, mitigando reutilização de JWT após mudanças (`apps/backend/src/auth/session.ts:51-60`; `apps/backend/src/modules/workspaces/routes.ts:699-717`).
- OWNER/ADMIN têm catálogo amplo por construção; alterações de roles/members devem continuar protegidas por `requirePermission`, e ROOT possui operações destrutivas explicitamente expostas e auditadas (`apps/backend/src/auth/rbac.ts:144-150`; `apps/backend/src/modules/root/routes.ts:280-327`).
- A tabela `audit_logs` permite `workspace_id NULL` por `ON DELETE SET NULL` e não tem RLS (`apps/backend/src/db/migrations/0017_saas_foundation.sql:73-84`); a confidencialidade depende dos filtros das rotas. A rota ROOT é global por intenção, a rota workspace filtra pelo tenant (`apps/backend/src/modules/root/routes.ts:337-348`; `apps/backend/src/modules/workspaces/routes.ts:754-764`).

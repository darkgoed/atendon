# Plano de evolução para SaaS multi-workspace

## Decisões confirmadas

- Um usuário pode participar de vários workspaces usando a mesma identidade e o mesmo e-mail.
- Todo workspace possui exatamente um `OWNER` protegido, com acesso total ao workspace.
- Workspaces podem criar e editar funções personalizadas usando um catálogo fixo de permissões.
- `ROOT` é um papel global da plataforma, pode administrar e acessar qualquer workspace e toda atuação dentro de um workspace deve ser auditada.
- Apenas o `ROOT` cria workspaces.
- Novos membros entram por convite enviado por e-mail e definem a própria senha.
- O envio de convites usará SMTP configurável por variáveis de ambiente.
- Convites expiram sete dias após a emissão.
- O primeiro usuário `ROOT` será criado por seed administrativo configurado por variáveis de ambiente.
- Não haverá planos, assinatura, cobrança ou billing nesta etapa.
- O RBAC deve cobrir todos os módulos existentes no projeto.

## Princípios de segurança

1. O workspace ativo nunca será aceito do cliente sem validar a associação do usuário.
2. Toda consulta de negócio continuará limitada por `tenant_id` (nome atual do workspace no banco).
3. Autenticação e autorização serão responsabilidades separadas.
4. Ocultar menus no painel não substitui a autorização no backend.
5. Permissões serão negadas por padrão.
6. `ROOT` não será uma função de workspace e não poderá ser concedido por um `OWNER`.
7. Acesso e alterações feitas por `ROOT` dentro de um workspace registrarão ator, workspace, ação, alvo, data, IP e contexto.
8. O último `OWNER` não poderá ser removido, desativado ou rebaixado. A transferência de propriedade será uma operação explícita e transacional.

## Modelo de dados proposto

### Identidade global

`users`

- `id`
- `email` único e normalizado
- `password_hash` anulável enquanto o convite não for aceito
- `status`: `invited`, `active`, `disabled`
- `is_root`
- `created_at`, `updated_at`, `last_login_at`

### Workspace

Manter inicialmente a tabela `tenants` e o campo `tenant_id` para evitar uma migração ampla e arriscada. Na aplicação, o conceito será chamado de workspace.

Adicionar a `tenants`:

- `slug` único
- `updated_at`
- `created_by_user_id`

### Associação

`workspace_members`

- `id`
- `workspace_id` (`tenants.id`)
- `user_id`
- `role_id`
- `status`: `invited`, `active`, `suspended`
- `joined_at`, `created_at`, `updated_at`
- unicidade em `(workspace_id, user_id)`

### Funções e permissões

`workspace_roles`

- `id`
- `workspace_id`
- `name`
- `description`
- `is_owner_role`
- `is_system`
- `created_at`, `updated_at`
- nome único por workspace

`permissions`

- `key` como chave primária estável
- `module`
- `action`
- `description`

`workspace_role_permissions`

- `role_id`
- `permission_key`
- chave primária composta

### Convites

`workspace_invitations`

- `id`
- `workspace_id`
- `email`
- `role_id`
- `token_hash` (nunca salvar o token puro)
- `status`: `pending`, `accepted`, `revoked`, `expired`
- `expires_at`
- `invited_by_user_id`
- `accepted_by_user_id`
- `created_at`, `accepted_at`

Um convite deve ser de uso único, expirar e ser invalidado quando reenviado ou revogado.
O prazo padrão e inicial de expiração será de sete dias.

### Auditoria

`audit_logs`

- `id`
- `actor_user_id`
- `workspace_id` anulável para ações globais
- `actor_scope`: `root`, `workspace`
- `action`
- `resource_type`, `resource_id`
- `metadata` JSONB sem segredos
- `ip_address`, `user_agent`
- `created_at`

## Catálogo inicial de permissões

### Plataforma e workspace

- `dashboard.read`
- `workspace.read`
- `workspace.update`
- `members.read`
- `members.invite`
- `members.update`
- `members.remove`
- `roles.read`
- `roles.create`
- `roles.update`
- `roles.delete`
- `audit.read`

### WhatsApp

- `connection.read`
- `connection.manage`

### Conversas e contatos

- `conversations.read`
- `conversations.reply`
- `conversations.reactivate`
- `contacts.read`
- `contacts.delete`

### Leads

- `leads.read`
- `leads.create`
- `leads.update_status`
- `leads.transfer`
- `leads.send_partner_proposal`

### Agenda

- `appointments.read`
- `appointments.create`
- `appointments.reschedule`
- `appointments.cancel`

### Cadastros da agenda

- `categories.read`, `categories.manage`
- `partners.read`, `partners.manage`
- `units.read`, `units.manage`
- `availability.read`, `availability.manage`

### Inteligência artificial

- `agent.read`
- `agent.manage`
- `humanizer.read`
- `humanizer.manage`
- `usage.read`
- `usage.export`

Permissões de exclusão destrutiva devem continuar separadas de permissões comuns de edição. A rota atual `/dev/contacts-and-messages` não deve existir como operação normal de produção; se mantida para manutenção, ficará restrita ao `ROOT` e auditada.

## Funções padrão de cada workspace

### OWNER

- Criada automaticamente com o workspace.
- Recebe todas as permissões atuais e futuras.
- Não pode ser excluída nem editada para perder permissões.
- Deve existir exatamente um membro proprietário.

### ADMIN

- Criada automaticamente com todas as permissões do workspace, exceto transferência de propriedade.
- Pode ser editada pelo `OWNER`, pois não é a função proprietária protegida.

### OPERADOR

- `dashboard.read`
- `conversations.read`
- `conversations.reply`
- `conversations.reactivate`
- `contacts.read`
- `leads.read`
- `leads.update_status`
- `leads.transfer`
- `appointments.read`
- `appointments.create`
- `appointments.reschedule`
- `appointments.cancel`
- permissões de leitura de categorias, parceiros, unidades e disponibilidade

Funções personalizadas podem combinar qualquer permissão do catálogo, mas nunca recebem capacidades globais de `ROOT`.

## Sessão e seleção de workspace

O JWT atual contém um único `tenantId` e permissões implícitas. O novo fluxo será:

1. Login autentica somente a identidade global.
2. `/me` retorna o usuário, o workspace ativo, associações disponíveis e permissões efetivas.
3. Se houver um único workspace, ele é selecionado automaticamente.
4. Se houver vários, o painel exibe um seletor persistente.
5. A troca chama um endpoint dedicado que valida a associação e renova a sessão com o workspace ativo.
6. O backend recarrega associação e permissões do banco em operações protegidas; o JWT não será a fonte definitiva de autorização.
7. `ROOT` pode selecionar qualquer workspace em modo de acesso assistido, com banner permanente no painel e auditoria.

## Backend

Criar uma camada central com:

- `requireIdentity()` para autenticação.
- `requireWorkspace()` para resolver e validar o workspace ativo.
- `requirePermission(key)` para autorização RBAC.
- `requireRoot()` para rotas globais.
- helpers de auditoria para ações sensíveis.

Cada rota deverá declarar sua permissão. Rotas acionadas por API key e webhooks continuarão com autenticação própria e isolamento por `tenant_id`; elas não representam um usuário do painel e não usarão o RBAC de membros.

Novos grupos de API:

- `/root/workspaces`
- `/root/users`
- `/root/audit-logs`
- `/root/workspaces/:id/access`
- `/workspaces/current`
- `/workspaces/switch`
- `/workspaces/current/members`
- `/workspaces/current/roles`
- `/workspaces/current/invitations`
- `/invitations/:token`
- `/auth/accept-invitation`

## Painel

### Área ROOT

- Lista, busca, criação, edição, suspensão e reativação de workspaces.
- Visualização de membros e estado operacional de cada workspace.
- Entrada auditada em um workspace.
- Consulta de auditoria global.

### Área do workspace

- Seletor de workspace.
- Página de membros e convites.
- Página de funções com matriz de permissões.
- Auditoria do workspace.
- Menus e ações filtrados por permissão.
- Página de acesso negado (`403`) distinta da tela de login.
- Banner explícito durante acesso do `ROOT`.

## Convite por e-mail

Criar uma interface `EmailProvider`, implementada inicialmente por SMTP, para manter o domínio desacoplado do transporte. A configuração virá exclusivamente do ambiente (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` e URL pública do painel). O envio recebe um link com token único, válido por sete dias, para uma página pública onde a pessoa:

1. Confirma o e-mail do convite.
2. Define a senha.
3. Ativa ou reutiliza sua identidade global.
4. Passa a integrar o workspace com a função escolhida.

Se o e-mail já pertencer a um usuário ativo, ele autentica e apenas aceita a nova associação; sua senha atual não é substituída.

## Bootstrap do primeiro ROOT

O seed administrativo usará variáveis de ambiente dedicadas, como `ROOT_SEED_EMAIL` e `ROOT_SEED_PASSWORD`.

- A senha nunca será armazenada ou exibida em texto puro e será persistida somente como hash forte.
- O seed será idempotente: execuções seguintes atualizam apenas o necessário e não criam usuários duplicados.
- A configuração será obrigatória no primeiro provisionamento e poderá ser removida do ambiente depois da criação validada.
- O seed não poderá rebaixar, apagar ou trocar silenciosamente a senha de um `ROOT` já ativo.
- A criação e eventuais alterações administrativas serão registradas na auditoria.
- Produção deverá rejeitar senha inicial fraca.

## Migração dos dados atuais

1. Criar as novas tabelas sem remover `panel_users`.
2. Copiar cada `panel_user` para `users`, preservando e-mail e hash de senha.
3. Criar funções `OWNER`, `ADMIN` e `OPERADOR` para cada tenant.
4. Criar `workspace_members` para os usuários existentes.
5. Mapear `panel_users.role = owner` para `OWNER` e `admin` para `ADMIN`.
6. Mapear `is_super_admin = true` para `users.is_root = true`.
7. Validar contagens, unicidade de e-mails e existência de um proprietário por workspace.
8. Trocar autenticação e rotas para o novo modelo.
9. Manter uma janela de compatibilidade curta e, após validação, remover `panel_users`.

Conflitos de e-mail existentes devem ser detectados antes da migração. Como `panel_users.email` já é único globalmente, a migração normal não deve precisar mesclar identidades.

## Testes obrigatórios

- Usuário com múltiplos workspaces troca de contexto sem misturar dados.
- Usuário não consegue selecionar workspace ao qual não pertence.
- Toda rota retorna `403` sem a permissão exigida.
- Identificadores de outro workspace continuam retornando `404`/acesso negado sem vazar sua existência.
- `OWNER` não pode ser removido, rebaixado ou deixar o workspace sem proprietário.
- Transferência de propriedade é atômica.
- Convite expirado, revogado ou já usado é rejeitado.
- Convite para usuário existente cria apenas uma nova associação.
- Alterar uma função afeta imediatamente seus membros.
- Função em uso não é excluída sem uma estratégia explícita de reassociação.
- Acesso e mutações do `ROOT` são auditados.
- API keys e webhooks permanecem isolados por tenant.
- Testes de regressão cobrem todos os módulos atuais.

## Fases de implementação

### Fase 1 — Fundação

- Migrations das identidades, associações, funções, permissões, convites e auditoria.
- Seed idempotente do catálogo de permissões.
- Migração dos usuários atuais.
- Seed administrativo idempotente do primeiro `ROOT`.
- Serviços centrais de autenticação, workspace e autorização.

### Fase 2 — Proteção completa da API

- Classificar e proteger todas as rotas existentes.
- Separar rotas públicas, de API key, de workspace e de `ROOT`.
- Adicionar testes de permissão e isolamento.

### Fase 3 — Administração do workspace

- CRUD de funções.
- Convites e gestão de membros.
- Seletor de workspace.
- Filtragem de navegação e ações no painel.

### Fase 4 — Administração ROOT

- CRUD e suspensão de workspaces.
- Criação do `OWNER` inicial por convite.
- Acesso assistido/auditado.
- Auditoria global e por workspace.

### Fase 5 — Endurecimento e migração final

- Entrega SMTP, templates e observabilidade de e-mail em produção.
- Revogação de sessões após mudanças críticas.
- Rate limits para convites e autenticação.
- Remoção do modelo legado `panel_users`.
- Revisão de índices, logs, backups e testes de regressão.

## Critério de conclusão

A etapa SaaS estará concluída quando o `ROOT` conseguir criar uma empresa e convidar seu `OWNER`; o proprietário conseguir convidar membros e configurar funções; um usuário conseguir alternar entre empresas; todas as ações existentes forem protegidas por permissão no backend; e a suíte provar que nenhum dado ou operação atravessa os limites do workspace.

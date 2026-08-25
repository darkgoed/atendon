# Papéis PostgreSQL e rotação de credenciais

Este runbook separa o bootstrap administrativo, ownership de schema, migrations
e runtime da API/worker. Ele não ativa RLS.

## Papéis e invariantes

- `POSTGRES_USER`: bootstrap administrativo do servidor; nunca entra no ambiente
  da API ou do worker.
- `ATENDON_OWNER_DB_ROLE` (`atendon_owner`): role `NOLOGIN` que possui banco,
  schema e objetos.
- `ATENDON_MIGRATION_DB_USER` (`atendon_migration`): login sem atributos
  administrativos, membro `NOINHERIT` da owner. O runner faz `SET ROLE` de forma
  explícita e cria os objetos como owner.
- `ATENDON_RUNTIME_DB_USER` (`atendon_app`): login sem membership na owner, com
  somente `CONNECT`, `USAGE`, DML em tabelas e uso de sequências.

Owner, migration e runtime devem permanecer sem `SUPERUSER`, `CREATEDB`,
`CREATEROLE`, `REPLICATION` e `BYPASSRLS`. A role de runtime não pode possuir
banco, schema, tabelas, sequências, views ou funções.

`DATABASE_URL` pertence exclusivamente à API/worker. O arquivo `.env` não pode
conter `POSTGRES_*`, `ATENDON_*`, `MIGRATION_DATABASE_URL`,
`DATABASE_OWNER_ROLE` ou `TEST_DATABASE_URL`. O loader runtime interpreta
`.env` em memória isolada e filtra essas chaves antes de copiar qualquer valor
para `process.env`.

Somente o processo `npm run migrate -w @atendon/backend` recebe
`MIGRATION_DATABASE_URL` e `DATABASE_OWNER_ROLE`, por variáveis já injetadas ou
pelo overlay `.env.migration`. Em produção não existe fallback para
`DATABASE_URL`.
Em development/test, a ausência das duas variáveis preserva temporariamente o
runner legado com `DATABASE_URL` e sem `SET ROLE`; essa compatibilidade não é
aceita quando `NODE_ENV=production`.

O controlador de testes fica em `.env.test` (`0600`), criado a partir de
`.env.test.example`. Ele pode criar e remover somente bancos descartáveis de
teste e não deve ser anexado ao ambiente da API, worker ou migration de
produção. Valide a separação com:

```bash
rtk npm run test:db:check -w @atendon/backend
rtk npm run test:disposable -w @atendon/backend
```

## Provisionar uma instalação nova ou volume existente

Antes de alterar roles em instalação existente:

1. gere backup consistente;
2. restaure e valide o backup em banco isolado;
3. preserve a relação de sessões atualmente conectadas;
4. configure senhas aleatórias diferentes para migration e runtime.

Mantenha no `.env` runtime somente:

```dotenv
DATABASE_RUNTIME_ROLE=atendon_app
DATABASE_URL=postgresql://atendon_app:<senha-url-encoded>@localhost:5436/atendon
```

Crie o arquivo ignorado `.env.migration` a partir de
`.env.migration.example`, substitua todos os placeholders e restrinja suas
permissões antes de usá-lo:

```bash
rtk cp .env.migration.example .env.migration
rtk chmod 0600 .env.migration
```

Seu conteúdo de infraestrutura inclui:

```dotenv
POSTGRES_DB=atendon
POSTGRES_USER=<bootstrap-admin>
POSTGRES_PASSWORD=<segredo-bootstrap>
ATENDON_OWNER_DB_ROLE=atendon_owner
ATENDON_MIGRATION_DB_USER=atendon_migration
ATENDON_MIGRATION_DB_PASSWORD=<segredo-aleatorio-migration>
ATENDON_RUNTIME_DB_USER=atendon_app
ATENDON_RUNTIME_DB_PASSWORD=<segredo-aleatorio-runtime>
MIGRATION_DATABASE_URL=postgresql://atendon_migration:<senha-url-encoded>@localhost:5436/atendon
DATABASE_OWNER_ROLE=atendon_owner
```

O entrypoint de migration recusa `.env.migration` acessível por grupo/outros.
Quando um secret manager injeta as variáveis diretamente, o arquivo pode não
existir.

Recrie somente o contêiner PostgreSQL passando os dois arquivos de interpolação;
o segundo é o overlay de infraestrutura. O volume não é removido:

```bash
rtk docker compose --env-file .env --env-file .env.migration \
  up -d --force-recreate postgres
rtk docker compose --env-file .env --env-file .env.migration \
  exec -T postgres \
  sh /docker-entrypoint-initdb.d/20-provision-atendon-roles.sh
```

O script converte automaticamente `POSTGRES_USER`/`POSTGRES_PASSWORD` do
contêiner para `PGUSER`/`PGPASSWORD`; não é necessário exportá-los manualmente.
Se a execução ocorrer fora do Compose, forneça `PGUSER`/`PGPASSWORD`
explicitamente (eles têm precedência), além de `POSTGRES_DB` e das variáveis
`ATENDON_*`.

O provisionador é idempotente. Ele:

- cria ou endurece as três roles;
- troca as senhas dos logins;
- transfere ownership de objetos públicos existentes para a owner;
- revoga acesso público ao banco/schema;
- reaplica grants atuais e default privileges futuros.

Valide antes de reiniciar API/worker:

```sql
SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
       rolreplication,rolbypassrls
FROM pg_roles
WHERE rolname IN ('atendon_owner','atendon_migration','atendon_app');

SELECT current_database(),current_user;
```

Execute migrations em um processo isolado. Ele carrega `.env` como base e
`.env.migration` como overlay privado:

```bash
rtk npm run migrate -w @atendon/backend
```

API e worker nunca devem receber `--env-file .env.migration`, nem o conteúdo
equivalente por secret manager. Reinicie-os somente com `.env` e
`DATABASE_URL` da role runtime.

## Rotação coordenada

### Runtime

1. congele deploys e drene/pare API e worker;
2. altere `ATENDON_RUNTIME_DB_PASSWORD` e a senha URL-encoded em `DATABASE_URL`;
3. recrie somente o contêiner PostgreSQL com
   `docker compose --env-file .env --env-file .env.migration`;
4. execute novamente o provisionador;
5. reinicie API/worker e valide `/ready`;
6. confirme em `pg_stat_activity` que conexões antigas desapareceram.

O provisionador troca a senha antes do restart dos consumidores; por isso a
parada/drenagem evita uma janela de autenticação inconsistente.

### Migration

1. confirme que nenhuma migration está em execução;
2. altere `ATENDON_MIGRATION_DB_PASSWORD` e `MIGRATION_DATABASE_URL`;
3. recrie somente o contêiner PostgreSQL e execute o provisionador, em ambos os
   comandos com `docker compose --env-file .env --env-file .env.migration`;
4. rode uma migration no-op/verificação do ledger pelo entrypoint de migration;
5. retire imediatamente `MIGRATION_DATABASE_URL` dos ambientes onde não será
   usada.

Para rotação sem reutilizar nomes, provisione novos nomes de login, atualize as
URLs, drene as conexões antigas e só então revogue `CONNECT` e remova os logins
anteriores. Mantenha a owner `NOLOGIN` estável para evitar transferência
desnecessária de ownership.

## Verificação negativa obrigatória

Conectado como runtime, todos estes comandos devem falhar com
`insufficient_privilege`:

```sql
CREATE ROLE forbidden;
CREATE DATABASE forbidden;
CREATE TABLE public.forbidden(id integer);
ALTER ROLE atendon_app SUPERUSER;
SET ROLE atendon_owner;
```

A integração automatizada equivalente usa banco e roles com nomes UUID e os
remove ao final:

```bash
rtk npm test -w @atendon/backend -- tests/postgres-roles.integration.test.ts
```

## Rollback

Rollback de aplicação não deve devolver credenciais administrativas ao runtime.
Se a nova role falhar:

1. preserve logs sanitizados e a saída de `/ready`;
2. restaure temporariamente a senha anterior da mesma role runtime restrita;
3. reexecute o provisionador;
4. reinicie os consumidores;
5. investigue grants ausentes antes de qualquer nova expansão.

Nunca faça rollback apontando `DATABASE_URL` para `POSTGRES_USER`, para a role
owner ou para o login de migration.

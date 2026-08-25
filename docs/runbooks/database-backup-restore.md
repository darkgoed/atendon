# Backup e restore verificável do AtendON

Este procedimento cobre o PostgreSQL principal apontado por
`MIGRATION_DATABASE_URL`, assumindo temporariamente `DATABASE_OWNER_ROLE`.
Ele não altera o banco de origem. O restore sempre cria um banco novo com nome
descartável estritamente validado.

## Pré-requisitos

- `pg_dump` e `pg_restore` da mesma major version do servidor, ou mais novos;
- acesso de leitura ao banco de origem;
- usuário administrativo capaz de criar um banco apenas no servidor de
  verificação;
- diretório absoluto, dedicado e protegido para dumps e relatórios;
- espaço livre superior ao tamanho atual do banco.

Confirme as versões antes da janela:

```bash
pg_dump --version
pg_restore --version
psql "$DATABASE_URL" -Atc 'show server_version'
```

Neste ambiente, o servidor do Compose é PostgreSQL 16. O cliente 14 instalado no
host não consegue gerar dumps dele. O `build.sh` usa por padrão os wrappers
`deploy/postgres/pg-dump-compose.sh` e
`deploy/postgres/pg-restore-compose.sh`, que executam os clientes 16 dentro do
serviço PostgreSQL. Para um banco externo, configure `PG_DUMP_BIN` e
`PG_RESTORE_BIN` com binários compatíveis. Não prossiga ignorando mismatch de
versão.

## Gerar o backup

O comando exige um diretório absoluto explícito. Ele carrega `.env.migration`
privado (`0600`), conecta com a role de migration e usa `SET ROLE`/`--role` da
owner para que RLS não torne o dump silenciosamente incompleto. A URL nunca é
passada na linha de comando do `pg_dump`.

```bash
umask 077
backup_dir=/var/backups/atendon/postgresql/2026-07-25
mkdir -p "$backup_dir"

npm run backup:database -w @atendon/backend -- \
  --output-dir "$backup_dir"
```

Para usar outra variável ou um binário versionado:

```bash
npm run backup:database -w @atendon/backend -- \
  --output-dir "$backup_dir" \
  --database-env MIGRATION_DATABASE_URL \
  --pg-dump /usr/lib/postgresql/16/bin/pg_dump
```

Não use `DATABASE_URL` da role runtime em produção: uma policy RLS pode ocultar
linhas do backup. O backup abre uma transação `REPEATABLE READ READ ONLY`,
assume a owner, exporta o snapshot e executa
`pg_dump --format=custom --no-owner --no-acl --role=<owner>` contra o mesmo
snapshot.
São produzidos:

- `*.dump`, modo `0600`;
- `*.manifest.json`, modo `0600`, contendo SHA-256, timestamp, versão do deploy,
  última migration e contagens agregadas de tabelas críticas.

O manifesto não contém URL, usuário, senha, tokens, telefones, mensagens nem
qualquer conteúdo de linha. Preserve dump e manifesto juntos, preferencialmente
em armazenamento criptografado, imutável e fora do host.

## Verificar o restore

Nunca use `DATABASE_URL` como URL administrativa. Configure
`RESTORE_ADMIN_DATABASE_URL` em `.env.migration` apontando para o banco
administrativo `postgres`. No Compose local, quando essa URL não é informada, o
verificador a monta somente em memória a partir de `POSTGRES_USER`,
`POSTGRES_PASSWORD` e do host/porta de `MIGRATION_DATABASE_URL`; essas
credenciais privadas nunca são carregadas pela API/worker nem gravadas no
relatório.

```bash
export RESTORE_ADMIN_DATABASE_URL='postgresql://usuario:senha@host-seguro:5432/postgres'
restore_database="atendon_restore_verify_$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]')"
report_file="$backup_dir/${restore_database}.report.json"

npm run restore:verify -w @atendon/backend -- \
  --manifest "$backup_dir/atendon-atendon-20260725T120000000Z.manifest.json" \
  --target-database "$restore_database" \
  --report-file "$report_file" \
  --cleanup \
  --confirm-drop "$restore_database" \
  --pg-restore /usr/lib/postgresql/16/bin/pg_restore
```

O nome aceito é somente
`atendon_restore_verify_` seguido de 32 caracteres hexadecimais minúsculos. O
verificador:

1. valida nome descartável, confirmação exata, source diferente do target,
   manifesto, tamanho e SHA-256 antes de criar qualquer banco;
2. recusa target preexistente e nunca sobrescreve banco;
3. cria o target exato usando `template0`;
4. restaura com `--no-owner --no-acl --exit-on-error`;
5. compara última migration, quantidade de migrations e contagens críticas;
6. exige zero constraints inválidas e zero FKs inválidas;
7. grava relatório JSON sem credenciais;
8. com `--cleanup`, remove apenas o banco criado nesta execução e somente quando
   `--confirm-drop` coincide exatamente.

Sem `--cleanup`, o banco permanece para inspeção. `--confirm-drop` isolado é
rejeitado. Em falha após a criação, o cleanup só ocorre se ambos os parâmetros
seguros tiverem sido fornecidos; caso contrário, preserve o target e faça a
remoção manual após investigação.

Critério de aceite antes de migration/deploy:

- comando termina com `status: verified`;
- `success` é `true` no relatório;
- migration esperada e restaurada coincidem;
- todas as contagens têm `matches: true`;
- `invalid` e `invalidForeignKeys` são zero;
- o dump e o relatório não contêm a senha da conexão.

## Teste automatizado real

```bash
npm test -w @atendon/backend -- tests/database-backup.test.ts
```

O teste usa somente bancos temporários com UUID: cria uma origem descartável,
aplica migrations, gera o backup, restaura, verifica e remove os nomes exatos.
Ele nunca aponta para produção.

## Evolution, Redis e volumes

`DATABASE_URL` cobre somente o PostgreSQL do AtendON. No Compose, a Evolution usa
outro servidor/banco (`evolution-postgres`, banco `evolution`) e mantém estado
adicional no volume `atendon_evolution_instances`. Esses dados não fazem parte
do dump principal.

Antes de um deploy que exija ponto de retorno completo:

1. gere um dump custom separado do banco `evolution` usando `pg_dump` compatível
   dentro da rede/contêiner da Evolution;
2. pare apenas `evolution-api` durante a cópia do volume de instâncias para
   impedir alteração concorrente;
3. arquive `atendon_evolution_instances` em armazenamento criptografado;
4. registre imagem/tag da Evolution e checksum dos dois artefatos;
5. restaure ambos em stack isolada e valide conexão de uma instância de teste
   sem apontar webhook para produção.

O Redis/BullMQ é infraestrutura de fila/cache, não substitui PostgreSQL como
fonte de verdade. Ainda assim, quando a política de recuperação exigir estado de
fila, force e confirme persistência, pare consumidores e copie separadamente o
volume `atendon_redis`. Nunca trate o dump PostgreSQL como backup desses volumes.

Não arquive o volume PostgreSQL bruto enquanto o servidor estiver em execução.
Para PostgreSQL, prefira sempre o dump lógico consistente descrito acima ou uma
solução física própria com suporte a WAL.

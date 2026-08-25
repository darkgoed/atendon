# Observabilidade PostgreSQL e filas

Este runbook habilita `pg_stat_statements` no PostgreSQL controlado pelo
`docker-compose.yml`. Ele não altera feature flags nem executa rollout.

## Mudança que exige reinício

`shared_preload_libraries=pg_stat_statements` só passa a valer após reiniciar o
processo PostgreSQL. Para um volume existente, programe uma janela curta e faça:

```bash
rtk docker compose --env-file .env --env-file .env.migration up -d --force-recreate postgres
rtk docker compose --env-file .env --env-file .env.migration exec postgres \
  psql --set=ON_ERROR_STOP=1 --dbname "$POSTGRES_DB" \
  --command "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
```

Depois, reaplique o provisionamento de roles para conferir privilégios e
ownership sem modificar objetos da extensão:

```bash
rtk docker compose --env-file .env --env-file .env.migration exec postgres \
  /docker-entrypoint-initdb.d/20-provision-atendon-roles.sh
```

Valide sem expor texto ou parâmetros de queries:

```sql
SELECT extname FROM pg_extension WHERE extname='pg_stat_statements';
SELECT count(*) FROM pg_stat_statements;
SELECT application_name,state,count(*)
FROM pg_stat_activity
WHERE datname=current_database()
GROUP BY application_name,state;
```

## Leitura operacional

O endpoint `GET /root/operations/metrics` exige sessão ROOT e responde com
`Cache-Control: no-store`. Ele inclui:

- pool usado/ocioso/em espera e espera p95/p99 do processo API;
- duração p95/p99 de statements e transações, além da transação ativa mais antiga;
- conexões PostgreSQL separadas por `atendon-api`, `atendon-worker` e
  `atendon-migration`;
- deadlocks e tamanhos de uma allowlist fixa de tabelas/índices;
- estatísticas agregadas do `pg_stat_statements` por `queryid`, sem texto SQL;
- lag, idade, estados e throughput de filas e outboxes;
- conexões SSE, catch-ups e falhas PostgreSQL/Redis do realtime.

Nenhuma label contém tenant, conversa, telefone, e-mail, URL, conteúdo ou texto
SQL. Histogramas em memória reiniciam junto com o processo; contagens de
BullMQ, outboxes e PostgreSQL permanecem nas fontes duráveis.

## Valores iniciais e alertas

Os timeouts continuam conservadores e configuráveis:

- conexão: `DATABASE_CONNECTION_TIMEOUT_MS`;
- ociosidade do pool: `DATABASE_IDLE_TIMEOUT_MS`;
- statement: `DATABASE_STATEMENT_TIMEOUT_MS`;
- lock: `DATABASE_LOCK_TIMEOUT_MS`;
- transação ociosa: `DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`.

Comece alertando, sem ajustar limites automaticamente, para:

- `pool.waiting > 0` sustentado ou pool wait p99 próximo do timeout de conexão;
- transação ativa mais velha que o timeout de transação ociosa;
- aumento de `deadlocks`;
- fila sem worker, jobs falhos ou idade do item mais antigo acima do SLO;
- outbox `processing` além do lease ou estados `failed`/`uncertain`;
- falhas `postgres_listener`/`redis_*` e crescimento de catch-ups SSE.

## Rollback

Se a extensão causar regressão, remova apenas os argumentos
`shared_preload_libraries`, `pg_stat_statements.track` e `track_io_timing` do
serviço PostgreSQL e recrie o container na janela planejada. Não é necessário
dropar a extensão para interromper a coleta.

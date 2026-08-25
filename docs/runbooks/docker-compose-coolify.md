# Docker Compose e Coolify

Este arquivo cobre somente o runtime containerizado preparado para o cutover. Enquanto o cutover não for aprovado, mantenha os processos atuais, `ecosystem.config.js`, `deploy/start-panel.sh` e as unidades systemd como estão. Não execute `build.sh` apenas para validar esta mudança: ele é o deploy real e alcança banco e containers configurados no ambiente.

## Contrato do stack

- `atendon-api` escuta `0.0.0.0:3110` somente com `CONTAINER_RUNTIME=true`.
- `atendon-worker` executa o mesmo backend em processo separado.
- `atendon-panel` escuta `0.0.0.0:3200` e usa `http://atendon-api:3110` no proxy server-side; o navegador continua usando `/api`.
- API e worker usam `postgres:5432`, `redis:6379` e `evolution-api:8080` pela rede do Compose.
- Portas publicadas no host usam loopback por padrão. O proxy do Coolify deve apontar para a porta interna `3200` do serviço `atendon-panel`.

Os volumes são declarados com `external: true`, têm nomes físicos fixos e adotam os dados existentes sem cópia, inclusive quando o Coolify usa seu UUID como nome do projeto Compose:

| Chave Compose | Nome físico preservado |
|---|---|
| `atendon_postgres` | `atendon_atendon_postgres` |
| `atendon_redis` | `atendon_atendon_redis` |
| `atendon_evolution_postgres` | `atendon_atendon_evolution_postgres` |
| `atendon_evolution_instances` | `atendon_atendon_evolution_instances` |

Não renomeie, remova ou peça ao Coolify para recriar esses volumes. O deploy deve falhar fechado se qualquer volume externo não existir. Os scripts de inicialização do PostgreSQL só atuam em volume vazio.

Antes de iniciar API e worker, o Compose executa dois jobs one-shot idempotentes:

1. `database-provision` cria/atualiza as roles separadas de owner, migration e runtime usando a credencial bootstrap do PostgreSQL.
2. `database-migrate` aplica somente migrations forward-only com a role de migration e encerra com sucesso.

API e worker dependem de `database-migrate` com `service_completed_successfully`; portanto, uma falha de provisionamento ou migration impede a substituição da aplicação saudável.

## Variáveis e validação local

Copie `.env.example` para `.env`, mantenha o arquivo fora do Git, substitua todos os placeholders por valores fortes e URL-encode a senha usada dentro das URLs PostgreSQL. Em runtime de Compose, defina no mínimo as variáveis exigidas com `${VAR:?}` no arquivo `docker-compose.yml`, além de:

- `APP_VERSION` e um `DEPLOY_VERSION` imutável;
- `PANEL_ORIGIN` e `PANEL_PUBLIC_URL` públicos com HTTPS;
- as credenciais opcionais das integrações efetivamente habilitadas.

Validação sem iniciar serviços:

```bash
docker compose config --quiet
bash -n build.sh
npm run test:deploy
```

Para um stack local novo, depois de preencher `.env`:

```bash
docker compose build evolution-api atendon-api atendon-worker atendon-panel
docker compose up -d --wait
docker compose ps
```

Não use `down -v`: a opção `-v` remove volumes e é incompatível com a preservação de dados.

## Deploy e rollback

`build.sh` mantém `flock` e executa instalação determinística, isolamento/migration de teste, lint, typecheck, testes, E2E, builds locais e das imagens. Só depois valida as imagens candidatas. Em seguida cria backup, comprova um restore real em banco descartável, ativa manutenção, aplica migrations forward-only, executa `provision:tripz` e `snapshot:deploy`, e troca o stack com `docker compose up --wait`.

Se a troca ou os healthchecks falharem, o script retagueia os IDs das imagens anteriores e recria o conjunto anterior de containers. Migrations são forward-only: o rollback não restaura automaticamente o banco de produção. O backup e o relatório de restore ficam em `.deploy-state/` (ou nos diretórios configurados por `ATENDON_DEPLOY_STATE_DIR` e `ATENDON_BACKUP_DIR`).

O bump de changelog/versão é opt-in com `ATENDON_BUMP_VERSION=1`; o fluxo não executa commit nem push. Para uma tag fornecida pelo pipeline/Coolify, use `ATENDON_DEPLOY_VERSION`.

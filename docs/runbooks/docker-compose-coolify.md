# Docker Compose e Coolify

## Política vigente de produção

O deploy oficial do AtendON é feito exclusivamente pelo Coolify, a partir do repositório Git configurado no recurso `luaj67tqgrdsjlvdjrt9x3ot`. Alterações locais só chegam à produção depois de commit/merge no branch acompanhado pelo Coolify e de um deployment concluído pelo próprio Coolify.

Não execute `./build.sh`, `docker compose up`, recriação de containers ou migrations diretamente no host como procedimento de deploy. O `build.sh` é um fluxo legado/emergencial que altera banco e containers fora do controle do Coolify; seu uso pode deixar o schema registrado no banco incompatível com o commit que o Coolify implanta. Ele só pode ser usado com autorização operacional explícita e um plano documentado de reconciliação com o Coolify.

Para validação local sem publicação, use os comandos `npm run test`, `npm run typecheck`, `npm run lint` e `npm run build` conforme o escopo da mudança. Esses comandos não substituem o deployment do Coolify.

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

O fluxo oficial é: validar em checkout limpo, integrar a mudança ao branch Git acompanhado pelo Coolify, iniciar o deployment pelo Coolify e verificar o deployment UUID, o job `database-migrate`, os healthchecks e o commit efetivamente implantado.

O `build.sh` permanece no repositório apenas como ferramenta legada/emergencial. Ele mantém `flock` e executa instalação, testes, builds, backup/restore, migrations e troca direta do stack com `docker compose up --wait`; por isso, não é um comando de validação nem o mecanismo normal de publicação.

Se a troca ou os healthchecks falharem, o script retagueia os IDs das imagens anteriores e recria o conjunto anterior de containers. Migrations são forward-only: o rollback não restaura automaticamente o banco de produção. O backup e o relatório de restore ficam em `.deploy-state/` (ou nos diretórios configurados por `ATENDON_DEPLOY_STATE_DIR` e `ATENDON_BACKUP_DIR`).

### Release de versão e changelog

**Fluxo atual (detalhado em `docs/RELEASE_FLOW.md`)**: fonte primária é a tabela
`releases` no banco; `package.json.version` é derivado e `changelog.json` é legado.
O único comando é **commit do código → `npm run release:prepare` (host ops, com
`DATABASE_URL` do alvo) → revisar → commit `chore: release vX.Y.Z` → push → Coolify**.
O script grava build/classificação (PATCH/DROP/RELEASE por impacto, não por tamanho
de diff) e **não chama IA**: o worker gera o changelog público depois, fora do
caminho crítico do deploy, com a chave OpenRouter criptografada no banco
(editável em ROOT > /root/versions). Falha de IA registra status/erro visíveis e
permite retry; nunca bloqueia o deploy. Nenhuma geração ou Git ocorre dentro de
Dockerfiles/Coolify.

No painel do Coolify, defina para a aplicação Compose (Environment Variables):

- `APP_VERSION`: versão semântica publicada, igual ao `current` do changelog
  (por exemplo `1.22.0`);
- `DEPLOY_VERSION`: identificador imutável do deploy, preferencialmente o SHA do
  commit ou uma tag (por exemplo `a1b2c3d` ou `v1.22.0`).

Essas variáveis são compartilhadas por API e worker. Se `APP_VERSION` não for
definida, o backend usa `changelog.json.current` e, na ausência do arquivo,
`package.json.version`; `DEPLOY_VERSION` usa `development` apenas como fallback
local seguro. Recomenda-se sempre configurar ambos no Coolify para que a imagem
e o runtime identifiquem exatamente o release implantado.

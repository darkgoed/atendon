# Fluxo de Release e Changelog (pós-refactor)

Este documento substitui a seção "Release de versão e changelog" de
`docs/runbooks/docker-compose-coolify.md` e descreve o pipeline vigente.

## Arquitetura

- **Fonte primária de versão**: tabela `releases` (PostgreSQL). Cada linha é um
  build: `build_number` (sequencial, incremental por deploy), `version`
  (SemVer comercial MAJOR.MINOR.PATCH), `classification` (PATCH/DROP/RELEASE),
  `commit_sha`, `branch`, `+adições/-remoções`, `files_changed`,
  `modules_affected`, `scope` (GLOBAL/TENANT), `tenant_slugs_detected`,
  `technical_changelog`, `public_title/summary/changes`, `ai_status/error`,
  `published`.
- **`package.json.version`** é apenas representação derivada: o script de
  release grava nela o valor calculado, mas nunca é consultado como fonte.
- **`changelog.json`** é legado: só existe para compatibilidade e não é mais
  escrito. O histórico foi migrado pela migration `0160`.
- **Classificação por impacto, não por tamanho**: novos módulos, rotas ou
  páginas novas, migrations destrutivas ou `BREAKING CHANGE` em commit →
  RELEASE; rotas/páginas novas dentro de módulo existente, migration aditiva
  ou mudança em ≥3 módulos com crescimento → DROP; caso contrário PATCH.
  Lockfiles, `dist/`, `.next/`, `graphify-out/`, logs, `data/`, baselines de
  QA e artefatos gerados são excluídos do diff antes da análise. Override
  manual: `RELEASE_CLASSIFICATION_OVERRIDE=PATCH|DROP|RELEASE` (o legado
  `VERSION_BUMP=patch|minor|major` continua aceito como alias).
- **IA fora do caminho crítico**: o deploy grava a release técnica e termina.
  O worker do backend roda `reconcileChangelogAiGeneration()` (a cada 2 min,
  `CHANGELOG_AI_RECONCILIATION_INTERVAL_MS`) e gera título, resumo e 1–6 itens
  em pt-BR via OpenRouter usando a chave criptografada no banco
  (`changelog_ai_settings`, editável em ROOT > /root/versions). Falha registra
  `ai_status='failed'` + `ai_error` visíveis e é retentada (3 tentativas,
  backoff de 5 min); nunca bloqueia nem derruba o deploy. Botão "Regenerar
  com IA" em /root/versions força nova tentativa.
- **Multi-tenant**: cada item público carrega `tenant_slugs`; slugs só são
  aceitos se o diff realmente os tocou (`tenant_slugs_detected`, comprovados
  contra a tabela `tenants` — nunca inferidos de texto livre). Usuários comuns
  veem releases globais ou do próprio tenant (em `/changelog` e no banner de
  novidades); ROOT vê tudo em `/root/versions`.

## Fluxo operacional (oficial = Coolify)

1. **Commit do código** em checkout limpo do monorepo (escopo `apps/atendon`).
2. **Preparar a release** (host ops, uma vez por release):
   `npm run release:prepare`
   - Exige checkout limpo; grava a release técnica no banco (`releases`),
     bumpa `package.json`/`package-lock.json`, imprime build/classificação.
     Não chama IA. Requer `DATABASE_URL` apontando para o banco de produção
     (ou de staging, conforme o alvo do release).
   - Alternativa CI/host remoto: `RELEASE_ROOT=<dir> DATABASE_URL=… npm run release:prepare`.
3. **Revisar** (`SELECT version,classification,technical_changelog FROM releases ORDER BY build_number DESC LIMIT 1;`) e **commitar** `package.json` + `package-lock.json` num commit `chore: release vX.Y.Z`.
4. **Push** para `main` → Coolify deploya (build das imagens, migrations via job `database-migrate`, troca do stack). Nenhum Dockerfile executa git, IA ou o gerador.
5. **Pós-deploy (automático)**: o worker encontra a release com `ai_status='pending'`, gera o changelog público com IA e publica (se `auto_publish_enabled`; caso contrário, ROOT publica em /root/versions).

O `build.sh` permanece apenas como fluxo legado/emergencial;
`ATENDON_BUMP_VERSION=1` agora chama o mesmo `release-record.mjs` (sem IA).

## Variáveis e configurações

| Item | Onde | Observação |
|---|---|---|
| `DATABASE_URL` | host ops (release:prepare) | Usada pelo script para gravar a release |
| `APP_VERSION` / `DEPLOY_VERSION` | Coolify (Environment Variables) | Inalterado; `DEPLOY_VERSION` imutável (SHA/tag) |
| API key OpenRouter de changelog | Painel ROOT > /root/versions > "Configuração de IA" | Criptografada (AES-256-GCM com `DATA_ENCRYPTION_KEY`), nunca exposta ao frontend |
| Modelo principal / fallback | idem | `openai/gpt-oss-120b` por padrão |
| `auto_generate_enabled` / `auto_publish_enabled` | idem | Toggles de geração/publicação automática |
| `CHANGELOG_AI_RECONCILIATION_INTERVAL_MS` | opcional, Coolify | Default 120000 |
| `RELEASE_CLASSIFICATION_OVERRIDE` | opcional, host ops | Força PATCH/DROP/RELEASE num release pontual |

## Endpoints

- `GET /panel/version` — versão + `buildNumber` + changelog filtrado por tenant (painel).
- `GET /panel/versions` — changelog público paginado (global + próprio tenant).
- `GET /root/versions[?tenantSlug=]`, `GET /root/versions/:id` — ROOT: histórico completo.
- `PATCH /root/versions/:id` — edição (registra override manual + autor).
- `POST /root/versions/:id/publish|unpublish|regenerate` — publicação e regeneração.
- `GET|PUT /root/settings/changelog-ai` — configuração de IA (chave nunca retorna).

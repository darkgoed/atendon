# SPEC: Changelog funcionando na infra Coolify

## Objective

Fazer o sistema de changelog/versão voltar a refletir a versão realmente
implantada quando o deploy é feito pelo Coolify, em vez de depender do
`build.sh`.

## Source

comments.md L107: "Sistema de changelog com a nova infra utilizando coolify não
esta funcionando"

## Current State

- Artefato versionado: `/var/www/apps/atendon/changelog.json`
  - `current` = `1.21.0` (`changelog.json:2`)
  - histórico em ordem decrescente com `version`, `date`, `changes`, `commit`
- Gerador: `scripts/changelog-bump.mjs`
  - resolve a raiz pelo caminho físico do próprio script, não pelo `cwd`
    (`:9-11`) — portanto NÃO é sensível ao diretório de execução
  - lê `package.json` e `changelog.json` (`:241-245`)
  - depende de `git rev-parse HEAD` e `git diff` — precisa de histórico git
- Quem invoca o gerador: **apenas o `build.sh`**
  - `build.sh:238` — `node --env-file="${ROOT_DIR}/.env" scripts/changelog-bump.mjs`
  - `build.sh:240` — fallback sem `--env-file`
  - `package.json:11` — script `version:bump`
- Backend: `apps/backend/src/modules/root/version.ts:47` — `getVersionInfo()`,
  exposto em `apps/backend/src/app.ts` (import na linha 29) via rota
  `/panel/version`.
- Painel: `components/version-banner.tsx` consome `/panel/version`.
- Variáveis: `APP_VERSION` e `DEPLOY_VERSION` (`build.sh:21,23,105-106`).

HIPÓTESES TESTADAS E DESCARTADAS pela investigação:
- "changelog.json não é copiado para a imagem" → **FALSO**.
  `deploy/docker/api.Dockerfile:24` e `deploy/docker/worker.Dockerfile:24` fazem
  `COPY --chown=node:node package.json package-lock.json changelog.json ./`.
  O `build.sh:153-155` inclusive valida a presença do arquivo na imagem.
  O painel não precisa do arquivo (consulta o backend).
- "path relativo ao cwd" → **FALSO**: o gerador resolve pelo caminho do script.

CAUSA RAIZ: o Coolify constrói as imagens diretamente a partir do repositório;
ele **nunca executa `scripts/changelog-bump.mjs`**, porque essa chamada só existe
dentro do `build.sh`, que não faz parte do fluxo do Coolify. Consequências:
1. `changelog.json` fica congelado na última versão gerada manualmente;
2. `APP_VERSION` / `DEPLOY_VERSION` não são definidas no ambiente do Coolify,
   então o backend reporta versão vazia ou default.

## Desired Behavior

Após um deploy pelo Coolify, `/panel/version` reporta a versão correta e o
banner de versão do painel exibe o changelog atualizado, sem depender de alguém
rodar `build.sh` à mão.

## Requirements

### R1 — Bump do changelog fora do build da imagem

Description: a geração do changelog é um passo de repositório (pré-deploy),
executado com git disponível, produzindo um `changelog.json` versionado e
commitado. NÃO se tenta gerar o changelog dentro do estágio de build da imagem.

Acceptance Criteria:
- Existe um comando documentado e único para o bump (o já existente
  `npm run version:bump`), e a documentação do fluxo Coolify diz explicitamente:
  bump → commit → push no branch acompanhado → Coolify constrói.
- `changelog.json` continua sendo o artefato versionado lido em runtime.
- Nenhum Dockerfile passa a executar `git` ou o gerador durante o build.

Verification: inspeção dos Dockerfiles (nenhuma invocação nova) + doc presente.

### R2 — Versão explícita no ambiente do Coolify

Description: `APP_VERSION` e `DEPLOY_VERSION` passam a ser definidas de forma
explícita e determinística no ambiente do Coolify.

Acceptance Criteria:
- `docker-compose.yml` declara `APP_VERSION` e `DEPLOY_VERSION` para os serviços
  de API e worker, com valores vindos do ambiente (com default seguro).
- Quando `APP_VERSION` não é fornecida, o backend faz fallback para o campo
  `current` do `changelog.json` — nunca para string vazia.
- `DEPLOY_VERSION` identifica imutavelmente o deploy (commit SHA ou tag).

Verification: teste unitário de `getVersionInfo()` cobrindo os três casos
(env presente / env ausente com changelog / ambos ausentes).

### R3 — `getVersionInfo` resiliente

Description: a leitura do changelog em runtime não pode derrubar nem ficar muda
em ambiente containerizado.

Acceptance Criteria:
- Se `changelog.json` não for encontrado, `getVersionInfo()` retorna estrutura
  válida com a versão do `package.json` e histórico vazio, e registra um log de
  aviso (não lança).
- O caminho do arquivo é resolvido de forma independente do `cwd` do processo.
- A resposta de `/panel/version` mantém o mesmo shape atual (`version`,
  `deployVersion`, histórico) — nenhum contrato quebrado com o painel.

Verification: `apps/backend/tests/version.test.ts` estendido; o teste atual já
afirma as propriedades `version` e `deployVersion`.

### R4 — Banner do painel exibe a versão implantada

Description: o painel mostra a versão real do deploy.

Acceptance Criteria:
- `components/version-banner.tsx` exibe a versão retornada por `/panel/version`.
- Quando o backend não conhece a versão, o banner não exibe string vazia nem
  "undefined" — exibe um estado neutro.
- `apps/panel/tests/version-banner.test.ts` continua passando (ajustado se o
  estado neutro for novo).

Verification: `npx vitest run` no painel.

## Invariants

- O shape da resposta `/panel/version` não muda.
- `changelog.json` permanece versionado no git (não é gerado em runtime).
- Nenhuma alteração é feita em `build.sh` que o torne o caminho oficial de
  produção — o fluxo oficial é o Coolify.

## Edge Cases

- Deploy sem `.git` disponível (dentro do container) → nada depende de git em
  runtime.
- `changelog.json` presente mas com JSON inválido → log de erro + fallback, sem
  crash do processo.
- Primeira subida sem `APP_VERSION` definida no Coolify → fallback do R2.
- Worker e API devem reportar a mesma versão.

## Dependencies

Nenhuma no código de aplicação. Requer que o usuário defina as variáveis no
painel do Coolify (documentar; não há como fazê-lo por código).

## Affected Areas

- apps/backend/src/modules/root/version.ts
- apps/backend/src/config.ts
- docker-compose.yml
- apps/panel/components/version-banner.tsx (somente se o estado neutro for novo)
- docs/ (documentação do fluxo de release no Coolify)

## Non-goals

- Trocar o mecanismo de changelog por outro (ex.: changesets).
- Automatizar o bump dentro do Coolify.
- Alterar o `build.sh` para virar o caminho oficial.

## Constraints

- Backend sem `vitest.config.ts`: testes exigem `DATABASE_URL` e
  `PANEL_SEED_PASSWORD` (>=8 chars) no ambiente.
- Não quebrar o `build.sh` existente para quem ainda o usa localmente.

## Required Tests

- `apps/backend/tests/version.test.ts` estendido: env presente; env ausente com
  changelog; changelog ausente; changelog inválido.
- `apps/panel/tests/version-banner.test.ts`: estado neutro quando a versão é
  desconhecida.

## Definition of Done

- [ ] R1..R4 atendidos e verificados
- [ ] `npm run typecheck` (backend) 0 erros
- [ ] Testes de version passando com env dummy
- [ ] `npx vitest run` (painel) exit 0
- [ ] Documentação do fluxo de release no Coolify escrita, incluindo as
      variáveis que o usuário precisa definir no painel do Coolify
- [ ] Nenhum Dockerfile executa git ou o gerador

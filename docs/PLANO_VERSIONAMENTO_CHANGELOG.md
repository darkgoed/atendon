# Plano de Implementação: Sistema de Versionamento + Changelog no Painel

## Visão Geral

Criar um sistema que exibe a versão atual (SemVer) no painel e apresenta um changelog ("O que há de novo") quando há atualizações.

---

## 1. Backend — API de Versão + Changelog

### Arquivos a criar/modificar

| Arquivo | Ação |
|---------|------|
| `apps/backend/src/config.ts` | Ler `APP_VERSION` (injetada no build) e `CHANGELOG_PATH` |
| `apps/backend/src/modules/root/version.ts` *(novo)* | Serviço: carrega `changelog.json`, retorna `{ version, changelog[] }` |
| `apps/backend/src/app.ts` | Nova rota `GET /api/version` (pública, sem auth) |

### Estrutura `changelog.json`

```json
{
  "current": "1.2.0",
  "history": [
    { "version": "1.2.0", "date": "2026-07-26", "changes": ["Nova funcionalidade X", "Correção bug Y"] },
    { "version": "1.1.0", "date": "2026-07-20", "changes": ["Melhoria IA", "Ajuste agendamento"] }
  ]
}
```

---

## 2. Build/Deploy — Injeção de Versão

### Arquivos a modificar

| Arquivo | Mudança |
|---------|---------|
| `package.json` (root) | Adicionar `"version": "1.0.0"` + script `version:bump` |
| `build.sh` | Ler versão do `package.json`, escrever `APP_VERSION` no `.env` de produção, gerar/atualizar `changelog.json` |
| `ecosystem.config.js` | Passar `APP_VERSION` para processos PM2 |

---

## 3. Frontend — Exibição + Detecção de Atualização

### Arquivos a criar/modificar

| Arquivo | Ação |
|---------|------|
| `apps/panel/lib/api.ts` | Adicionar `fetchVersion()` |
| `apps/panel/components/shell.tsx` | **Rodapé da sidebar**: mostrar `v{version}` + botão "Novidades" |
| `apps/panel/components/version-banner.tsx` *(novo)* | Modal/Toast "O que há de novo na v{X.Y.Z}" — abre se `localStorage.lastSeenVersion !== currentVersion` |
| `apps/panel/app/layout.tsx` | Chamar `fetchVersion()` no layout raiz (SWR), disparar banner |

---

## 4. Fluxo de Usuário

1. **Deploy** roda `build.sh` → incrementa version (patch/minor/major) → escreve `.env` + `changelog.json`
2. **Backend** lê `APP_VERSION` e serve em `GET /api/version`
3. **Frontend** carrega versão no `Shell` (sidebar footer)
4. **Usuário abre painel** → SWR busca `/api/version` → compara com `localStorage.lastSeenVersion`
5. **Se diferente** → abre modal "Novidades da v1.2.0" com lista de mudanças
5. **Usuário fecha** → salva `lastSeenVersion = currentVersion`

---

## 5. Decisões de Design

| Decisão | Escolha | Justificativa |
|---------|---------|---------------|
| **Onde guardar changelog?** | Arquivo `changelog.json` no repo | Simples, versionado, revisável em PR |
| **Como incrementar versão?** | `npm version patch\|minor\|major` no `build.sh` | Manual, controle explícito no deploy |
| **Onde mostrar versão no UI?** | Sidebar footer (sempre visível) + botão "Novidades" | Acesso rápido, não atrapalha conteúdo |
| **Changelog manual ou automático?** | Híbrido: `changelog.json` manual no repo; `build.sh` pode sugerir base do `git log` desde último tag | Controle editorial + automação opcional |
| **Versão única ou por workspace?** | Versão única root (monorepo) | Deploy atômico dos 3 serviços juntos |

---

## 6. Próximos Passos

1. ~~Aprovar este plano~~
2. ~~Gerar diffs detalhados por arquivo~~
3. ~~Implementar em sequência: Backend → Build → Frontend~~
4. ~~Testar fluxo completo em ambiente de staging~~

**Status: implementado e validado.**

- Backend: `config.ts` (APP_VERSION/CHANGELOG_PATH), `modules/root/version.ts`, rotas `GET /version` e `GET /api/version` em `app.ts`.
- Build/Deploy: `package.json` com `version` + `version:bump`, `build.sh` injeta `APP_VERSION` e gera `changelog.json` se ausente, `ecosystem.config.js` repassa `APP_VERSION` ao PM2.
- Frontend: `lib/api.ts#fetchVersion`, rodapé da sidebar + botão "Novidades" em `shell.tsx`, modal `version-banner.tsx` com comparação via `localStorage`.
- Testes: `apps/backend/tests/version.test.ts` e `apps/panel/tests/version-banner.test.ts` — ambos passando. `npm run typecheck` e `npm run build` OK.

Pendente (não commitado): revisar diffs e commitar quando o usuário aprovar.

## 7. Changelog 100% automático (2026-07-26)

Bump de versão e texto do changelog deixaram de ser manuais:

- `scripts/changelog-bump.mjs`: a cada deploy, faz diff de código (`git diff --binary`) desde o commit gravado na última entrada de `changelog.json` e escolhe automaticamente o nível pelo tamanho do diff: menos de 100 KiB gera `patch`, de 100 KiB até menos de 1 MiB gera `minor`, e 1 MiB ou mais gera `major`. Os limites podem ser ajustados com `VERSION_MINOR_MIN_KIB` e `VERSION_MAJOR_MIN_KIB`; `VERSION_BUMP=patch|minor|major` continua disponível como override explícito. Depois, chama a OpenRouter (`CHANGELOG_OPENROUTER_API_KEY`, modelo em `CHANGELOG_OPENROUTER_MODEL`) para resumir o diff em bullets em PT-BR do ponto de vista do usuário final. Sem diff → não faz nada. Sem API key ou falha na chamada → cai para uma entrada genérica, sem travar o deploy.
- `build.sh`: antes de rodar o script, commita automaticamente qualquer alteração pendente em `apps/atendon` (`git add -- .` — escopo restrito ao diretório do projeto, nunca `-A` na raiz do monorepo `/var/www`) com mensagem `build patch <timestamp>`, mesmo padrão dos commits já existentes no histórico. Depois do bump, commita `package.json`/`changelog.json` num commit `chore: release vX.Y.Z`.
- Testado em repositório git isolado (fora de `/var/www`): bump com fallback genérico, no-op sem mudanças, e o fluxo completo commit→diff→bump→changelog→commit.

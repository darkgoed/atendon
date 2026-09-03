# comments-spec-loop — rodada documental Newave sem follow-up

Início/atualização: 2026-09-02 17:36 UTC
Fonte: `comments.md` (não alterada; SHA-256 `5a6eb80a96c91542120b377314cd6f97f7fc2ae23cd84671d056c530488e0f58`)
SPEC final: `specs/done/newave-script-comercial-sem-followup.md`

## Status da rodada

- Fase 1 — leitura da intenção: CONCLUÍDA
- Fase 2 — investigação do sistema: CONCLUÍDA
- Fase 3 — SPEC executável: CONCLUÍDA
- Fase 4 — revisão crítica da SPEC: CONCLUÍDA — aprovada após correção e checagem estrutural programática
- Fase 5 — plano e delegação: CONCLUÍDA — escopos de teste e produção separados
- Fase 6 — implementação: CONCLUÍDA — prompt, migration e testes implementados fora desta finalização documental
- Fase 7 — verificação: CONCLUÍDA — evidências abaixo
- Fase 8 — revisão independente: CONCLUÍDA — revisões técnica e comercial aprovadas sem bloqueantes; uma revisão tardia reprovou a migration 0130 por TOCTOU e o ciclo foi reaberto, corrigido por TDD e reaprovado
- Fase 9 — Definition of Done: CONCLUÍDA

## Evidências reais

- `npm run test:disposable -w @atendon/backend -- tests/newave-sales-script-prompt.integration.test.ts tests/fresh-migrations.integration.test.ts`: exit 0; 2 arquivos, 17/17 testes.
- `npm run typecheck && npm run build`: exit 0.
- `npm run lint`: exit 1; 20 erros/0 warnings, exatamente o baseline preexistente, todos fora dos arquivos desta rodada.
- Suíte ampla final, executada após a última correção: `Test Files 15 failed | 95 passed (110)`; `Tests 61 failed | 1135 passed (1196)`; exit 1. Comparação programática com baseline 17/62: 1 falha nova apenas no teste alheio/não rastreado `loss-reason-catalog` (`continua servindo...flag desligada`), 2 baselines não reproduzidos (`fresh-migrations` e `organization-migration`) e 0 falhas no teste NEWAVE. A suíte ampla permanece vermelha; não é resultado verde.
- TDD da precedência de horários: RED reproduzido (1 falha/7 passagens), correção GREEN (8/8); o teste NEWAVE final 8/8 foi repetido mais três vezes e passou nas três repetições, seguido de nova revisão aprovada.
- Painel `newave-config`: 3/3.
- Invariantes verificados: `comments.md` hash `5a6eb80...`; prefixo 52.582 bytes hash `ddac6803...`; seção 26 2.736 bytes hash `dcdc4ba7...`; marcador único; bloco Markdown/SQL idêntico; teste com 209 linhas; sem termos de follow-up ou `transferir_atendente` no bloco.
- Nenhum commit/deploy.
- Correção tardia do TOCTOU na migration 0130 (ver `findings.md`): RED 8/1, GREEN 9/9 repetido três vezes, NEWAVE + fresh migrations 18/18, typecheck/build exit 0, `git diff --check` no escopo exit 0. Suíte ampla reexecutada após essa correção: `Test Files 15 failed | 95 passed (110)`; `Tests 61 failed | 1136 passed (1197)`; exit 1; nenhuma falha NEWAVE; ainda melhor que o baseline 17/62. `npm run lint` mantém os mesmos 20 erros preexistentes fora do escopo.

## Escopo final

SOMENTE A ETAPA DE FINALIZAÇÃO DOCUMENTAL tocou os três documentos permitidos: `progress.md`, `findings.md` e `specs/done/newave-script-comercial-sem-followup.md`. Isso não afirma que a rodada inteira não alterou prompt/migration/testes; a implementação autorizada foi concluída anteriormente nos quatro arquivos registrados na SPEC. `comments.md` permaneceu intocado.

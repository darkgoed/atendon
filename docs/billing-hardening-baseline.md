# Baseline — Hardening comercial/billing AtendON

Medido ANTES de qualquer alteração desta rodada, na árvore de trabalho atual
(branch `feat/design-handoff-b2b`), após `test:db:recreate` + `migrate:test`.

## Números

| Verificação | Resultado |
|---|---|
| `npm run typecheck` (backend + panel) | exit 0 — limpo |
| `npm test -w @atendon/backend` | 145 arquivos: **9 falhando**, 136 passando — 1416 testes: **15 falhando**, 1401 passando |
| `npm test -w @atendon/panel` | 66 arquivos: **1 falhando**, 65 passando — 302 testes: **1 falhando**, 301 passando |

## Testes que JÁ falham no HEAD (não são regressão desta rodada)

Backend:
- `tests/ai-follow-up-settings.integration.test.ts` — persists and audits evaluator settings
- `tests/ai-follow-up-settings.integration.test.ts` — returns the agent quality summary
- `tests/assignment-round-robin.integration.test.ts` — rotates a returning closed conversation and synchronizes its lead and active meeting
- `tests/billing-ai-consumption.integration.test.ts` — enforces a fixed overage cap including reservations
- `tests/fresh-migrations.integration.test.ts` — builds the complete schema including immutable agent versions
- `tests/google-meet-scheduling.integration.test.ts` — creates, persists, exposes and targets the same Meet link from the AI booking flow
- `tests/panel-api.integration.test.ts` — does not resend when the provider accepted the message but local recording failed
- `tests/panel-api.integration.test.ts` — keeps AI configuration and usage invisible to every non-ROOT role
- `tests/panel-api.integration.test.ts` — persists and safely resends text messages rejected by a closed WhatsApp connection
- `tests/saas-foundation.integration.test.ts` — lets ROOT create a workspace and invite its initial OWNER
- `tests/tool-executor.test.ts` — commits a direct time change through the real rescheduling action
- `tests/tool-executor.test.ts` — enforces enabled tools and lets every qualified lead schedule a meeting
- `tests/version.test.ts` — falls back to package.json and warns when changelog JSON is invalid
- `tests/version.test.ts` — returns a valid fallback when changelog is missing
- `tests/version.test.ts` — uses changelog.current when APP_VERSION is absent or empty

Painel:
- `tests/root-saas-billing.test.tsx` — keeps root providers sandbox/prod isolated in visible sections

## Regra de avaliação

Qualquer teste falhando ao final da rodada que NÃO esteja nesta lista é regressão
desta rodada e precisa ser corrigido antes de considerar o trabalho concluído.
Comparar por NOME (`comm -13`), nunca por contagem — a rodada adiciona testes.

Logs brutos: `/tmp/atendon-billing/*.log`

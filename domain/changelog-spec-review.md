# Review — SPEC changelog-product-20260921 (v2, pós-reprovação Astra)

**Data:** 2026-09-21 · **Autor da revisão:** worker Astra-fix (GLM) · **Escopo:** só documentação, zero código.

## Status
- v1 **REPROVADA** pelo Astra (9 correções obrigatórias).
- v2 reescrita em `specs/active/changelog-product-20260921.md` com contratos completos e lacunas explícitas. Nada implementado.

## Gate Jev — registro PENDENTE (não simulado)
`.hermes/state/comments-spec-loop/20260921/tooling/jev_gate.py` **não existia** no momento desta revisão (o diretório continha apenas `jev-path-recovery-evidence-20260921.md`). Nenhum passo de intake/decision/scope-drift/completeness foi executado e **nenhum resultado de gate foi fabricado**. Pendente: quando o worker Jev criar o script, ler seu README e rodar os 4 gates contra esta SPEC. Este arquivo é o registro de pending.

## Rastreabilidade das correções Astra (item → onde foi resolvido na v2)
| # | Correção exigida | Resolução na v2 |
|---|---|---|
| 1 | Contradição L62×L72: `/changelog` público E autenticado | Seção "Painel Novidades" + "Páginas públicas": `/changelog` e `/changelog/[slug]` 100% públicos sem Shell; experiência autenticada em rota dedicada `/novidades` (com Shell). Integração nav/Shell delegada ao worker exclusivo pós-review (gap 4). |
| 2 | POST create + DELETE ausentes; posts sem build/version falsos | Inspecionado 0159/repository: `version`, `build_number`, `commit_sha` NOT NULL → post manual em `releases` exigiria dados falsos. Decisão documentada: entidade editorial dedicada `changelog_posts` ligada opcionalmente 1:1 a `releases` (`release_id NULL UNIQUE`), `source='release'|'manual'`. CRUD completo contratado (create/list/get/patch/delete/publish/unpublish/preview) + mídia (upload/list/patch/delete/assoc via PUT replace-set/dissoc) + preview + schedule. |
| 3 | Público nunca expõe escopo TENANT; whitelist global explícita; legado preservado | Seção "Whitelist pública explícita": predicado único de elegibilidade (`tenant_slugs='{}' AND NOT has_restricted_changes AND published AND publish_at IS NULL`), payload whitelist fechada com lista de campos banidos, asserção `toEqual`. Entradas TENANT ficam só no painel autenticado (regra de visibilidade de `listReleases`). APIs legadas `/root/versions*`, `/panel/versions`, espelho `changelog.json` intocadas. |
| 4 | Mídia: só de post global publicado elegível; drafts 404; mime spoof; cache revogável | Seção "Mídia": query de elegibilidade por associação; 404 para draft/agendado/despublicado/órfã; magic bytes vs declared → 415; SVG/HTML/EXE → 415; cap 10MB → 413; `Cache-Control: public, max-age=300, must-revalidate` (NÃO immutable) + ETag sha256; elegibilidade re-checada a cada request (sem cache de decisão); preview admin autenticado via `/root/changelog/media/:id/bytes`. |
| 5 | Agenda: unpublish cancela; draft/manualOverride nunca republicado; SQL antigo republicava unpublished | Seção "Estado e máquina de publicação": unpublish SEMPRE zera `publish_at` (cancela agenda); worker zera `publish_at` ao executar; CHECK `published ⇒ publish_at IS NULL`; `manual_override` bloqueia sync/AI; reconciler verificado — não publica nada (só ai_status); call-site do auto-publish listado como gap 2 para plug do sync. |
| 6 | Read-state por publicação, não watermark build; idempotente; user do servidor; global sem leak | `changelog_reads(user_id, post_id)` PK composta; por quê não watermark documentado (post antigo publicado após leitura de novo não desaparece); `INSERT ON CONFLICT DO NOTHING` idempotente; `user_id` sempre da sessão; visibilidade filtrada por request (regra `listReleases`) — read-state global por usuário sem leak cross-tenant. |
| 7 | Ordenação determinística, paginação completa, slug estável, markdown seguro | `ORDER BY COALESCE(publish_at, published_at) DESC, id DESC`; `nextOffset: number|null` fim explícito; slug imutável após primeira publicação, colisão → 409 + sugestão `-2`, NFKD + fallback; markdown = escape-total + allowlist (sem HTML raw; links https-only; `javascript:`/`data:` neutralizados). Editor de mídia completo no admin. |
| 8 | app.ts não editado | Seção "Registro de rotas": patch de registro entregue ao orquestrador; nada em `app.ts` por este worker. |
| 9 | Testes positivos/negativos de todos os cenários | Seção "Required Tests": matriz por arquivo cobrindo público/draft/schedule/cancel/unpublish/tenant restrictions/media revocation/read order/migration/admin lifecycle. Só testes reais citados como regressão (`version.test.ts`, `version-banner.test.ts`); nenhum teste inventado. |

## Dependência multipart (verificada antes de proibir)
Nenhuma lib multipart/markdown no repo (`package.json` backend + painel conferidos; apenas `sharp`). A v1 proibia deps sem alternativa — corrigido: **`@fastify/multipart` aprovado como única dependência nova** (plugin oficial Fastify 5; multer rejeitado por ser Express-centric; busboy por exigir streaming manual). Markdown segue zero-dep (renderer próprio escape+allowlist).

## Lacunas explícitas (herdadas da SPEC, seção própria)
1. Instalar `@fastify/multipart` na implementação.
2. Localizar call-site de `setReleasePublished` no worker (auto-publish AI) para plugar o sync.
3. Confirmar tabela real de planos para validar `affectedPlans`.
4. Nav/badge/Shell (`panel-manifest.ts`, badge unread) → worker de integração exclusivo pós-review.
5. Registro de rotas em `app.ts` → patch do orquestrador.
6. GC de mídia órfã fora de escopo.
7. Jev gate pendente (registro acima).

## Ownership
Somente estes dois arquivos foram tocados: `specs/active/changelog-product-20260921.md`, `domain/changelog-spec-review.md`. Nenhum código, migration, teste ou `app.ts` foi alterado.

# SPEC: Sistema de Changelog do AtendON — v3 (editorial 100% GLOBAL; contratos finais)

> **Status:** v3 — fechamento final após REPROVAÇÃO da v2 pelo Astra (2026-09-21). Simplificação radical decidida pelo orquestrador: editorial GLOBAL ONLY, **zero sincronização runtime release→post**, sem qualquer dimensão tenant no modelo novo. Decisões finais vinculantes: `domain/final-contract-decisions.md` (fonte; este spec reflete-as integralmente).
> **Ownership deste documento:** só `specs/active/changelog-product-20260921.md` e `domain/final-contract-decisions.md`. Nenhum código é implementado nesta fase (documentação only).
> **Gate Jev:** **PENDING** — `jev_gate.py` não pousou em `.hermes/state/comments-spec-loop/20260921/tooling/` (o diretório contém `BLOCKED-jev-gate-401.md` e evidência de recuperação). Nenhum PASS pode ser alegado; re-avaliar quando o gate pousar (ler README e executar antes do DoD).

## Objective
Changelog **global do produto** com uma ÚNICA timeline: página pública (feed + permalink), administração ROOT completa de publicações editoriais (criar/editar/agendar/publicar/cancelar agenda/despublicar/excluir — **incluindo postagem manual sem deploy**), mídia com revogação imediata (no-store), e "Novidades" autenticada = **o mesmo feed global** + read-state por usuário. Fonte técnica de builds (`releases` + AI) preservada 100% intocada, com suas permissões.

## Decisão de arquitetura (FINAL — substitui a v2)
- **Uma única timeline GLOBAL.** Nova entidade editorial `changelog_posts`, **independente**: sem coluna de escopo tenant, sem herança de tenant, sem segunda timeline. Feed público e Novidades leem o MESMO conjunto (elegibilidade idêntica); o autenticado só acrescenta `read` por usuário.
- **ZERO sincronização runtime release→post.** O caminho técnico (`POST /root/versions/:id/publish`, auto-publish da AI em `changelogAiTimer`) **NUNCA** escreve em `changelog_posts`. Não existe estado duplicado, não existe janela de auto-publish, não existe `manual_override` (não há mais o que proteger). `/root/versions*` permanece fechado em si, intocado.
- **`release_id` é proveniência opcional apenas:** preenchido SOMENTE por import/backfill one-off explícito e curado de entradas **comprovadamente globais** (seção Import). 1:1 opcional (`UNIQUE` parcial), `ON DELETE SET NULL`. Nunca escrito pelo runtime.
- **Isolamento por intocabilidade:** `releases`, `/root/versions*`, `/panel/versions`, espelho `changelog.json`, `version-banner` e `GET /panel/version` permanecem exatamente como estão (contrato + permissões). O editorial novo não replica nem consome o escopo do legado.

## Current State (evidências, validadas na leitura — mantidas da v2)
- DB: `releases` (`apps/backend/src/db/migrations/0159_release_pipeline.sql:6-58`) — version/build_number/classification/`tenant_slugs_detected`/`technical_changelog`/`public_title`/`public_summary`/`public_changes JSONB[{text,tenant_slugs}]`/`ai_status`/`published`+`published_at`/`manual_override` (legado). CHECK `published ⇒ title+summary`. `changelog_ai_settings` singleton (:85-96, `auto_publish_enabled`), `changelog.json` espelho de compat. **Tudo intocado.**
- Backend `apps/backend/src/modules/release/routes.ts`: GET `/root/versions`, GET/PATCH `/root/versions/:id`, POST `/root/versions/:id/publish|unpublish|regenerate`, GET/PUT `/root/settings/changelog-ai`, GET `/panel/versions` (requireWorkspace + tenant slug). Intocados. **Não existe POST create nem DELETE de publicação no legado — continua assim; criação/exclusão editorial mora em `/root/changelog/*` (abaixo).**
- `reconciler.ts` NÃO contém SQL de publicação (só `ai_status` generating/failed/pending-retry). O auto-publish de release é exclusivo do legado (`changelogAiTimer`, `apps/backend/src/worker.ts:696`). **O "ponto de plug" de sync da v2 está REMOVIDO desta spec.**
- Painel: `apps/panel/app/changelog/page.tsx` (interno, Shell, `limit=100` fixo), `apps/panel/app/root/versions/page.tsx` (admin), `components/version-banner.tsx` + `modules/root/version.ts`. Legado intocado; páginas novas são arquivos novos.
- Nav: `apps/panel/lib/panel-manifest.ts:90` (/root/versions, rootOnly) e `:95` (/changelog, menu:false).
- SEO hoje: `robots.ts` bloqueia tudo exceto `/login`,`/llms.txt`; `sitemap.ts` só `/login`.
- Mídia precedente: stickers (bytea em Postgres, cap, content hash) — não existe S3. Não existe lib multipart nem lib markdown no repo (verificado `package.json` backend+painel; só `sharp`).
- Testes existentes reais: `apps/backend/tests/version.test.ts`, `apps/panel/tests/version-banner.test.ts`. Nenhum teste do módulo release. Nenhum teste é inventado nesta spec.

## Modelo de dados (UMA migration própria; número LIVRE escolhido na implementação — dogma "zero migrations" retirado; há 0176 duplicado no repo, evitar colisão)

### `changelog_posts` (global editorial)
Campos **removidos da v2 e por quê**: `tenant_slugs` (não há escopo tenant no editorial), `has_restricted_changes` (não há itens restritos no editorial), `manual_override` (não há sync a proteger), `source` (presença de `release_id` já marca proveniência), `content_md`/`changes` (**markdown não foi requerido** — corpo é texto completo por parágrafos).

| coluna | tipo | regra |
|---|---|---|
| id | UUID PK | |
| release_id | UUID NULL REFERENCES releases(id) | proveniência de import curado; UNIQUE parcial `WHERE release_id IS NOT NULL`; ON DELETE SET NULL; nunca escrito pelo runtime |
| version_label | TEXT NULL | rótulo de exibição livre (manual) / `releases.version` (import) |
| slug | TEXT UNIQUE | `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| title | TEXT NOT NULL | |
| summary | TEXT NULL | CHECK `NOT published OR summary IS NOT NULL` |
| category | TEXT NOT NULL DEFAULT 'outro' | CHECK IN ('novo','melhoria','correcao','seguranca','integracao','performance','outro') |
| author | TEXT NULL | mantido (decisão final) |
| content_text | TEXT NULL | corpo completo em **texto plano preservado por parágrafos** (linha em branco = parágrafo); **sem markdown, sem HTML raw, sem parser regex**. NULL = render só resumo/links/mídia. No contrato: `contentText` |
| modules_affected | TEXT[] NOT NULL DEFAULT '{}' | **OBRIGATÓRIO no modelo e na entrada admin (`modulesAffected`)** — payload exige; v2 omitia |
| affected_plans | TEXT[] NOT NULL DEFAULT '{}' | mantido; validado contra tabela de planos na rota (senão 400) |
| related_links | JSONB NOT NULL DEFAULT '[]' | `[{label,url}]`, url https-only validado na rota (senão 400) |
| publish_at | TIMESTAMPTZ NULL | agendamento |
| published | BOOLEAN NOT NULL DEFAULT false | |
| published_at | TIMESTAMPTZ NULL | momento da última publicação |
| created_by_user_id | UUID NULL REFERENCES users(id) | |
| created_at / updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | trigger touch |

CHECK extra: `NOT published OR (publish_at IS NULL)` — publicada não carrega agenda residual.

### `changelog_media` (global)
`id UUID PK, sha256 TEXT UNIQUE NOT NULL, mime TEXT NOT NULL, size_bytes INT NOT NULL CHECK (size_bytes>0), data BYTEA NOT NULL, alt TEXT NULL, created_by_user_id UUID NULL, created_at` — bytea em Postgres (padrão stickers; sem S3 no repo). GIF e vídeo/MP4 preservados (whitelist por assinatura) — a simplificação NÃO corta conteúdo (GIF/vídeo/links completos).

### `changelog_post_media` (associação N:N com integridade)
`post_id UUID REFERENCES changelog_posts(id) ON DELETE CASCADE, media_id UUID REFERENCES changelog_media(id) ON DELETE CASCADE, position INT NOT NULL DEFAULT 0, PK (post_id, media_id)` + índice em `media_id` (proteção de DELETE e revogação).

### `changelog_reads` (read-state POR USUÁRIO × PUBLICAÇÃO)
`user_id UUID REFERENCES users(id) ON DELETE CASCADE, post_id UUID REFERENCES changelog_posts(id) ON DELETE CASCADE, read_at TIMESTAMPTZ NOT NULL DEFAULT now(), PK (user_id, post_id)`. Leitura é global por usuário (sem filtro tenant — não há tenant no editorial); marca apenas o que o usuário já viu. Por post o estado é estável (publicar post antigo após ler um novo não o faz sumir do unread).

## Estado e máquina de publicação
Estados: `draft` (published=false, publish_at=NULL) → `scheduled` (published=false, publish_at futuro) → `published` (published=true, published_at set, publish_at=NULL) → `unpublished` (published=false, publish_at=NULL, published_at preservado como histórico).

1. **Agendar** (POST publish com `publishAt` futuro ou PATCH publishAt em draft/scheduled): `published=false, publish_at=<futuro>`.
2. **Publicar** (POST publish sem/`publishAt` passado, ou worker no tick): `published=true, published_at=now(), publish_at=NULL` — worker zera `publish_at` ao executar, eliminando janela de republicação.
3. **Despublicar** (POST unpublish): `published=false, publish_at=NULL` — **SEMPRE cancela a agenda pendente**. Com `publish_at` zerado, nenhum worker/reconciler publica draft/despublicado.
4. **SQL do worker:** `UPDATE changelog_posts SET published=true, published_at=now(), publish_at=NULL WHERE published=false AND publish_at IS NOT NULL AND publish_at<=now() RETURNING id` — só posts, nunca releases; idempotente (2ª execução: 0 rows).
5. **PATCH `publishAt` em post publicado → 409** (exige unpublish antes).

## Whitelist pública explícita
**Predicado único de elegibilidade pública** (fonte única de verdade para feed, permalink, mídia e sitemap):
```sql
published = true AND publish_at IS NULL
```
Isso é TUDO — **nenhum filtro tenant existe no editorial**.

**Payload público — whitelist fechada** (teste com asserção `toEqual` exata):
`{slug, versionLabel (nullable), title, summary, category, author, publishedAt, contentText (nullable), relatedLinks:[{label,url}], modulesAffected, affectedPlans, media:[{id, alt, mime}]}`

**Banido do payload público, sem exceção:** `id` interno, `release_id`, `created_by_user_id`, `publish_at`, e QUALQUER campo herdado/espelhado do legado: `tenant_slugs_detected`, `technical_changelog`, `diff_excerpt`, `commit_sha`, `commit_messages`, `files_changed`, `additions`, `deletions`, `ai_*`, `build_number`. **Teste de não-vazamento do legado obrigatório** (nenhum campo de `releases`/tenant aparece nem no payload nem nas queries do editorial).

## Contratos — Administração ROOT (todas requireRoot; ciclo de vida completo)

| Rota | Contrato |
|---|---|
| `POST /root/changelog/posts` | Body `{title (obrigatório), summary?, slug?, category?, author?, contentText?, modulesAffected?, relatedLinks?, affectedPlans?, publishAt?}`. Cria post manual independente (sem version/build/commit_sha), `published=false` (draft); `publishAt` futuro → scheduled. 201 → post completo. |
| `GET /root/changelog/posts` | Query `status=draft\|scheduled\|published\|unpublished\|all (def all)`, `limit (1-100, def 50)`, `offset`. → `{posts:[campos completos], nextOffset\|null}`. Ordenação determinística: `COALESCE(publish_at, published_at) DESC, id DESC`. |
| `GET /root/changelog/posts/:id` | Campos completos. 404 se inexistente. |
| `PATCH /root/changelog/posts/:id` | Campos: `title, summary, category, author, contentText, modulesAffected, relatedLinks (https-only, senão 400), affectedPlans (tabela de planos, senão 400), slug, publishAt`. `slug` editável **somente enquanto nunca publicado** (permalink estável; publicado → 409). `publishAt` somente em draft/scheduled (publicado → 409). |
| `DELETE /root/changelog/posts/:id` | Delete físico + cascade em `changelog_post_media` e `changelog_reads`. Mídia permanece (GC fora de escopo). Público → 404 imediatamente (páginas dinâmicas, sem cache de publicado). 204. |
| `POST /root/changelog/posts/:id/publish` | Body opcional `{publishAt}`. Futuro → scheduled; ausente/passado → published (máquina acima). Sem summary → 400. |
| `POST /root/changelog/posts/:id/unpublish` | Máquina acima: cancela agenda sempre. 204. |
| `GET /root/changelog/posts/:id/preview` | Mesmo shape do payload público + flags admin `{status, publishAt}`. Funciona para draft/scheduled/unpublished (autenticado). **`Cache-Control: no-store`.** |

Ciclo de vida preservado: create / edit / draft / schedule / cancel (unpublish cancela agenda) / unpublish / delete / permalink estável / read-state post-user. Tabelas, FKs, mídia e permissões conforme especificado.

## Import opcional de proveniência (ÚNICO caminho release→post; one-off curado; NÃO é gate)
- **Quando:** decisão ROOT explícita de backfill de releases já publicadas. **Nunca** runtime, nunca automático, nunca no publish/unpublish/regenerate.
- **Critério (comprovadamente global):** `tenant_slugs_detected = '{}'` **E** nenhum item de `public_changes` com `tenant_slugs` não vazio. **NÃO importar título/summary tenant-restritos** — release com escopo TENANT ou itens restritos → **skip + log**, permanece exclusivamente no legado.
- **Importa:** `title=public_title, summary=public_summary, version_label=version, content_text=itens globais de public_changes em parágrafos, category='outro', release_id setado`. Idempotente por `release_id` (re-execução não duplica).
- **NÃO é gate do DoD** (import seguro opcional). Backfill das releases hoje publicadas: opcional, curado, decisão do orquestrador.

## Contratos — Mídia

| Rota | Contrato |
|---|---|
| `POST /root/changelog/media` (multipart, ROOT) | Campo `file` único obrigatório + `alt?`. Dependência proposta: **`@fastify/multipart` — PERMITIDA CONDICIONALMENTE**: versão compatível com **Fastify 5 verificada na execução** e pacote+lock com **dono único** (nenhum outro pacote a traz transitivamente). Este spec **não "aprova" a dependência sozinho** — aprovação final ocorre na revisão do patch (orquestrador/Astra). `limits {fileSize: 10*1024*1024, files: 1}` — excedente → 413. `content-type` declarado divergente do sniff por **magic bytes** → 415 (spoof rejeitado). Whitelist por assinatura: PNG `\x89PNG`, JPEG `\xFF\xD8\xFF`, GIF `GIF87a/89a`, WEBP `RIFF..WEBP`, MP4 `ftyp`@offset4. SVG/HTML/EXE/outros → 415 sempre. sha256; re-upload idêntico retorna registro existente. 201 → `{id, sha256, mime, sizeBytes, alt}`. |
| `GET /root/changelog/media` | Lista paginada (limit/offset) sem `data`. |
| `PATCH /root/changelog/media/:id` | `{alt}`. 404 inexistente. |
| `DELETE /root/changelog/media/:id` | **409 se referenciada** por qualquer `changelog_post_media` (dissociar primeiro); senão delete físico. 204. |
| `PUT /root/changelog/posts/:id/media` | Body `{mediaIds: string[]}` — **substitui o conjunto completo** (associa novos + dissocia removidos num contrato só). Id inexistente → 404. Duplicados no body → dedup. Retorna lista atualizada. |
| `GET /root/changelog/media/:id/bytes` | Bytes autenticados ROOT (preview de draft no admin). **`Cache-Control: no-store`.** |

### Servir mídia ao público (REVOGÁVEL — decisão final)
`GET /public/changelog/media/:mediaId` → 200 bytes **somente se** a mídia está associada a ≥1 post elegível:
```sql
SELECT 1 FROM changelog_post_media m JOIN changelog_posts p ON p.id = m.post_id
WHERE m.media_id = $1 AND p.published AND p.publish_at IS NULL LIMIT 1
```
Caso contrário → **404** (draft, agendado, despublicado, excluído, órfã).
- **`Cache-Control: no-store`** em TODAS as respostas de mídia (pública e admin) — zero janela residual: unpublish/delete revoga **imediatamente** (substitui o `max-age=300` da v2).
- **Elegibilidade ANTES de qualquer 304:** `ETag: "<sha256>"` só quando elegível; `If-None-Match` → 304 **apenas após re-executar o predicado** (não-elegível → 404, nunca 304 servido de decisão em cache). A query de elegibilidade é re-executada a cada request (sem cache de decisão no app).
- Páginas (públicas e admin) NÃO servem `published` de cache: render dinâmico (`dynamic = 'force-dynamic'` + fetch `cache:'no-store'`) — unpublish/delete/exclusão refletem no request seguinte. Sitemap idem dinâmico.
- Logs: publish/unpublish/delete/schedule e as respostas 404 de mídia revogada geram log estruturado (post_id/media_id/ação). Testes de header **exatos** (`toEqual`), incluindo no-store e 304-condicionado.

## Contratos — Público (sem auth)
| Rota | Contrato |
|---|---|
| `GET /public/changelog` | Query `limit (1-50, def 20)`, `offset (≥0)`. Elegibilidade + whitelist. Ordenação determinística: `ORDER BY COALESCE(publish_at, published_at) DESC, id DESC`. `{posts:[...], nextOffset: number\|null}` (paginação completa). |
| `GET /public/changelog/:slug` | Elegível → 200 payload whitelisted; draft/agendado/despublicado/excluído/inexistente → **404**. |
| `GET /public/changelog/media/:mediaId` | Seção Mídia (no-store, elegibilidade antes de 304). |

**Sem markdown/HTML:** `content_text` é renderizado como parágrafos de texto plano (React escapa por padrão; **proibido `dangerouslySetInnerHTML`** e proibido parser regex markdown custom). Mídias e links são estruturados (`changelog_post_media`, `related_links`).

## Contratos — Painel "Novidades" (autenticado = mesmo feed global + read por usuário)
`/changelog` e `/changelog/[slug]` são **100% públicos, sem Shell**. A experiência autenticada mora em **`/novidades`** (com Shell, requireWorkspace) — **não é uma segunda timeline e não tem dimensão tenant**: é o MESMO feed global publicado, acrescido do read-state por usuário. Nenhuma exposição TENANT em nenhum payload. Integração de nav/badge (`panel-manifest`, Shell, poll estilo `internal-notifications`) é trabalho do **worker de integração exclusivo (GLM), pós-review** — gap explícito, não implementado nesta spec.

| Rota | Contrato |
|---|---|
| `GET /panel/changelog/unread` | `{count, latestPost: {slug, title, category, publishedAt}\|null}`. count = posts elegíveis (published + agenda não vencida) sem linha em `changelog_reads` do usuário. |
| `GET /panel/changelog/feed` | `limit (1-50, def 20)` / `offset`; os mesmos posts elegíveis + `read: boolean` por item; mesma ordenação e `nextOffset`. |
| `POST /panel/changelog/read` | Body `{postId}`. `user_id` **SEMPRE da sessão** (nunca do body — auth scope do servidor). Post não elegível → 404. `INSERT ... ON CONFLICT DO NOTHING` — **idempotente**. 204. |

## FE admin concreto — `/root/changelog/page.tsx` (NOVO; não é "só endpoints")
Página ROOT nova em `apps/panel/app/root/changelog/page.tsx` (+ componentes co-localizados em `apps/panel/components/changelog-admin/`), com ciclo de vida completo em UI:
- Lista com filtro de status (draft/scheduled/published/unpublished/all) e ações por card (publicar/agendar/cancelar agenda/despublicar/excluir/preview).
- Form de criar/editar: `title`, `summary`, `category` (select), `author`, `contentText` (textarea por parágrafos), `modulesAffected` (chips → array), `affectedPlans` (chips validados), `relatedLinks` (lista label+url https com validação), `slug` (só pré-publicação), `versionLabel`.
- Upload de mídia (multipart) + galeria com edição de `alt`, anexar/desanexar (`PUT mediaIds`, ordenação por `position`) e preview.
- Publicar/Agendar (datetime picker)/Despublicar/Excluir com confirmação; erros 400/409 (slug publicado, plan inválido, mídia referenciada) tratados inline.
- Preview de draft/agendado/despublicado em viewer **no-store**.
- Entrada de nav rootOnly (`panel-manifest.ts`) → patch para o worker de integração (mesma regra do app.ts).

## Páginas públicas + SEO (painel Next.js)
- `apps/panel/app/changelog/page.tsx` → pública (Server Component, sem Shell): feed cronológico, chip de categoria, título, resumo, data, autor, botão "Carregar atualizações anteriores" (offset). **Render dinâmico/no-store** (substitui o `revalidate: 60` da v2).
- `apps/panel/app/changelog/[slug]/page.tsx` → permalink público + `generateMetadata` (title/description/canonical/OG) em ambas as páginas.
- `robots.ts`: allow `/changelog` e `/changelog/*`; `sitemap.ts`: `/changelog` + slugs elegíveis (fetch no-store; backend indisponível → lista estática sem crash).
- `/novidades/page.tsx` → autenticada, Shell (feed global + "Marcar como lida" + links para o permalink público).
- Identidade AtendON: tokens/cards/EmptyState existentes; zero CSS do iClinic.

## Worker de agendamento (backend)
`apps/backend/src/worker.ts`: `setInterval(60s)` + boot run + unref + clear no shutdown (padrão `changelogAiTimer` :696), executando o SQL da seção "Estado" (**só posts; nunca releases; nunca sync**). Log dos ids publicados.

## Registro de rotas
Nenhuma rota é registrada em `app.ts` por este worker: o patch de registro (`/public/changelog*`, `/root/changelog/*`, `/panel/changelog/*`) é entregue ao **orquestrador**; `app.ts` é do **worker GLM de integração, exclusivo — nunca Astra**. `apps/panel/lib/panel-manifest.ts` e Shell idem (worker de integração).

## Invariants
- Editorial é GLOBAL: nenhuma coluna, campo, rota ou página do modelo novo expõe ou filtra por tenant; nenhuma leitura de tenant no editorial.
- Público = `published` + `publish_at IS NULL`; nada agendado/despublicado/draft aparece em feed, permalink, mídia ou sitemap.
- Revogabilidade: mídia/preview `no-store`; páginas sem cache de publicado; **elegibilidade antes de 304**; unpublish/delete → 404 no request seguinte.
- Sem sync runtime: nenhum caminho de `releases` (publish/unpublish/regenerate/AI) escreve em `changelog_posts`; `release_id` só via import curado one-off.
- `published ⇒ summary IS NOT NULL` (CHECK); agendada nunca aparece antes de `publish_at`; despublicar cancela agenda.
- Payload público = whitelist exata; teste de não-vazamento do legado obrigatório.
- Edição ROOT-only (requireRoot); leitura pública sem credencial; mídia com whitelist por magic bytes + caps + revogação imediata.
- `releases` e APIs legadas intocadas em contrato e permissões; `changelog.json` continua espelho.
- Permalink: slug imutável após primeira publicação; colisão de slug → 409 com sugestão `-2`.

## Edge Cases
- Slug de título unicode/acentos → NFKD; vazio → fallback `atendon-post-<timestamp>`.
- `publish_at` no passado via PATCH → publica no próximo tick (≤60s).
- Worker × PATCH publish concorrentes → `UPDATE ... WHERE published=false AND publish_at IS NOT NULL` idempotente.
- `content_text` NULL → render só resumo + links + mídia.
- Mídia órfã → GC fora de escopo; DELETE bloqueado enquanto referenciada.
- Sitemap com backend indisponível → 200 estático.
- Usuário novo no painel → 0 leituras: unread conta histórico global publicado (aceitável v1, documentado).
- Release legada tenant-restrita → import skip + log; nunca vira post; nunca aparece no público/Novidades.
- Link `javascript:`/relativo em `related_links` → 400 na rota (https-only).

## Dependencies / Affected Areas (arquivos exatos)
- `apps/backend/src/db/migrations/<n>_changelog_editorial.sql` — **UMA migration, número livre** (evitar colisão com o 0176 duplicado)
- `apps/backend/src/modules/changelog/{routes,repository,media}.ts` (NOVOS), `apps/backend/src/worker.ts` (+1 timer; sem sync)
- Registro em `app.ts` → patch para o orquestrador (worker GLM de integração exclusivo); nav/badge/Shell → worker de integração pós-review
- `apps/panel/app/changelog/page.tsx`, `app/changelog/[slug]/page.tsx`, `app/novidades/page.tsx`, `app/root/changelog/page.tsx` (+ `components/changelog-admin/*`), `app/robots.ts`, `app/sitemap.ts`, `lib/api.ts`
- **Dependência nova única: `@fastify/multipart`** — condicionada à verificação Fastify 5 na execução + dono único em package/lock; **zero libs markdown**; `sharp` já existe
- Plano de execução de testes: `scripts/run-tests-disposable.ts` sempre (banco descartável). Redis não isolado pelo harness (`REDIS_URL` default `redis://localhost:6382/15`, override `TEST_REDIS_URL`) → suítes que tocam Redis/BullMQ em série. Harness não é modificado.

## Non-goals
**Sync runtime release→post; timeline tenant; markdown/HTML parser; GC de mídia órfã;** comentários/reactions; i18n; realtime push (poll basta); copiar visual iClinic; re-encode de imagens via sharp; integração de nav/badge (worker de integração).

## Required Tests (todos NOVOS; regressão usa os reais: `apps/backend/tests/version.test.ts`, `apps/panel/tests/version-banner.test.ts`)
Matriz positiva/negativa (arquivo → casos):
- `tests/changelog-posts.integration.test.ts` (admin lifecycle):
  - (+) create draft manual sem release/build; edit; publish imediato; schedule futuro; unpublish cancela agenda (`publish_at` NULL após unpublish); republish; delete.
  - (−) workspace user → 401/403 em todas; title vazio → 400; publish sem summary → 400; PATCH slug após publicado → 409; PATCH publishAt em publicado → 409; slug colisão → 409+sugestão; relatedLink http → 400; affectedPlan inexistente → 400.
- `tests/changelog-public-routes.integration.test.ts`:
  - (+) feed ordenado determinístico + paginação (`nextOffset` null no fim); permalink 200; payload = whitelist exata (`toEqual`).
  - (−) draft/agendado futuro/despublicado/excluído → 404; campos banidos ausentes (asserção campo a campo); sem cookie/sessão.
  - (+ não-vazamento do legado) post de import de release GLOBAL nunca expõe `tenant_slugs_detected`/`technical_changelog`/`ai_*`/`commit_*`; release com escopo TENANT (legado) nunca aparece no público nem gera post.
- `tests/changelog-worker.integration.test.ts`:
  - (+) agendada vencida aparece após tick; idempotente (2ª execução 0 rows); worker não toca `releases`.
  - (−) despublicada com publish_at NULL não é republicada; draft nunca publicado pelo worker; **nenhum post criado por re-publish de release (sync removido)**.
- `tests/changelog-media.integration.test.ts`:
  - (+) upload PNG/JPEG/GIF/WEBP/MP4 → 201; re-upload idêntico → mesmo id; PUT media substitui conjunto (assoc+dissoc); GET público 200 p/ post elegível; **304 só após elegibilidade re-verificada**; unpublish → GET público 404 no request seguinte; delete de post → mídia 404 no público.
  - (−) mime declarado ≠ magic bytes → 415; SVG/HTML/EXE → 415; >10MB → 413; vazio → 400; mídia de draft → GET público 404; preview de draft admin → 200 autenticado; DELETE mídia referenciada → 409.
  - **Headers exatos (`toEqual`):** `Cache-Control: no-store` em bytes público, preview admin e páginas; 404 pós-unpublish sem janela residual.
- `tests/changelog-import.integration.test.ts` (opcional, quando o import existir):
  - (+) import curado de release global cria post com `release_id`, idempotente.
  - (−) release com `tenant_slugs_detected ≠ '{}'` ou itens restritos → skip + log, nenhum post; import NÃO roda no publish/unpublish/regenerate (prova de ausência no runtime).
- `tests/changelog-reads.integration.test.ts`:
  - (+) 2 usuários com leituras independentes; mark-read idempotente (2× → 204, count inalterado); publicar post antigo após ler novo NÃO desaparece do unread do outro usuário (per-post); feed flag `read:true`.
  - (−) postId não elegível → 404; user_id do body ignorado (sempre sessão); não autenticado → 401.
- `tests/changelog-migration.integration.test.ts` + fresh-migrations: CHECKs (published⇒summary, published⇒publish_at NULL), slug UNIQUE → 23505, category inválida → 23514.
- `apps/panel/tests/changelog-public.test.tsx`: feed renderiza fixture (parágrafos de `contentText` como texto plano); paginação dispara offset; permalink + metadata; **sem HTML raw** (proibido `dangerouslySetInnerHTML`).
- `apps/panel/tests/changelog-admin.test.tsx` (NOVO): lifecycle UI completo (criar/editar/chips modules/affectedPlans/upload mídia/preview/publicar/agendar/despublicar/excluir); 409/400 tratados inline; preview no-store.
- `apps/panel/tests/changelog-novidades.test.tsx`: feed global + "Marcar como lida" dispara POST, estado lido persiste visualmente.
- Regressão: `version.test.ts` e `version-banner.test.ts` verdes.

## Definition of Done
- [ ] Todos os contratos acima implementados com os testes da matriz (exit codes em `.hermes/state/`)
- [ ] Payload público validado por asserção exata de whitelist + teste de não-vazamento do legado verde
- [ ] Revogabilidade provada: no-store + elegibilidade-antes-de-304 + corrida unpublish→GET 404 (headers exatos)
- [ ] Zero sync runtime provado (nenhum caminho de release escreve em posts)
- [ ] gates: tsc backend 0, eslint 0 warnings, `npm run build` painel 0, suítes Redis em série
- [ ] Light/dark + responsividade nas páginas novas
- [ ] Nenhuma rota em `app.ts` por este worker (patch entregue; app.ts exclusivo do worker GLM de integração)
- [ ] Jev gate PENDING registrado (executar quando pousar)

## Lacunas explícitas (documentadas — não resolvidas com achismo)
1. **`@fastify/multipart`**: compatibilidade Fastify 5 + dono único verificáveis na implementação; aprovação final do patch é do orquestrador/Astra (worker não aprova sozinho). Se incompatível → fallback de streaming manual (busboy) decidido lá, sem mudar contratos.
2. **Tabela real de planos** para validação de `affectedPlans` a confirmar na implementação.
3. **Integração nav/badge/Shell** e **registro de rotas em `app.ts`**: worker de integração exclusivo, pós-review.
4. **GC de mídia órfã**: fora de escopo; DELETE bloqueado enquanto referenciada.
5. **Import curado**: entrada (lista de ids de releases) e execução one-off confirmadas na implementação quando o orquestrador optar por backfill.
6. **Jev gate**: PENDING (`BLOCKED-jev-gate-401.md` no tooling/); nenhum PASS alegado.

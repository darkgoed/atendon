# FINAL CONTRACT DECISIONS — orquestrador, 2026-09-21

> Decisões FINAIS e vinculantes desta rodada (fechamento pós 2ª reprovação Astra da v2). Este arquivo prevalece sobre pontos contraditórios em `domain/changelog-spec-review.md` e `domain/flow-spec-review.md` (históricos) e sobre qualquer texto anterior das specs ativas. Specs atualizadas para refletir: `specs/active/changelog-product-20260921.md` (v3) e `specs/active/flow-integrity-20260921.md` (rev. 3). Só documentação nesta rodada — nenhum código implementado.

## A. Changelog — editorial 100% GLOBAL (v3)

- **A1.** Uma única timeline global do produto. **NADA de timeline tenant em `/novidades`** (usuário pediu global produto); **nenhuma dimensão tenant** (coluna, campo, filtro, payload) no modelo editorial novo.
- **A2.** **Zero sync runtime release→post.** A publicação técnica (`/root/versions/:id/publish`, auto-publish AI) nunca escreve em `changelog_posts`. APIs releases técnicas legadas intocadas com suas permissões. Elimina o estado duplicado perigoso e a lacuna de auto-publish — a feature nunca foi pedida.
- **A3.** `changelog_posts` são entradas editoriais **manuais e independentes**. `release_id` é proveniência **opcional** (UNIQUE parcial, ON DELETE SET NULL): só de backfill/import one-off **explícito e curado** de entradas **comprovadamente globais** (`tenant_slugs_detected='{}'` e sem itens restritos); **não importar título/summary tenant-restritos** (skip + log). Import seguro é **opcional e NÃO é gate**; nunca roda no runtime.
- **A4.** Removidos do modelo editorial novo (vs. v2): `tenant_slugs`, `has_restricted_changes`, `manual_override`, `source`, `content_md`/`changes`. O isolamento vem de manter o legado intocado, não de replicar seu escopo.
- **A5.** **Nenhum markdown foi requerido:** corpo = texto completo preservado por parágrafos + mídias/links estruturados. **Sem parser regex markdown custom, sem HTML raw** (proibido `dangerouslySetInnerHTML`). Campo do contrato: `contentText` (`content_text` no DB). A simplificação preserva conteúdo completo, GIF/vídeo/links.
- **A6.** **`modules_affected TEXT[]` e a entrada admin `modulesAffected` DEVEM existir** (payload exigia, schema v2 omitia). Manter `affected_plans` (validado contra tabela de planos) e `author`.
- **A7.** **FE admin concreto obrigatório:** criar `/root/changelog/page.tsx` com ciclo de vida completo em UI — forms, upload, mídia, preview (não é só endpoints).
- **A8.** **Mídia revogável:** `Cache-Control: no-store` em mídia/preview; páginas não servem `published` de cache (render dinâmico) — unpublish/delete refletem imediatamente; **elegibilidade verificada ANTES de qualquer 304**; logs de ciclo de vida; testes de header exatos.
- **A9.** Feed único: visibilidade PUBLIC GLOBAL publicado para **público + Novidades**; o autenticado acrescenta `postId`/`read` por usuário (`changelog_reads`); **nenhuma exposição TENANT** em payload algum.
- **A10.** **Multipart permitido condicionalmente** (`@fastify/multipart`): versão compatível com Fastify 5 verificada NA EXECUÇÃO + dono único em package.json e lock. **Remover a alegação de dependência "APROVADA"** — worker não aprova sozinho; aprovação final ocorre na revisão do patch.
- **A11.** **`app.ts` é do worker GLM de integração, exclusivo — nunca Astra.** Nenhuma rota registrada por este worker (patch entregue ao orquestrador).
- **A12.** Mantém a superfície editorial: create / edit / draft / schedule / cancel / unpublish / delete / permalink estável / read-state post-user; tabelas, FKs, mídia e permissões conforme spec.
- **A13.** Testes: remover cenários de sync inválidos e de editorial cross-tenant (global não tem); **testar não-vazamento do legado tenant** (nenhum campo de releases/tenant no público).
- **A14.** Migration própria única, **número livre** (dogma "zero migrations" retirado; evitar colisão do 0176 duplicado).

## B. Fluxos — CAS por revisão de linha (rev. 3)

- **B1.** CAS por `MAX(flow_versions)` (v2) é **insuficiente**: nome/ativo/PATCH roles não versionam, e a ativação desativa outro fluxo sem revisão. Token = **coluna `qualification_flows.revision INTEGER NOT NULL DEFAULT 1` com trigger `BEFORE UPDATE`** que incrementa `OLD.revision+1` em QUALQUER mudança de linha. **Migração única futura, número livre** (retirar o dogma "zero migrations"). O CAS não depende de número de snapshot; snapshots em `flow_versions` preservam o histórico de forma independente.
- **B2.** GET/list/PUT/PATCH/restore respondem `revisao`. `revisao_base` opcional integer ≥0: **0 = AUSENTE/nova criação** (sucesso → INSERT com revision 1; existente → 409); **≥1 = iguala revision vivo**; divergente ⇒ 409 `FLOW_VERSION_CONFLICT` sem gravar nada. Compat legado: token omitido documentado; UI sempre envia; PUT sem token não dá claim de frescor (só comportamento legado).
- **B3.** Comparação sob **serialização transacional por tenant** — `pg_advisory_xact_lock` por tenant (padrão existente no repo, ex. `billing/ledger.ts:17`; introduzir se ausente) — cobrindo **criação simultânea, upsert, ativação (desativa outro fluxo), restore e PATCH roles** (`routes.ts:130`).
- **B4.** Guards **desde o começo da tx**; definition lida **dentro do lock**; refs validadas **dentro da tx** (consistente); conflito não cria snapshot (sem fantasma).
- **B5.** **Bypass de nome/ativo REMOVIDO** (contradição R2×EdgeCase100 da v2): toda mutação é CAS-guardada; o trigger incrementa a revisão em qualquer UPDATE.
- **B6.** **Restore revalida** session/tag/stage/agent do tenant (não só PUT) **e ativação** (activationIssues em fluxo ativo → 400).
- **B7.** Regressão **N≥5 sobre a MESMA base** cobrindo: missing-id com `revisao_base=0` (criação), nome-only, PATCH role, active-other, restore — exatamente 1 sucesso/N−1 409, revision contígua, zero snapshots fantasma.
- **B8.** Branch: superRefine usa **`variable_name`** — v2 correta; **não mudar para `field`**.
- **B9.** Posições do grafo: **não persistir nesta rodada é aceitável** SE o movimento não corrompe o grafo e o reload faz re-layout explícito — **auditar movimento** (pedido do usuário).
- **B10.** Frentes FE/BE separadas por path (WP-A/WP-B/WP-C sem conflito de arquivos).

## C. Execução

- **C1.** Só SPECs/documentação nesta rodada; nenhum código implementado.
- **C2.** Gate Jev: `tooling/jev_gate.py` não pousou (`BLOCKED-jev-gate-401.md` em tooling/) → **PENDING**; nenhum PASS pode ser alegado. Quando pousar: ler README e rodar os gates antes do DoD.
- **C3.** Orçamento respeitado: ≤8 chamadas, sem exploração ampla nova (probe único: tooling/jev, PATCH em `qualification/routes.ts:130`, padrão advisory lock, listagem de domain/).

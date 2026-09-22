# SPEC: Integridade determinística do editor de fluxos (item 2) — rev. 3 (contratos finais CAS)

> **Status:** rev. 3 — fechamento final após 2ª reprovação (2026-09-21). CAS trocado de `MAX(flow_versions.version)` para **coluna `qualification_flows.revision` com trigger**; bypass de nome/ativo REMOVIDO; refs validadas também no restore; migração única autorizada (dogma "zero migrations" retirado). Decisões vinculantes: `domain/final-contract-decisions.md`.
> **Ownership deste documento:** só `specs/active/flow-integrity-20260921.md` e `domain/final-contract-decisions.md`. Nenhum código nesta fase (documentação only).
> **Gate Jev:** **PENDING** — `jev_gate.py` não pousou (`tooling/` contém `BLOCKED-jev-gate-401.md` + evidência de recuperação). Nenhum PASS pode ser alegado; re-avaliar quando pousar (ler README e executar antes do DoD).

## Objective
Fechar as lacunas restantes de integridade do editor de fluxos/robôs sobre o estado pós-auditoria (outbox/validação v7/parseTrace/removeStep commitados em 2.0.11 — `dc7bfe0a`): editar nós v7 no painel, eliminar sobrescrita silenciosa entre salvamentos concorrentes (**CAS por revisão monotônica de LINHA, cobrindo TODAS as mutações e criação concorrente**), expor recuperação por versões via endpoints existentes, tornar erros acionáveis e pinar regressões — sem autosave, sem rota nova, com **UMA migration** (coluna `revision` + trigger).

## Source
comments.md L106–198 (item 2). Auditoria base: `.hermes/state/audit-flows/AUDITORIA-FLUXOS.md`. Contratos verificados linha a linha nesta revisão: `apps/backend/src/modules/qualification/flow.ts`, `routes.ts`, `apps/panel/app/fluxos/[id]/page.tsx`.

## Contratos reais (fonte única, verificado HEAD)
- `flow.ts:18-25` — opção de nó tem campo **`url`** (não `cta_url`); opcional, http(s), max 500. `cta_url` só existe como CONCEITO de UI (botão que abre link), nunca como campo do zod.
- `flow.ts:117-127` — **branch e condition são idênticos**: `variable_name` (regex `^[a-z0-9_]+$`, max 100) + `operator` (eq/neq/contains/not_contains/starts_with/is_empty/is_not_empty) + `value` (max 200; **obrigatório** exceto is_empty/is_not_empty, onde é **proibido** — superRefine `flow.ts:204-208`) + **`transitions: { yes, no }`** obrigatórios (`flow.ts:209-210`). NÃO é "pergunta + opções Sim/Não".
- **Confirmado (rev. 3):** o superRefine de branch/condition valida **`variable_name`** — a v2 está correta; **proibido** alterar o contrato para `field` ou qualquer outro nome.
- `flow.ts:123-127` — interactive: `interactive_type` (buttons|list), `interactive_button_text` (1-60), `interactive_section_title` (1-60), `interactive_sections` (≤10 seções, título 1-60, linhas 1-10 cada, texto 1-60, descrição ≤100); buttons usa `options` **≤3** (`flow.ts:223-224`); escolhas roteiam por `transitions[value]` ou `next` (`flow.ts:236-240`); `options[].url` = cta_url.
- Limites reais do zod que os forms devem espelhar: question ≤2000, message ≤4000, options ≤20, option.value 1-200, keywords ≤200 chars cada, template ≤8000, wait/timeout 1–1440, tag_ids ≤50, end_reason 1-200, triggers.session_ids ≤100, keywords ≤100.
- `routes.ts:28` — GET retorna **`atualizado_em`** (não `updated_at`); `routes.ts:152-185` — lista de versões retorna id/version/flow_name/created_by/created_at e **NÃO fornece definition**; `versionId` do restore é o **UUID** de `flow_versions.id` (`routes.ts:248`), não o número da versão.
- `routes.ts:130` — **existe `PATCH /qualification/flows/:id`**: edição parcial de linha (incl. campos de papel/role). É mutação CAS-guardada na rev. 3 (a v2 não a cobria).
- **Posições do grafo não são persistidas** em lugar nenhum (nem no definition — o zod não tem campo de posição — nem em tabela; grep em panel+backend sem match). Layout é memória do React Flow. Proibido afirmar roundtrip de posições em qualquer teste/AC.

## Current State (evidências, HEAD 03bd698d / 2.0.11)
- FE: `app/fluxos/[id]/page.tsx` (128 ln; save manual — **não existe autosave**; SWR default). `flow-editor.tsx` (844 ln), `flow-model.ts`.
- Painel de propriedades sem forms para branch/condition/finalize/interactive (grep HEAD: só tokens de cor em `flow-editor.tsx:98,102`).
- BE PUT `routes.ts:80-125`: `requirePermission("agent.manage")`; `FOR UPDATE` só quando `body.definition`; snapshot por save com definition. **Last-write-wins: sem guarda otimista.**
- **Classe stale-read comprovada (corrigir):** (a) `routes.ts:84-87` — PUT **sem** definition lê a definition atual **fora** da transação e a regrava no upsert (L116) → escrita concorrente entre leitura e upsert regenera definition antiga; merge de triggers sobre base obsoleta. (b) `routes.ts:249-252` — restore lê `name,active` **fora** do lock e usa `name` obsoleto no snapshot.
- Endpoints de versão prontos e sem caller no painel: GET `/versions` (:157), `/versions/diff` (:208), POST `/versions/:versionId/restore` (:246, já com `FOR UPDATE` + re-parse zod → 409 em drift de schema).
- Isolamento tenant: PK `(tenant_id,id)` + `tenant_id` em toda query. **NÃO afirmar "acesso a dados intocado"**: esta SPEC adiciona validação de referências cross-tenant (abaixo — agora em PUT, PATCH **E** restore).
- **Padrão advisory lock já existe no repo** (ex.: `billing/ledger.ts:17` — `pg_advisory_xact_lock(hashtext('financial_ledger:' || $1))`): reutilizar o padrão com chave por tenant.

## Requirements

### R1 — Edição v7 no painel (property forms; JSON dialog é opcional)
`flow-editor.tsx` + `flow-model.ts`:
- Forms por kind espelhando EXATAMENTE os contratos acima: `branch`/`condition` (variable_name + operator com ocultação de value p/ is_* + transições yes/no), `finalize` (end_reason), `interactive` (modo buttons: opções ≤3 com value + url opcional; modo list: seções/linhas + button_text + section_title), `message`/`delay`/`wait_for_reply`/`action` (com validação de action_type exigida pelo superRefine `flow.ts:185-198`).
- Consolidar `PALETTE` (`flow-model.ts:98-126`) e `PALETTE_GROUPS` (`flow-editor.tsx:808-836`) em fonte única (flow-model) — mata o drift (audit #22).
- **JSON dialog NÃO é requisito.** Opcional apenas como escape hatch mínimo se um kind ficar impossível de editar via form; justificar o uso no PR; nunca substitui forms.
- Nenhuma rota nova; PUT existente (e PATCH existente `routes.ts:130` — mesma guarda CAS).
AC (painel vitest): para cada kind v7, criar→editar→salvar via UI gera payload PUT com os campos/limites do zod; rejeição client antes do save; arestas honestas (transitions yes/no e choices de interactive viram edges).
Verification: `npx vitest run tests/flow-editor.test.tsx` + `npx tsc --noEmit`.

### R2 — CAS de concorrência por REVISÃO DE LINHA (substitui INTEGRALMENTE o R2 da rev. 2)
**Token = coluna `qualification_flows.revision INTEGER NOT NULL DEFAULT 1` com trigger `BEFORE UPDATE` que força `NEW.revision := OLD.revision + 1` em QUALQUER mudança da linha** — nome, ativo, definition, roles, qualquer coluna (inclusive touch de `updated_at`; qualquer `SET revision` manual é sobrescrito pelo trigger). Proibido comparar timestamps (JS serializa ms; pg guarda µs → falso conflito). **Proibido derivar o token de `flow_versions.version`**: o número de snapshot preserva o histórico e é INDEPENDENTE do CAS; toda escrita de linha incrementa a revisão automaticamente, mesmo mutação que não versiona snapshot.

**Migração única (número livre; dogma "zero migrations" RETIRADO desta spec):**
```sql
ALTER TABLE qualification_flows ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
-- trigger BEFORE UPDATE: NEW.revision := OLD.revision + 1 (sempre, qualquer coluna alterada)
```
Linhas legadas nascem em revision=1; o token corre a partir do valor vivo (não há backfill); `flow_versions.version` continua contando snapshots, independente.

Mapeamento de nomes: DB `revision` ↔ API `revisao` (resposta) e `revisao_base` (escrita) — coerente com `atualizado_em`.

Contrato único e completo (definitivo):
- **`revisao_base` opcional, integer ≥0.**
  - `0` = "acredito que o fluxo está AUSENTE/nova criação": sucesso exige linha inexistente → INSERT nasce com `revision=1`. Linha existente (revision ≥1) → **409** `{code:"FLOW_VERSION_CONFLICT", revisao}` sem gravar nada.
  - `≥1` = deve igualar o `revision` vivo da linha; divergente ⇒ **409** sem gravar nada.
  - Ausente ⇒ comportamento legado atual documentado (última escrita vence; **sem claim de frescor** — nunca é apresentado como "não perde dados de terceiros", apenas mantém o comportamento de hoje). UI **sempre** envia o token.
- **GET single e lista** (`flowMapper`, `routes.ts:21-30`): incluir `revisao` (valor da coluna — sem subquery MAX; CAS não depende de snapshot).
- **PUT (`routes.ts:80`), PATCH (`routes.ts:130`) e Restore (R3)**: toda mutação é CAS-guardada quando o token vem. **BYPASS de nome/ativo REMOVIDO** (a rev. 2 contradizia-se: R2 dizia CAS completo e EdgeCase dizia "PUT só nome/ativo ignora CAS" — removido; o trigger incrementa em qualquer update e toda rota valida o token).
- **Ativação (1 fluxo ativo por tenant, unique parcial 0039)**: ativar um fluxo desativa o anterior — **UPDATE de linha → revision do fluxo anterior incrementa automaticamente pelo trigger**. A requisição de ativação valida `revisao_base` do fluxo alvo (mutação CAS-guardada também). O editor do fluxo desativado recebe 409 no próximo save com token velho — nada é perdido silenciosamente.
- **Criação simultânea coberta:** POST create (e upsert em id ausente com `revisao_base=0`) sob lock por tenant — criações concorrentes do mesmo alvo: exatamente 1 sucesso (revision 1), as demais 409 com `revisao` atual.
- **Serialização transacional por tenant:** toda mutação abre transação e toma `pg_advisory_xact_lock(hashtext('flow:' || tenant_id))` (padrão existente no repo, cf. `billing/ledger.ts:17`) **antes de ler a linha**; `FOR UPDATE` mantido como segunda barreira; **definition lida dentro do lock**; refs (`session_ids`, `tag_ids`, `stage_id`, `agent_id`) validadas **dentro da mesma tx** (snapshot consistente); guards (CAS + refs + ativação) todos **desde o começo da tx**; snapshots em `flow_versions` preservam o histórico de forma independente (linhas de versão nunca reescritas; **conflito não cria snapshot** — sem snapshot fantasma).
- Editor: guarda `revisao` do GET; envia `revisao_base` em todo save; no 409 mostra modal "fluxo alterado (revision N) por outro salvamento — recarregar" com Recarregar (SWR mutate) e link para Histórico (R3).

AC (backend integração — **MESMA base; zero snapshots fantasma**):
1. GET → revisao=R. PUT A (revisao_base=R) → 200, revision→R+1. PUT B (revisao_base=R) → **409**, definition de A intacta, revision inalterada, **nenhum snapshot novo**.
2. **Concorrência real N≥5 sobre a MESMA base, cobrindo os 5 tipos de mutação**, cada um com N requests da mesma `revisao_base`: (i) missing-id com `revisao_base=0` (criação concorrente — 1 INSERT revision 1, N−1×409); (ii) PUT só nome; (iii) PATCH role; (iv) ativação (desativa o fluxo ativo anterior — verificar revision do desativado incrementada pelo trigger); (v) restore. Em cada cenário: **exatamente 1 sucesso e N−1 409**, revision contígua, **nenhum snapshot criado em estado de conflito**, nenhuma perda de dados.
3. PUT sem `revisao_base` → 200 (legado, documentado); cliente com token não é degradado pelo legado além do comportamento já existente.
4. PUT triggers-only sob definição concorrente: merge usa a definition lida **no lock** (nunca a do início do request); snapshot só se a definition resultante mudar.
Verification: `npx tsx scripts/run-tests-disposable.ts tests/qualification-flow-routes.integration.test.ts`.

### R3 — Recuperação por versões no painel (endpoint EXISTENTE, sem duplicar API)
Novo `apps/panel/components/flow-editor/flow-history.tsx`:
- Lista GET `/qualification/flows/:id/versions` (versão, data, autor, nome — a lista **não** traz definition; não depender dela).
- Restaurar → confirmação comparando contagem de etapas/arestas (via `/versions/diff` se necessário) → **POST `/qualification/flows/:id/versions/:versionId/restore`** (versionId = UUID da linha) enviando `revisao_base`; trata 409 igual ao save.
- Escopo: recuperação simples apenas. Sem diff visual rico (o endpoint existe; UI de diff só se custo mínimo).
Guards do restore (extensão do existente, consistentes com PUT/PATCH — `routes.ts:246-274`):
- Ler `name` **dentro** do lock (mata stale-read (b)); `active` permanece intocado pelo restore.
- CAS opcional `revisao_base` (R2) — mesmo 409.
- **Refs de tenant revalidadas NO RESTORE (não só no PUT):** `session_ids`, `tag_ids`, `stage_id`, `agent_id` da definition restaurada devem existir nas tabelas do tenant — validadas **dentro da tx** (400 acionável quando não).
- **Ativação revalidada:** se o fluxo estiver `active` e a definition restaurada tiver `activationIssues` ⇒ 400 acionável, sem mutação parcial (mesma regra do PUT com `ativo`).
- Zod re-parse já existe (409 em drift) — manter.
AC (vitest): lista renderiza; restaurar dispara POST restore com versionId correto; 409 tratado; backend: restore em fluxo ativo com issues de ativação → 400 e definition/versão inalteradas; restore com refs de outro tenant → 400.
Verification: `apps/panel/tests/flow-history.test.tsx` (novo) + suíte backend.

### R4 — Erros acionáveis
- Issues do `validateDefinition` (com `stepId`) → lista clicável que seleciona/foca o nó no canvas (hoje: bloco de texto único).
- Erros 400/409 do servidor (activationIssues, FLOW_VERSION_CONFLICT) exibidos na íntegra + botão Recarregar no 409 — sem parsing inventado.
AC (vitest): clicar issue foca nó; 400/409 mostram payload integral.

### R5 — Integridade do editor (estado local, navegação, ciclo de operações)
Estado local (painel, `app/fluxos/[id]/page.tsx`):
- **SWR revalidação NÃO apaga dirty local state** (hoje garantido por shadow state `definition ?? loaded` — pinar com teste: mutate/revalidate com resposta nova não reseta edits não salvos).
- **Save com resposta velha após trocar de rota NÃO sobrescreve outro fluxo** (`flowId` capturado no closure — pinar com teste: desmonta/navega antes da resposta; assert que o PUT foi ao id original e setters pós-desmonte são seguros).
- **Navegação/saída com dirty avisa**: guardar dirty real (definition/nome alterados vs última carga) + aviso ao sair (beforeunload e navegação interna) sem perder o trabalho silenciosamente.
- **Movimento/posições (audit exigido pelo usuário):** posições NÃO persistem nesta rodada — **aceitável SE**: (a) mover nós (drag) não corrompe o grafo — nós, arestas e referências (transitions yes/no, choices, next, on_timeout, on_invalid_reply) intactos após save+reload; (b) reload re-deriva o layout de forma explícita e determinística (re-layout documentado no editor, nunca layout fantasma). AC: mover nó → salvar → recarregar → grafo íntegro (mesmos nós/arestas/ids), posições podem divergir (vitest + browser real).
Ciclo de operações (pinagem do determinismo) — criar/editar/**mover**/delete/duplicate/**reconnect**/ordem/branch/ações/save/reload, **IDs e referências todos** (start, next, transitions yes/no, on_timeout, on_invalid_reply, choices de interactive, action refs tag/stage/agent), em **fluxo simples e all-kinds-v7**:
- Backend (`tests/qualification-flow-operations.integration.test.ts`, novo): sequência de PUTs → definition final valida no zod, sem referências órfãs, ids estáveis (exceto removidos), **revision +1 por mutação (trigger), snapshot version +1 só quando a definition muda**, restore retorna snapshot íntegro.
- Painel (`tests/flow-model-roundtrip.test.ts`, novo): definition↔graph↔definition sem perda de campos em cada operação. **Proibido testar roundtrip de posições** (não persistem — ver Contratos).
- **Browser real (obrigatório, não só fonte-string)**: Playwright/fluxo real cobrindo ciclo mínimo editar→conectar→**mover**→salvar→recarregar→conferir nós/arestas; teste de fonte genérica não substitui.
Verification: ambos via `run-tests-disposable.ts`; painel vitest + build; browser suite registrada com exit code.

### R6 — Gates de execução (RESTRIÇÃO DE HARNESS — decisão do usuário, OBRIGATÓRIA)
- Banco: sempre `scripts/run-tests-disposable.ts`. **Nunca** banco de produção.
- Redis compartilhado (`REDIS_URL` default `redis://localhost:6382/15` não isolado pelo harness) → suítes DB/Redis em **série**; paralelismo só com isolamento de namespace provado. Harness não modificado.
- Painel: `npx vitest run` + `npx tsc --noEmit` + `npm run build` (eslint 0 warnings) — sem Redis.
- **Gate `tooling/jev_gate.py`: PENDING** — não pousou no repo nesta data (`tooling/` contém `BLOCKED-jev-gate-401.md`). Nenhum PASS pode ser alegado; re-avaliar quando o gate pousar (ler README e executar antes do DoD).
Verification: comandos com exit codes em `.hermes/state/comments-spec-loop/20260921/`.

## Invariants
- Step ids estáveis: upsert por id; salvar nunca recria o grafo do zero (`flow-editor.tsx:3-9`).
- Salvar nunca apaga nós/arestas não tocados; nenhuma normalização silenciosa (erro explícito, nunca auto-fix).
- 1 fluxo ativo por tenant (unique parcial 0039) e `tenant_id` em toda query. **Referências cross-tenant validadas no PUT, PATCH E RESTORE** (mesmo padrão de session_ids, `routes.ts:96-102`): `tag_ids`, `stage_id`, `agent_id` de steps action devem existir nas tabelas do tenant correspondentes — 400 acionável quando não. (Implementação confirma os nomes exatos das tabelas de tags/estágios/agentes no schema antes de codar; este é o único ponto de contrato a resolver lá.)
- **`revision` é o único token de concorrência e cobre TODA mutação de linha** (trigger incrementa em qualquer UPDATE: nome, ativo, definition, roles, touch). Timestamps nunca comparados; CAS nunca derivado de snapshot.
- Snapshot em `flow_versions` só quando a definition muda; conflito não cria snapshot; versões nunca reescritas.
- Toda mutação de fluxo é serializada por tenant (advisory xact lock) com leitura da definition e validação de refs **dentro da tx**.

## Edge Cases
- Duas abas: segunda salva → primeira toma 409 no próximo save → recarrega (nunca sobrescreve).
- Criar/duplicar: linha nasce com `revision=1` (DEFAULT, sem snapshot); primeira mutação → revision=2 (snapshot version 1 se a definition mudou).
- Criação concorrente (mesmo alvo, `revisao_base=0`): 1 sucesso, demais 409 — sem duplicar linha, sem snapshot fantasma.
- PUT/PATCH só nome/ativo: **CAS normal** (revision incrementa pelo trigger; token exigido como nas demais mutações) — bypass da rev. 2 REMOVIDO; snapshot não é criado (definition não mudou).
- Ativação concorrente: revision do fluxo desativado incrementa pelo trigger; CAS do fluxo alvo aplica normalmente (409 antes do `activationIssues`).
- Restore de versão antiga rejeitado pelo zod atual → 409 acionável (existente), sem mutação parcial.
- Restore com refs de outro tenant → 400; restore em fluxo ativo com activationIssues → 400.
- PUT sem definition mas com triggers: definition lida e mesclada **no lock**; snapshot se mudou.
- Cliente legado sem `revisao_base`: comportamento atual preservado; UI sempre envia o token.
- Layout/posições do canvas: volátil por sessão; reload re-deriva explicitamente — nunca persistido nem afirmado (audit R5).

## Dependencies / Work packages (arquivos exatos)
- **WP-A (FE v7 + erros + estado local)**: `flow-editor.tsx`, `flow-model.ts`, `app/fluxos/[id]/page.tsx` (dirty/409/revisao_base), `tests/flow-editor.test.tsx`, `tests/flow-model-roundtrip.test.ts` (novo).
- **WP-B (CAS BE + revision + stale-read + refs cross-tenant)**: `qualification/routes.ts` (PUT/PATCH/restore), **migration ÚNICA `<n>_flow_revision_cas.sql`** (número livre: ADD COLUMN revision + trigger), `tests/qualification-flow-routes.integration.test.ts`, `tests/qualification-flow-operations.integration.test.ts` (novo). Frentes FE/BE separadas por path — sem conflito de arquivos com WP-A.
- **WP-C (Histórico)**: `flow-history.tsx` (novo), `tests/flow-history.test.tsx` (novo).
- **UMA migration, zero dependências novas. app.ts intocado.**

## Non-goals
Autosave; edição multiusuário em tempo real; JSON dialog como requisito (opcional justificado); **persistência de posições do grafo** (fora desta rodada — audit de movimento em R5); diff visual rico; gatilhos de evento do legado; consent/mídia no motor; histórico como objetivo em si (mantido só como recuperação de perda, custo mínimo); qualquer rota nova.

## Required Tests
Por R (AC acima); regressão obrigatória: 68+7 de fluxo verdes + `flow-editor.test.tsx` estendido + novos (operações, roundtrip, history) + browser real do ciclo mínimo **incluindo movimento de nó** (grafo íntegro + re-layout explícito).

## Definition of Done
- [ ] R1–R6 verificados com exit codes reais registrados
- [ ] 409 provado com positive control e matriz de regressão N≥5 MESMA base nos 5 tipos de mutação (missing-id creation0, nome-only, PATCH role, active-other, restore) — zero perda, zero snapshot fantasma, revision contígua
- [ ] Trigger de `revision` provado (qualquer UPDATE incrementa; SET manual é sobrescrito)
- [ ] Stale-read eliminados (PUT sem definition e restore) provados por teste de corrida
- [ ] Refs cross-tenant (tag/stage/agent/session) validadas no PUT, PATCH e RESTORE com teste 400
- [ ] Editor: dirty sobrevive revalidação; save tardio não escreve em outro fluxo; saída com dirty avisa (testes + browser real)
- [ ] Audit de movimento: drag não corrompe grafo; reload re-layout explícito (prova)
- [ ] branch superRefine em `variable_name` preservado (sem mudança para `field`)
- [ ] tsc/eslint/build/vitest verdes; suítes Redis em série
- [ ] Nenhuma edição em app.ts ou comments.md; UMA migration (revision+trigger, número livre); gate jev PENDING explicitado (sem PASS)

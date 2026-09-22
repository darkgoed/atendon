# Review de contratos e concorrência — SPEC flow-integrity-20260921 (rev. 2)

Data: 2026-09-21. Verificação linha a linha em HEAD 03bd698d. Escopo: só documentação (SPEC); nenhum código/DB alterado.

## Correções aplicadas à SPEC (comprovadas na fonte)

1. **Opção do nó usa `url`, não `cta_url`** — `flow.ts:18-25`. `cta_url` é conceito de UI; campo real é `url` (http(s), ≤500, opcional). SPEC rev.1 ("opções com cta_url") corrigida em R1.
2. **branch/condition não é pergunta+opções booleanas** — `flow.ts:117-127,200-211`: `variable_name` + `operator` + `value` (obrigatório exceto is_empty/is_not_empty, onde é proibido) + `transitions: {yes,no}` obrigatórios. SPEC rev.1 descrevia "pergunta + opções Sim/Não" — corrigido.
3. **Interactive inclui buttons E list** — `interactive_type` (buttons|list), `interactive_button_text` (1-60), `interactive_section_title`, `interactive_sections` (≤10×10 linhas); buttons ≤3 opções; choices roteiam por `transitions[value]`/`next` (`flow.ts:236-240`). Limites zod reais tabelados na SPEC.
4. **`atualizado_em`, não `updated_at`** — `routes.ts:28`. AC/contratos da SPEC usam o campo real.
5. **Lista de versões não fornece definition** — `routes.ts:157-185` retorna id/version/flow_name/created_by/created_at + cursor keyset. R3 rev.1 ("PUT com a definition da versão escolhida") era impossível — corrigido: UI chama **POST `/qualification/flows/:id/versions/:versionId/restore`** (endpoint existente; `versionId` = UUID de `flow_versions.id`, `routes.ts:248`). Nenhuma API duplicada; guarda CAS + validações estendidas no próprio restore.
6. **CAS por token de versão monotônica, não timestamp** — pg guarda µs e JS serializa ms ⇒ comparar `updated_at` gera falso conflito. Contrato único fechado na SPEC: `revisao = MAX(version) COALESCE 0` (criação/duplicata = 0), retornado em GET single/lista, PUT e restore; PUT/restore aceitam `revisao_base` opcional; comparação **dentro da transação, após FOR UPDATE**; 409 `{code:"FLOW_VERSION_CONFLICT", revisao}` sem gravar. Sem `revisao_base` ⇒ comportamento atual (legado preservado).
7. **Classe stale-read corrigida (não só definition-saves)**:
   - PUT sem definition lia a definition **fora** da transação (`routes.ts:84-87`) e a regravava no upsert (L116) → leitura+merge de triggers agora sob `FOR UPDATE`, com snapshot quando a definition muda.
   - Restore lia `name` **fora** do lock (`routes.ts:249-252`) → leitura movida para dentro.
8. **Teste R2 rev.1 era incorreto** ("PUT B com base de A pode ser fresh"): substituído por 2 snapshots da MESMA base (primeiro save 200, segundo 409) + concorrência N≥5 nos dois sentidos (1 sucesso/4 409; sequencial re-basando = versions contíguas), zero perda e zero snapshot em estado de conflito.
9. **Refs cross-tenant de action steps** (`tag_ids`/`stage_id`/`agent_id`) hoje não são validadas no PUT (só `session_ids` são, `routes.ts:96-102`) → SPEC exige validação pelo mesmo padrão. **Não afirmo mais "acesso a dados intocado"** — o tenant access será tocado neste ponto.
10. **JSON dialog rebaixado a opcional** (não é requisito; não substitui forms) e **histórico mantido só como recuperação** de custo mínimo — sem escopo extra.

## Estado local do editor (pinado como AC em R5)
- SWR revalidação não apaga dirty: hoje garantido por shadow state (`page.tsx:41-52`, `definition ?? loaded`) — teste para travar.
- Save com resposta velha após trocar rota não sobrescreve outro fluxo: `flowId` é capturado no closure do save (`page.tsx:54-71`) — o PUT vai ao fluxo original; teste para travar (desmonte antes da resposta).
- **Falta hoje**: aviso ao sair com dirty (não existe guard de navegação) — novo requisito em R5.

## Posição do grafo
Nada persiste posições: o zod de definition não tem campo de posição e não há tabela/coluna para layout (busca "position"/"layout" em panel+backend só bate em pipeline_stages/dashboard). Layout é memória do React Flow, re-derivado no load. A SPEC proíbe afirmar/testar roundtrip de posições.

## Gaps abertos
- **jev_gate (`tooling/jev_gate.py`): PENDING** — não existe no repo (busca `jev` = 0). Nenhum PASS alegado; executar/ler README quando pousar, antes do DoD.
- **Nomes exatos das tabelas de tags/estágios/agentes** para a validação de refs: confirmar no schema na implementação (migrations não estão em `apps/backend/migrations`; caminho real a localizar lá). Padrão e semântica já fechados na SPEC.
- Restore de fluxo ativo com `activationIssues` → 400 (novo na SPEC, consistente com PUT); se produto preferir permitir, é decisão explícita a registrar.
- Suítes browser reais dependem do harness Playwright existente do painel; se indisponível, registrar como gap em vez de simulado.

## Arquivos
- `specs/active/flow-integrity-20260921.md` — SPEC rev. 2 (reescrita integral).
- `domain/flow-spec-review.md` — este review (criado).

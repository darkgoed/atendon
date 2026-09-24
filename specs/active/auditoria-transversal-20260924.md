# SPEC: auditoria transversal e correção da criação de fluxos — 2026-09-24

## Objective
Depois da SPEC dos comentários, testar caminhos reais do AtendON inteiro, registrar achados concretos e corrigir causas-raiz reproduzíveis; especialmente a impossibilidade relatada de criar um fluxo de robô.

## Source
Pedido do usuário nesta sessão; `comments.md` não contém a falha de fluxo. Referência funcional condicionada: `crm-whatsapp`, nunca substituir a implementação mais nova do AtendON.

## Current State
`apps/panel/app/fluxos/page.tsx:61-70` gera ID e envia PUT `/qualification/flows/:id` com definição inicial e `revisao_base:0`; `apps/backend/src/modules/qualification/routes.ts:142-180` implementa PUT. Sete testes de CAS backend passam em banco descartável, porém não testam a definição inicial real da UI nem o fluxo de criação browser→API→DB→editor.

## Desired Behavior
Criar fluxo funciona para usuário autorizado, navega para o editor e persiste definição válida; rejeita com motivo acionável sem permissão. Auditoria busca falhas silenciosas, fake/stub, estado incompleto, tenancy, concorrência, jobs perdidos e integrações quebradas, com prova reprodutível; a ausência de achados numa área não significa prova de ausência de defeitos.

## Requirements
### R1 — Criar fluxo de robô
Reproduzir exatamente o payload da UI, com `starterDefinition()`, `newFlowId()`, permissão real e mesmo esquema do backend; capturar status/body seguro e seguir a resposta até a navegação/editor. Comparar comportamento relevante do crm-whatsapp apenas após a reprodução.
Acceptance Criteria:
- Teste RED demonstrou falha específica anterior; correção GREEN cria o fluxo via UI→API→DB e abre editor com nós íntegros.
- Operador sem `agent.manage` não cria e recebe orientação; tenant B não acessa/edita fluxo de A; clique duplo e CAS concorrente não duplicam.
Verification:
- Vitest da lista sem mocks do modelo de definição; integração real `app.inject` em banco descartável; browser E2E com fixture autenticada; teste negativo de permissão/tenancy.

### R2 — Varredura priorizada de superfícies
Inventariar frontend e APIs (rotas/contratos), backend (validação/permissões), schema/migrations (constraints/backfills), worker/filas/outbox (produtor→consumidor→retry), WhatsApp/gateway (media/dedup/reconexão), IA (prompt/tools/quotas), fluxos (gatilhos/wait/restart), tenancy/concorrência (queries sem tenant/CAS/claims), UX/estados (loading/error/empty/accessibility), integrações externas (falha controlada/idempotência). Selecionar controles positivos e negativos executáveis em cada área; a lista é roteiro de inspeção, não promessa de prova exaustiva.
Acceptance Criteria:
- Matriz de áreas x seam x teste x resultado x limitações publicada em `.hermes/state/comments-spec-loop/20260924/audit.md`.
- Cada achado confirmado traz reprodução mínima, causa, risco, fix menor seguro, teste de regressão e verificação pós-fix; falso positivo descartado com evidência.
Verification:
- Comandos individuais por módulo e testes end-to-end críticos, outputs/exit codes documentados.

### R3 — Gates finais e revisão
Rodar `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:deploy`, testes backend em bancos descartáveis sequenciais, painel vitest e E2E das telas afetadas; confrontar falhas com baseline sem descartar regressões por contagem global. Jev para risco/decisão/completude; Ponytail FULL para cada implementação e review do diff final, e revisão independente de segurança/tenancy.
Acceptance Criteria:
- Todos gates relevantes passam ou bloqueios externos têm comando/erro reproduzível; decisões Jev não contradizem evidência determinística; sem teste skip/todo novo.
Verification:
- Matriz do gate em `progress.md` desta rodada com exit codes reais; revisão final por agente/contexto independente.

## Invariants
Dados do tenant não vazam; RLS parcial não substitui filtro tenant; provider externo só em fixture/conta de teste; worker não duplica mensagens; estados financeiros e de agendamento preservados; sem chamadas destrutivas em produção; sem deploy sem pedido.

## Edge Cases
Fluxo inicial inválido, permissões ausentes, click duplo, tenant errado, sessão arquivada, worker reiniciado com espera/outbox pendente, webhook inválido, upload inválido e erro de rede após envio incerto.

## Dependencies
Execução após SPEC `comments-20260924-ai-conversas.md`. Teste focal RED de fluxo precede fix. Auditoria read-only pode começar em paralelo em áreas independentes; fixes em passos pequenos e serializados. UI/UX exclusivamente Hermes Claude Opus 5.5 Anthropic direto; backend GLM 5.3 Flash via OpenRouter, reasoning max; orquestrador só planeja/valida. Scripts Jev oficiais via API direta quando gate local ausente.

## Affected Areas
AtendON `apps/{backend,panel}` e testes; migrations somente se reproduções exigirem. Fonte donor `../crm-whatsapp` read-only. Nenhum irmão do monorepo é escopo de write.

## Non-goals
Declarar o código inteiro livre de bugs; portar todo crm-whatsapp; refatorar áreas sem defeito comprovado; modificar produção ou implantar sem autorização.

## Constraints
Não reproduzir com dados privados em logs; testes DB com `run-tests-disposable.ts`; filas Redis em série sem namespace isolado. Fonte antiga em `progress.md` superior é de outra rodada.

## Required Tests
Novo teste real de `starterDefinition()` contra `flowDefinitionSchema`; backend app.inject + browser; suites existentes de qualificação/IA/mídia/agendamento/tenancy/outbox e smoke das rotas; gates R3.

## Definition of Done
- [ ] Falha da conta afetada reproduzida e corrigida com prova UI→API→DB→editor. Bloqueada sem sessão/identificação dessa conta; fluxo equivalente OWNER funcionou em browser local com DB de teste, sem reproduzir o sintoma.
- [x] Matriz R2 preenchida em `.hermes/state/comments-spec-loop/20260924/audit.md`, com achados concretos corrigidos/revalidados e limites explicitados.
- [x] Gates R3 executados e triados; Jev (decisão/completude), Ponytail FULL e revisões independentes registradas em `progress.md`.
- [x] Relatório final em `.hermes/state/comments-spec-loop/20260924/RELATORIO.md` separa encontrado/corrigido/validado/pendente sem alegar exaustão absoluta; grafo atualizado após o último patch.

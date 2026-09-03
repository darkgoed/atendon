# SPEC: Newave — script comercial sem follow-up

## Objective
Atualizar o prompt-fonte da NEWAVE IA e registrar a publicação versionada que cobre as seções não-follow-up de `comments.md`, sem alterar a seção 26 nem implementar follow-up, lembretes, ausência, cadência ou confirmação agendada fora do ato de agendamento.

## Source
`comments.md` (fonte bruta; não editar). A implementação foi autorizada e concluída; esta SPEC registra o resultado verificado.

## Current State
- O prompt-fonte é `instrução-newave-ia.md`; o runtime lê a versão ativa de `agent_config_versions` e `loadNewavePromptTemplate` deve ser exercitado.
- A migration 0128 é a publicação anterior; 0129 pertence a outro trabalho.
- O arquivo obrigatório da próxima migration é exatamente `apps/backend/src/db/migrations/0130_newave_sales_script_prompt.sql`.
- A seção 26, delimitada entre `## 26. Follow-up, lembretes e ausência` e `## 27. Transferência humana`, deve permanecer byte a byte inalterada: SHA-256 `dcdc4ba7bd13a7c1113c9ac037df0ce33c2459f5060a7c9c5ceca0befa4e7b79`.

## Desired Behavior
Arthur atua como SDR no WhatsApp: acolhe o primeiro contato/formulário, qualifica adaptativamente, identifica oportunidade e valor, explica aderência e funcionamento, trata objeções, agenda e pede confirmação imediata. Pode fazer diagnóstico, demonstração orientativa, projeção e explicar investimento com dados autorizados, mas não conduz apresentação humana nem formaliza venda; diante de intenção de compra, registra internamente a intenção, os dados e o próximo passo, sem anunciar transferência para outra pessoa.

## Requirements

### R1 — Cobertura operacional dos scripts não-follow-up
O novo bloco/sufixo deve instruir ação e próxima transição para primeiro contato/formulário, qualificação adaptativa, oportunidade/valor, agendamento/confirmação imediata, preço/material/falta de tempo/funcionamento, diagnóstico/demonstração/projeção/investimento, cada objeção, fechamento por escolha e confirmação e registro interno de intenção, dados e próximo passo, sem transferência anunciada. No primeiro contato, pedir permissão sem prometer duração específica (inclusive “menos de dois minutos”) e sem autorizar rajada: permanece uma pergunta por mensagem.

Acceptance Criteria:
- Cada bloco contém ação, condição de dados/capacidade e próxima ação verificável.
- Somente o NOVO BLOCO/SUFIXO comercial não contém conteúdo dos blocos excluídos; a seção 26 preexistente continua idêntica.
- Confirmação é registro interno de intenção, dados e próximo passo, não transferência anunciada nem venda formalizada.

Verification:
- Teste textual enumera cada bloco e rejeita ausência de ação/transição.
- Teste compara a seção 26 antes/depois byte a byte e verifica que o sufixo não contém os blocos excluídos.
- Teste verifica no primeiro-contato a permissão sem duração fixa, sem rajada e com uma pergunta por mensagem.

### R2 — Qualificação e regra de perguntas
A regra recente substitui o teto antigo de somente duas perguntas comerciais. É obrigatório uma pergunta por mensagem, em conversa natural e sem interrogatório; pular campos conhecidos, perguntar apenas o que altera aderência/explicação/próximo passo e avançar com informação parcial. Decisor e momento só são coletados quando alterarem encaminhamento ou agendamento.

Acceptance Criteria:
- O prompt não apresenta teto de duas perguntas como regra vigente.
- Nenhuma mensagem contém duas perguntas independentes nem exige checklist completo.

Verification:
- Sem adicionar código de runtime, o teste carrega o prompt real e verifica as cláusulas operacionais para contexto já conhecido e informação parcial; não alega executar comportamento do LLM.
- O teste também valida que os exemplos do novo bloco não trazem duas perguntas independentes.

### R3 — Agendamento e confirmação
Usar horários reais retornados pela ferramenta; para agendamento normal e objeções não-follow-up, oferecer exatamente 2 quando houver pelo menos 2 e exatamente 1 quando houver uma única opção, sem inventar disponibilidade. A regra 2–3 própria da seção 26 permanece intocada; esta regra 0/1/2 vale somente para o bloco comercial e não a sobrescreve semanticamente. Duração: 20–40 minutos no Google Meet. Após agendar, pedir confirmação imediatamente no mesmo fluxo.

Acceptance Criteria:
- O novo bloco limita 2/1 explicitamente ao agendamento normal e objeções não-follow-up e preserva a regra 2–3 da seção 26.
- Só aparecem horários retornados; a confirmação ocorre imediatamente após o registro.
- Google Meet informa duração entre 20 e 40 minutos.

Verification:
- O teste trata os casos 0/1/2/3 como o contrato textual carregado — 0 não inventa, 1 oferece uma, e 2/3 oferece exatamente duas —, não como um helper ou runtime inexistente.

### R4 — Verdade comercial, segurança e tenant
Projeções usam exclusivamente números fornecidos e são hipóteses sem garantia. Investimento, plano, desconto, material, proposta, contrato, documentação, treinamento e implantação só podem ser mencionados com dado/capacidade oficialmente disponível. Não expor dados de outro tenant nem publicar sobre agente ambíguo; seleção não unívoca deve falhar claramente. A proibição antiga de perguntar “preparado para fechar” permanece na qualificação inicial; qualquer pergunta condicional de avanço só pode ocorrer depois de condições reais conhecidas e sem Arthur declarar fechamento.

Acceptance Criteria:
- O prompt contém todas as salvaguardas de dados/capacidade/tenant, e a frase “preparado para fechar” aparece somente dentro de uma proibição na qualificação inicial; ela não precisa estar ausente do prompt.
- Pergunta condicional de avanço, se houver, exige condições reais previamente conhecidas e não declara fechamento.

Verification:
- Teste textual procura a frase “preparado para fechar” somente dentro de uma proibição na qualificação inicial e verifica as condições/ausência de declaração de fechamento.
- Teste de publicação executa seleção ambígua e tenant cruzado esperando falha/isolamento.

### R5 — Migration e equivalência
A migration 0130 deve ser tenant-safe, idempotente e seguir versões imutáveis: localizar univocamente agente/tenant NEWAVE, aposentar a ativa, inserir nova versão e atualizar `active_version_id`. Preservar exatamente o prefixo atual e anexar apenas o novo bloco comercial, delimitado pelo marcador estável `<!-- NEWAVE_COMMERCIAL_SCRIPT_NO_FOLLOWUP_V1 -->`. O bloco carregado do source-file e o bloco dollar-quoted da migration devem ter equivalência exata ou normalizada, verificada automaticamente; revisão humana vaga não é suficiente.

Acceptance Criteria:
- O filename é exatamente `apps/backend/src/db/migrations/0130_newave_sales_script_prompt.sql`.
- Prefixo e seção 26 permanecem byte a byte; o novo bloco tem exatamente um marcador estável.
- Teste de equivalência exata ou normalizada passa entre source-file e dollar-quoted da migration.
- Publicação é idempotente, tenant-safe e atualiza a versão ativa corretamente.

Verification:
- Teste lê o arquivo exato, extrai o marcador/dollar-quote e compara automaticamente os blocos.
- Teste de banco executa publicação duas vezes e lê versão ativa, `active_version_id`, tenant e prefixo/seção 26.

### R6 — TDD e testes reais
TDD obrigatório: testes RED reais antes de alterar prompt/migration e GREEN posterior. Exigir banco real para publicação/leitura/active_version_id, idempotência, isolamento de tenant e ambiguidade, prefixo/sufixo/exclusões, equivalência source/migration, carregamento por `loadNewavePromptTemplate`, hash/bytes da seção 26 e expectativa da última migration em 0130. Mocks não podem dispensar publicação, leitura ou carregamento reais.

Acceptance Criteria:
- Os testes exigidos existem, falham antes da implementação e passam depois.
- Não há mock substituindo publicação, leitura ou carregamento reais.

Verification:
- Executar primeiro a suíte RED registrada e depois a suíte GREEN, com saídas/exit codes reais.
- Verificar cobertura dos casos listados, incluindo migração 0130 e hash da seção 26.

## Invariants
- Seção 26 e `comments.md` permanecem byte a byte intactos.
- Nenhum lembrete, follow-up, ausência, cadência ou código correspondente entra nesta mudança.
- Uma pergunta por mensagem; horários, ofertas e valores vêm de dados/capacidades reais.
- Arthur permanece SDR e não formaliza venda.
- Sem deploy e sem commit.

## Edge Cases
- Zero, uma, duas ou mais disponibilidades; disponibilidade duplicada ou inválida.
- Campos já respondidos, respostas parciais, contato não decisor e objeções combinadas.
- Dados ausentes ou não autorizados para preço, material, projeção, contrato ou implantação.
- Seleção NEWAVE ambígua, tenant inexistente e segunda execução da migration.
- Alteração concorrente em `fresh-migrations`; reler e aplicar patch mínimo.
- Qualquer diferença de bytes na seção 26 ou divergência exata/normalizada do bloco deve falhar.

## Dependencies
- `instrução-newave-ia.md`, runtime `agent_config_versions`, `loadNewavePromptTemplate`.
- Mecanismo de migrations e testes de banco descartável.
- Ferramenta real de disponibilidade/agendamento e dados oficiais comerciais.

## Affected Areas
- Prompt-fonte NEWAVE.
- `apps/backend/src/db/migrations/0130_newave_sales_script_prompt.sql`.
- `apps/backend/tests/newave-sales-script-prompt.integration.test.ts`.
- `apps/backend/tests/fresh-migrations.integration.test.ts`.

## Non-goals
Alterar `comments.md`, seção 26, módulos/worker de follow-up, migrations além da 0130 ou qualquer arquivo fora das áreas afetadas.

## Constraints
- Na finalização documental, alterar somente esta SPEC e `.hermes/state/comments-spec-loop/{progress.md,findings.md}`.
- A implementação verificada limitou-se aos quatro arquivos em Affected Areas.
- Não fazer commit/deploy; preservar mudanças concorrentes e versões imutáveis.

## Required Tests
- RED real antes e GREEN depois.
- Integração de banco: publicação, leitura ativa, `active_version_id`, idempotência, tenant e ambiguidade.
- Comparação byte/hash da seção 26 e prefixo.
- Comparação exata ou normalizada do marcador/bloco source-file versus dollar-quote.
- Carregamento por `loadNewavePromptTemplate`.
- Regras de perguntas, primeiro contato, 2/1 de agendamento e 2–3 da seção 26.
- Exclusões de follow-up/lembretes/cadência e expectativa de migration 0130.

## Definition of Done
- [x] Todos os requisitos R1–R6 e verificações passam.
- [x] SPEC revisada e estruturalmente completa.
- [x] Seção 26 e `comments.md` preservados byte a byte.
- [x] Sem alterações fora do escopo, commit ou deploy.

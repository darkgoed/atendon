# SPEC: Convite comercial humano e fluxo interno invisível

## Objective
Fazer a IA convidar para um bate-papo de 20 a 40 minutos e impedir que revele etapas internas do fluxo.

## Source
comments.md

## Current State
O prompt e validadores forçam “reunião rápida de 15 minutinhos no Google Meet”. O filtro de exposição interna cobre correções, mas aceita frases como “O próximo passo é...”.

## Desired Behavior
A IA descreve o encontro como bate-papo/conversa de 20 a 40 minutos, preserva a duração operacional interna e propõe ações sem rotulá-las como etapas de fluxo.

## Requirements
### R1 — Faixa comercial de 20 a 40 minutos
Substituir a duração comercial fixa de 15 minutos por uma faixa de 20 a 40 minutos em prompts, notas e validadores Newave.

Acceptance Criteria:
- A primeira oferta aceita linguagem natural de bate-papo/conversa e contém a faixa 20 a 40 minutos.
- Convites com 15 minutos ou com duração operacional exposta são corrigidos.
- `slotDurationMinutes` continua sendo usado somente para disponibilidade, reserva e conflitos.
- Perguntas de período identificam claramente o bate-papo no Google Meet e sua faixa comercial.

Verification:
- Testes unitários de canonicalização, contexto e correção de convite.
- Testes do template Newave.

### R2 — Não revelar o próximo passo interno
Ampliar a proteção de exposição interna no texto final.

Acceptance Criteria:
- Frases que anunciam “o próximo passo é/será/agora” ou “a próxima etapa do fluxo/processo” são rejeitadas pelo validador.
- O retorno orienta reescrita silenciosa e somente com a mensagem final ao contato.
- Convites naturais sem linguagem de processo continuam aceitos.
- A regra existe também no prompt Newave como proibição explícita.

Verification:
- Testes unitários positivos e negativos de `internalCorrectionDisclosureCorrection`.
- Teste do template Newave.

### R3 — Consistência dos caminhos irmãos
Atualizar exemplos e testes diretamente ligados à política comercial, sem alterar tempos técnicos não relacionados.

Acceptance Criteria:
- Não restam instruções ativas impondo 15 minutos ao contato nos arquivos de runtime Newave.
- Follow-up, SLA, espera e duração real de agenda não são convertidos para a faixa comercial.

Verification:
- Busca textual focada em fontes de runtime.
- Suite backend, lint, typecheck e build.

## Invariants
- Nunca expor horário final, agenda, unidade, fuso, IDs ou duração operacional.
- Não inventar disponibilidade nem confirmar agendamento sem ferramenta.
- Não alterar regras de conflito/calendário.

## Edge Cases
- Grafias “20-40”, “20 a 40” e “20–40” são equivalentes na detecção.
- Sinônimos: reunião, papo, bate-papo, conversa, call e encontro.
- Duração técnica em notas operacionais permanece numérica e interna.

## Dependencies
Nenhuma nova dependência.

## Affected Areas
- `instrução-newave-ia.md`
- `apps/backend/src/modules/messages/prefilled-context.ts`
- `apps/backend/src/modules/messages/process-message.ts`
- testes backend correlatos

## Non-goals
- Alterar duração configurada das agendas.
- Mudar o provedor/modelo de IA.
- Proibir propostas comerciais naturais.

## Constraints
Preservar regras de segurança e validação existentes; mudanças mínimas.

## Required Tests
- `prefilled-context.test.ts`
- `process-message.test.ts`
- `newave-template.test.ts`
- Suite backend, lint, typecheck e build.

## Definition of Done
- [x] R1–R3 atendidos.
- [x] Testes e validações passam.
- [x] Revisão independente aprova.

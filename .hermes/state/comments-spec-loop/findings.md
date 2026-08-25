# Findings — comments.md

Atualizado em: 2026-08-25T12:08:22Z

## Intenção coberta

1. A tela de detalhe em `/leads/[id]` exibe uma grade fixa de respostas de qualificação, inclusive muitos valores “não informado”. O pedido corrige a abordagem: a IA pode continuar persistindo dados estruturados para regras internas, filtros e auditoria, mas a interface operacional deve mostrar somente o resumo narrativo da qualificação.
2. Remover a Timeline do detalhe do lead.
3. Simplificar a visualização geral de `/leads`, sobretudo o detalhe, sem remover operações, permissões, acompanhamento, notas, status ou atribuições.
4. Trocar a oferta comercial de “reunião/chamada rápida de 15 minutos” por um convite humano para um bate-papo de 20 a 40 minutos.
5. A IA não pode revelar ao contato etapas, fluxo, política, correções ou “o próximo passo” interno. Pode propor uma ação comercial naturalmente, mas não descrevê-la como etapa do fluxo.

## Mapeamento técnico

- `apps/panel/app/leads/[id]/page.tsx`: renderiza qualificação (`resumo`, `justificativa`, `respostas`) e Timeline (`eventos`). A simplificação deve remover justificativa/respostas/timeline da renderização e os tipos/imports mortos, preservando resumo, estrelas, situação e metadados úteis.
- `apps/panel/app/leads/page.tsx`: já usa apenas o resumo em uma linha truncada; não há respostas estruturadas nem Timeline na listagem.
- `apps/panel/tests/comments-ui-regression.test.ts`: local adequado para regressões de estrutura da tela de leads.
- `instrução-newave-ia.md`: prompt principal Newave, com várias regras e exemplos fixados em 15 minutos e linguagem de processo.
- `apps/backend/src/modules/messages/prefilled-context.ts`: normaliza a duração comercial, injeta contexto operacional e valida convites/perguntas de período. Hoje força 15 minutos em todos esses caminhos.
- `apps/backend/src/modules/messages/process-message.ts`: `internalCorrectionDisclosureCorrection` já impede parte das exposições internas; precisa cobrir anúncios explícitos de “próximo passo/etapa/fluxo”. O validador é usado no fluxo principal e na recuperação compacta.
- `apps/backend/tests/prefilled-context.test.ts`, `apps/backend/tests/process-message.test.ts`, `apps/backend/tests/newave-template.test.ts`: testes diretamente afetados.

## Invariantes e riscos

- Não remover colunas/API de qualificação: respostas estruturadas ainda alimentam filtros, decisão humana e regras internas; o pedido é de apresentação.
- Não remover eventos do backend nem afetar auditoria; apenas não renderizar a Timeline em `/leads/[id]`.
- Duração operacional das agendas (`slotDurationMinutes`) continua interna e intacta para disponibilidade/conflitos.
- Convites devem aceitar variantes naturais de “bate-papo/conversa” e a faixa 20–40, rejeitando 15 ou duração operacional exposta.
- Menções legítimas como “o próximo passo depende de você” também soam processuais; o filtro será intencionalmente estrito quando a IA anunciar “o próximo passo é/será/agora”. Propostas naturais como “podemos conversar amanhã” permanecem permitidas.
- Há mudanças preexistentes do usuário no worktree; limitar alterações aos arquivos acima e aos artefatos de SPEC/estado.

## Ambiguidades resolvidas pelo código

- “Somente resumo” é tratado como simplificação visual, não como migração destrutiva de dados.
- “Nunca falar qual seu próximo passo do fluxo” não proíbe convidar/agendar; proíbe revelar a mecânica interna ou rotular a ação como passo/etapa do fluxo.

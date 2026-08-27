# SPEC: Agenda mensal, slots fixos e bloqueios recorrentes

## Objective
Estender a agenda existente para visão mensal, grid de slots clicável e layout fixo/responsivo sem scroll horizontal; permitir que cada slot ofereça “Adicionar lead” ou “Bloquear horário”; e suportar bloqueios pessoais recorrentes por dias da semana, com motivo obrigatório, preservando isolamento por workspace/tenant.

## Source
comments.md

Item da linha 9. Embora o comentário mencione `design_handoff_b2b2`, a única referência válida é `design_handoff_b2b/CRM Atendimento IA.dc.html`.

## Current State
- `apps/panel/app/agenda/page.tsx` usa `useAgendaData`, `AgendaCalendar`, `AgendaCreateDialog` e `AgendaTimeBlockDialog`; os modos são apenas `day` e `week`, com `days` contendo 1 ou 7 dias (`apps/panel/app/agenda/use-agenda-data.ts:21-52`). A consulta de appointments rejeita períodos acima de 32 dias (`apps/backend/src/modules/scheduling/routes.ts:478-518`).
- `apps/panel/app/agenda/agenda-header.tsx` expõe somente os toggles day/week. `agenda-calendar.tsx` renderiza o grid semanal/diário; `page.tsx:143-145` o envolve em `.agenda-scroll`.
- O grid atual já tem base útil: `apps/panel/app/globals.css:1351-1384` define `56px` para coluna de horário, `minmax(132px,1fr)` por coluna, cabeçalho de `44px`, linhas de `60px`, bordas suaves, coluna/linha sticky e células clicáveis.
- Bloqueio atual é somente pontual e do próprio atendente: `apps/panel/app/agenda/agenda-time-blocks.tsx:11-86` envia POST para `/scheduling/attendants/me/time-blocks`; o motivo é opcional (`Motivo (opcional)`). A listagem/deleção ocorre em `page.tsx:90-105` e `agenda-time-blocks.tsx:89-109`.
- A migration real `apps/backend/src/db/migrations/0119_attendant_time_blocks.sql` cria `scheduling_attendant_time_blocks` com `tenant_id`, `member_id`, `start_at`, `end_at`, `reason`, FK composta do membro ao workspace, intervalo válido e razão opcional de até 500 caracteres.
- Rotas existentes para bloqueios estão em `apps/backend/src/modules/scheduling/routes.ts:901-929`; queries/serviço em `apps/backend/src/modules/scheduling/service.ts:972-1066`. O endpoint de appointments filtra `tenant_id`, `unit_id` e escopo do membro (`routes.ts:497-516`). Disponibilidade é carregada dia a dia por `useAgendaData.ts:81-100`.
- `ConversationScheduler` (`apps/panel/components/conversation-scheduler.tsx:145-236`) agenda um lead a partir de uma conversa via `/scheduling/availability` e POST `/scheduling/appointments`; não deve perder esse fluxo.
- Referência visual: `design_handoff_b2b/CRM Atendimento IA.dc.html:14-35,330-425`. Usa Manrope 400/500/600/700 e IBM Plex Mono 400/500; `body` sem scroll global (`height:100%`, `overflow:hidden`). Agenda tem header de `48px`, toolbar de `44px`, coluna de horário de `56px`, colunas com `min-width:132px`, linhas de `60px`, padding de célula `3px 4px`, evento `padding:5px 7px`, raio `7px`; painel lateral fixo de `296px` (`:428`). Paleta real: `--bg #F7F7F5`, `--surface #FFFFFF`, `--surface-2 #FBFBF9`, `--surface-3 #F4F4EE`, `--hover #F0F0EA`, `--border #E6E6E0`, `--border-2 #EFEFE9`, `--border-3 #E0E0D9`, `--text #1A1A18`, `--text-5 #6B6B64`, `--text-8 #A3A39A`, `--primary #0E7490`, `--primary-hover #0B5C73`, `--primary-tint-bg #E3F8FB`, `--primary-tint-border #B9EAF2`, hoje `#F7F8F6/#FDFDFC`, alerta/linha “agora” `#B54708`. Categorias demonstradas: demo `#EEF1F7/#D2DAEA`, follow-up `#FAF6EE/#E9DEC8`; bloqueios usam listras.

## Desired Behavior
A agenda mantém dia e semana, acrescenta mês. Em mês, mostra todos os dias do mês em células compactas com resumo; selecionar um dia abre/mostra seu grid de slots sem exigir scroll horizontal. O grid de slots usa a linguagem visual do handoff e permite clicar em qualquer slot livre/fechado. O clique abre uma ação contextual com “Adicionar lead” e “Bloquear horário”. Bloqueios podem ser únicos ou recorrentes (dias da semana + horário local + data inicial/final opcional); toda gravação exige motivo não vazio.

## Requirements
### R1
Adicionar modo de visualização mensal sem quebrar day/week.

Acceptance Criteria:
- O controle da agenda oferece exatamente `Dia`, `Semana` e `Mês`, com estado acessível e URL/deep-link preservando modo e data.
- Mês calcula corretamente primeiro/último dia exibido, inclusive fevereiro/virada de ano, usando timezone do workspace.
- A consulta mensal nunca excede o limite atual de 32 dias; para mês com 28–31 dias é feita uma única faixa válida e appointments permanecem filtrados por tenant/unidade/escopo.

Verification:
- Testes unitários cobrem mês de 28, 29, 30 e 31 dias, virada de ano e timezone DST.
- Teste de integração verifica que `GET /scheduling/appointments` aceita a faixa mensal válida e rejeita faixa >32 dias.

### R2
Tornar a agenda fixa na largura disponível e eliminar scroll horizontal da página.

Acceptance Criteria:
- `html/body/Shell` continuam sem overflow horizontal; a agenda ocupa `width:100%`, `min-width:0` e o grid usa colunas que encolhem para a viewport.
- Em desktop, sete colunas semanais e coluna de `56px` cabem no viewport restante; em telas estreitas, dias são empilhados/convertidos em seleção de dia ou outro layout vertical, nunca criando scrollbar horizontal.
- O painel de detalhe, quando aberto, continua limitado a `296px` no desktop e torna-se fluxo vertical no mobile.

Verification:
- Testes/QA em viewport 1440, 1024, 768 e 390px confirmam `document.documentElement.scrollWidth <= clientWidth` e ausência de scrollbar horizontal.

### R3
Implementar grid de slots no estilo do handoff.

Acceptance Criteria:
- Grade usa coluna temporal de `56px`, cabeçalho `44px`, slot/linha base de `60px`, bordas `#E6E6E0/#EFEFE9`, hora em IBM Plex Mono `10px`, dia em Manrope `10.5px` uppercase e data IBM Plex Mono `13px`.
- Slots mostram disponibilidade, appointment e bloqueio; bloqueio usa fundo listrado equivalente a `repeating-linear-gradient(45deg, var(--surface-3) 0 5px, var(--border-2) 5px 6px, var(--surface-3) 6px 10px)`.
- Eventos conservam padding `5px 7px`, raio `7px`, barra lateral de categoria/responsável e cores soft do handoff; linha “agora” é `#B54708` com marcador circular de `6–7px`.
- O mês mantém o resumo diário/capacidade e clique conduz ao grid daquele dia.

Verification:
- Teste visual/componente compara classes e computed styles contra os valores acima; teste de acessibilidade confirma nomes de dia, hora e estado.

### R4
Oferecer ação contextual ao clicar em qualquer slot.

Acceptance Criteria:
- Clique/Enter/Space em slot abre modal acessível com as opções textuais exatas `Adicionar lead` e `Bloquear horário`, além de cancelar/fechar.
- `Adicionar lead` reutiliza `AgendaCreateDialog`/fluxo de `/scheduling/appointment-leads` e POST `/scheduling/appointments`, mantendo permissões e idempotência.
- `Bloquear horário` pré-preenche data/hora do slot e permite selecionar bloqueio único ou recorrente.
- Slot ocupado/bloqueado não permite criar appointment sem confirmação explícita; backend sempre revalida conflito.

Verification:
- Testes de componente cobrem mouse, teclado, foco preso no modal e ambas as ações.
- Integração valida que usuário sem `appointments.create` não vê/usa adicionar lead e que POST conflitante retorna erro sem alterar dados.

### R5
Persistir bloqueio único e recorrente com motivo obrigatório.

Acceptance Criteria:
- Criar migration seguindo `apps/backend/src/db/migrations/0119_attendant_time_blocks.sql`, adicionando tabela (ou extensão explicitamente justificada) para regra recorrente com: `id UUID`, `tenant_id`, `member_id`, `start_local_time`, `end_local_time`, `weekdays` (1–7), `starts_on`, `ends_on` nullable, `timezone`, `reason NOT NULL`, auditoria e `active`; CHECK de intervalo, weekdays não vazio, motivo trimado com 1–500 caracteres e FK composta tenant/membro.
- Exemplo “12h todos os dias” grava `start_local_time=12:00`, `end_local_time=13:00`, weekdays `[1,2,3,4,5,6,7]`, timezone do workspace e motivo obrigatório.
- API expõe criação, listagem no intervalo, atualização/ativação e deleção de regra; respostas expandem ocorrências dentro da faixa solicitada para o grid sem gravar cópias.
- Campo de motivo é `required`, valida trim no frontend e backend; string vazia, whitespace ou >500 retorna HTTP 400.
- Bloqueios pontuais existentes continuam compatíveis; motivo opcional legado deve ser tratado por uma migration de backfill/validação somente para novos registros, sem apagar histórico.

Verification:
- Testes de API cobrem regra diária, seleção parcial de weekdays, limites de datas, DST, motivo inválido, deleção e expansão de ocorrências.
- Teste SQL/integração tenta acessar regra de outro tenant com mesmo `member_id`/id e confirma 404/nenhuma linha retornada.

### R6
Aplicar bloqueios à disponibilidade e aos appointments.

Acceptance Criteria:
- `verificarHorarios`/serviço de disponibilidade exclui ocorrências pontuais e recorrentes sobrepostas ao slot solicitado.
- Criação e reagendamento fazem verificação transacional de sobreposição com bloqueios, além da disponibilidade existente; corrida concorrente não permite appointment sobre bloqueio.
- Listagem da agenda retorna bloqueios suficientemente identificados (motivo, origem única/recorrente e regra) para renderização e gerenciamento.

Verification:
- Testes concorrentes/transactionais cobrem appointment criado simultaneamente com bloqueio.
- Testes de serviço confirmam bloqueio cruzando meia hora, mudança de timezone e ocorrência no limite final.

### R7
Aproximar fielmente o visual do handoff sem introduzir dependência visual paralela.

Acceptance Criteria:
- Reutilizar tokens/classes existentes em `apps/panel/app/globals.css`; fonte é Manrope para UI e IBM Plex Mono para horas/datas, com fallback sans/monospace.
- Header/toolbar seguem dimensões `48px/44px`, controles com altura aproximada `26–28px`, gaps/padding do handoff e paleta real listada em Current State.
- Legenda distingue Reunião, Demo, Follow-up e Bloqueio; estados today/hover/closed usam os tokens reais.
- Não copiar a implementação fictícia `sc-for` do handoff; adaptar para componentes React/Tailwind existentes.

Verification:
- Checklist visual em screenshot compara header, grid, tipografia, cores, espaçamentos e painel em desktop/mobile.
- `npm run lint`, `npm run typecheck` e `npm run build` passam após implementação.

## Invariants
- Todo SELECT/INSERT/UPDATE/DELETE de appointment, bloqueio e regra recorrente inclui `tenant_id` da sessão; nunca aceitar tenant vindo do cliente.
- Membro/unidade/lead devem pertencer ao mesmo workspace; escopo `mine` continua limitando membro.
- Permissões existentes (`appointments.read/create/reschedule` e equivalente de gerenciamento) são revalidadas no backend.
- Timezone do workspace é a fonte para horário local; persistência de eventos pontuais continua em `TIMESTAMPTZ`.
- Migração é aditiva, reversível quando possível e mantém histórico de bloqueios.

## Edge Cases
- Mês iniciado/finalizado no meio da semana; fevereiro bissexto; DST que remove ou repete 12:00.
- Regra sem `ends_on`, ends_on anterior a starts_on, weekdays duplicados/fora de 1–7, intervalo de zero duração.
- Regra recorrente sobrepõe appointment já existente: impedir novo bloqueio destrutivo ou retornar conflito explícito; nunca cancelar appointment silenciosamente.
- Dois bloqueios recorrentes sobrepostos, bloqueio pontual dentro de recorrente e slot parcialmente ocupado.
- Membro removido, tenant desativado, unidade sem disponibilidade, mês sem appointments, carregamento parcial e erro de rede.
- Mobile/zoom/fontes longas: nomes e motivos devem truncar sem alterar largura do grid.

## Dependencies
- Banco PostgreSQL e runner de migrations de `apps/backend/src/db/migrations/`.
- Serviços/rotas de scheduling (`apps/backend/src/modules/scheduling/routes.ts` e `service.ts`).
- Componentes agenda em `apps/panel/app/agenda/`, `apps/panel/app/globals.css`, `ModalDialog` e `api`.
- Modelo de permissões e timezone workspace; nenhuma dependência no diretório inexistente `design_handoff_b2b2`.

## Affected Areas
- Frontend: `apps/panel/app/agenda/page.tsx`, `use-agenda-data.ts`, `agenda-header.tsx`, `agenda-calendar.tsx`, `agenda-time-blocks.tsx`, `agenda-types.ts`, `agenda-utils.ts`, `apps/panel/app/globals.css`.
- Backend: `apps/backend/src/modules/scheduling/routes.ts`, `service.ts` e tipos/validadores associados.
- Banco: nova migration após `0119_attendant_time_blocks.sql` para regra recorrente e índices tenant/member/date.
- Testes correspondentes de backend, frontend e integração/QA visual.

## Non-goals
- Não implementar agora (esta SPEC é apenas investigação/especificação).
- Não alterar `ConversationScheduler` além de compatibilidade/reuso necessário.
- Não substituir appointments existentes por outro domínio, não criar cópias infinitas de ocorrências recorrentes e não criar calendário Google novo.
- Não alterar outras linhas do `comments.md`.

## Constraints
- Seguir CLAUDE.md: validar fronteiras, manter arquivos abaixo de 500 linhas quando possível, não criar segredos e usar padrões existentes.
- Comandos de validação do repositório: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- A largura fixa significa layout contido no viewport, não `min-width` que force overflow; rolagem vertical é permitida para conteúdo de slots.

## Required Tests
- Unitários de cálculo de período mensal, slots, timezone/DST, expansão de recorrência e validação de motivo.
- Backend: rotas CRUD, autorização, tenant isolation, conflito transacional, limite de 32 dias e compatibilidade de bloqueio legado.
- Frontend: renderização day/week/month, clique/teclado no slot, modal Add/Block, motivo obrigatório, estados loading/error/empty e responsividade.
- E2E/QA: criar lead no slot, criar bloqueio único, criar “12:00–13:00 todos os dias”, visualizar mês, excluir/desativar regra e verificar ausência de scroll horizontal.
- Rodar `npm test`, `npm run lint`, `npm run typecheck` e `npm run build` no final.

## Definition of Done
- [ ] Visão Dia/Semana/Mês implementada e preserva timezone, permissões e deep-links.
- [ ] Agenda não produz scroll horizontal em desktop, tablet ou mobile.
- [ ] Grid de slots reproduz dimensões, fontes, tokens e cores reais do handoff.
- [ ] Clique/teclado em slot oferece `Adicionar lead` e `Bloquear horário`.
- [ ] Bloqueio único e recorrente são persistidos, listados, expandidos e aplicados à disponibilidade.
- [ ] Motivo é obrigatório para todo novo bloqueio e validado no backend.
- [ ] Migration, índices, FKs e consultas garantem isolamento por `tenant_id`/workspace.
- [ ] Conflitos concorrentes não criam appointment em horário bloqueado.
- [ ] Testes unitários, integração, frontend/E2E e quatro comandos npm passam.
- [ ] Revisão visual e de acessibilidade aprova estados, foco, legendas e responsividade.
